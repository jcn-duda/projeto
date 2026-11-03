//! Vaca no raspador: os botões não estão na página da fila.
//!
//! Medido em 2026-11-02 em `vaqueirofilmes.com`: o post só tem o card "N links
//! disponíveis" para `/movie-links/<id>/` (filme) ou o `data-u` para
//! `/season-internal/` e os cards da temporada (série). O botão é
//! `<site>/enc/go.php`, e a cadeia `go.php → processar.php → t.co → relay.php →
//! enc1/receber.php → artigo de fachada → enc2/receber.php` entrega o magnet em
//! `data-link`. Ler só o post fechava o acervo inteiro como `no-torrent`.
//!
//! A cadeia roda DIRETA com o `cf_clearance` da sessão do solver (8 saltos em
//! ~1,3 s, contra ~11 s por página no solver), e o solver só entra se a sessão
//! venceu. Não usa o `/resolve` da porta 8704 porque o id do botão muda a cada
//! leitura: o resolver releria a página e não acharia o botão desta.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::{CrawlPageEngine, ACCEPT_PAGE};
use crate::br_core::magnet::{self, is_valid_magnet_uri};
use crate::br_core::vaca_protector::next_protected_url;
use crate::page_parser::{self, CrawlPageParsed};
use crate::profile_parsers::{
    b64_data_link_is_http, extract_batch_title, extract_movie_links, filter_season_cards,
    parse_season_internal, series_season_internal_url, try_parse_download_links, ResolverLink,
    VacaParseOptions,
};
use crate::protector::{self, FollowHooks, FollowOptions, ProtectorError};
use crate::site_profiles::{self, SiteNetworkConfig};
use crate::store::ops::UrlRow;
use crate::{declared_series_location, season_from_card_slug, LinkEvidence};

/// Saltos medidos da cadeia: é o custo real de um botão no teto por hora.
const BUTTON_COST: u32 = 8;
/// Intervalo entre cadeias: o site devolve 429 (`Retry-After: 3`) com 3 s de folga
/// e aceitou tudo com 8 s (medido em 2026-11-02). Cadeia é rajada de 8 saltos.
const CHAIN_GAP: Duration = Duration::from_secs(8);
/// Teto de botões por página: o passo da faixa Flare tem prazo, e série longa
/// sem sessão quente pagaria o solver por botão.
const MAX_BUTTONS: usize = 120;
/// Marca do tema na página de links do filme. Sem ela não é a página esperada.
const LINKS_PAGE_MARK: &str = "ml-links-box";
const LINKS_DOWNLOAD_GROUP: &str = "ml-group-label\">Download";
/// Marca do post: sem hop E sem ela, o layout mudou (não é "sem torrent").
const POST_MARK: &str = "streaming-container";

/// Desfecho de um botão na cadeia.
#[derive(Debug, PartialEq)]
enum ButtonEnd {
    Magnet(String),
    /// O botão existe e não tem torrent (expirado, ou leva ao Drive).
    Empty,
    /// A cadeia acabou sem magnet: sinal de layout, não de ausência.
    Lost,
}

/// Erro da cadeia → desfecho, ou o motivo para a página voltar à fila.
fn button_end(error: ProtectorError) -> Result<ButtonEnd, String> {
    match error {
        ProtectorError::LinkExpired | ProtectorError::NonMagnet => Ok(ButtonEnd::Empty),
        ProtectorError::NoMagnet => Ok(ButtonEnd::Lost),
        // Rótulo do adiamento: a página volta sem gastar `tries` e o site espera.
        ProtectorError::HttpError(status @ (429 | 503)) => Err(format!("http_{status}")),
        other => Err(format!("protetor: {other}")),
    }
}

/// Fecha os botões seguidos. "Nada reconhecido" é falha: botões que perderam o
/// magnet sem nenhum acerto não podem virar `no-torrent`.
fn settle_buttons(
    mut links: Vec<ResolverLink>,
    ends: Vec<ButtonEnd>,
) -> Result<Vec<ResolverLink>, String> {
    let lost = ends.contains(&ButtonEnd::Lost);
    let mut out = Vec::new();
    for (mut link, end) in links.drain(..).zip(ends) {
        if let ButtonEnd::Magnet(magnet) = end {
            link.url = magnet;
            out.push(link);
        }
    }
    if out.is_empty() && lost {
        return Err("layout: cadeia do botão terminou sem magnet".to_string());
    }
    Ok(out)
}

/// Só o `cf_clearance`: o jar lê UM par por entrada, e os cookies de anúncio da
/// sessão não fazem falta à cadeia.
fn clearance_of(cookies: &str) -> Option<String> {
    cookies
        .split(';')
        .map(str::trim)
        .find(|c| c.starts_with("cf_clearance="))
        .map(str::to_string)
}

/// Corte dos botões com o total visto: capturar ANTES do `take` é a única
/// evidência de quanto a página passou do teto (Fase 1.3).
fn take_buttons(links: Vec<ResolverLink>) -> (Vec<ResolverLink>, usize) {
    let total = links.len();
    (links.into_iter().take(MAX_BUTTONS).collect(), total)
}

/// Marcador do corte no formato do `progress` do `CrawlWorkResult` (Fase 1.3).
/// Chaves auto-descritivas de propósito: o `SeriesWorkProgress` do Mico
/// (`doneCards`/`totalCards`) é outro shape e nada aqui deve fingir ser ele.
/// SEM uso em produção ainda: a ponte de `to_work` (page_engine.rs) não
/// propaga `progress` — quando propagar, este é o corpo gravado no `crawl.db`.
#[allow(dead_code)]
fn clipped_progress(total: usize, seen: usize) -> String {
    json!({"buttonsClipped": total, "buttonsSeen": seen}).to_string()
}

/// Telemetria do corte (Fase 1.3): a medição real acontece no Docker; o log é
/// o registro.
fn clip_message(total: usize) -> String {
    format!("{total} botões, cortado em {MAX_BUTTONS}")
}

/// Telemetria da página que fecha `done` magro (Fase 1.2): com séries cortadas
/// pelo teto de botões no acervo, `releases=1` pode ser característica do site
/// ou perda — o dado do log é o que separa os casos.
fn scarce_message(buttons: usize, releases: usize) -> String {
    format!("done com {releases} release(s), {buttons} botão(ões)")
}

impl CrawlPageEngine {
    /// Página do Vaca inteira: post → página(s) de botões → magnet de cada botão.
    pub(super) async fn vaca_page(
        &self,
        row: &UrlRow,
        profile: &SiteNetworkConfig,
        post: &str,
        cost: &Arc<AtomicU32>,
    ) -> Result<CrawlPageParsed, String> {
        let is_series = row.kind == "tv_show" || row.kind == "series";
        let links = if is_series {
            self.vaca_series_links(row, profile, post, cost).await?
        } else {
            self.vaca_movie_links(row, profile, post, cost).await?
        };
        let mut ends = Vec::new();
        // Total ANTES do corte: séries longas passam dos 120 botões e o `done`
        // parcial não pode ficar invisível (Fase 1.3). O desfecho `Partial`
        // da página clipped depende da ponte de `to_work` (page_engine.rs),
        // que ainda não propaga progresso — hoje o corte sobe como telemetria
        // e segue preservando os botões vistos.
        let (links, total) = take_buttons(links);
        if total > MAX_BUTTONS {
            eprintln!("[vaca] {}: {}", row.url_key, clip_message(total));
        }
        for link in &links {
            if is_valid_magnet_uri(&link.url) {
                ends.push(ButtonEnd::Magnet(link.url.clone()));
                continue;
            }
            tokio::time::sleep(CHAIN_GAP).await;
            cost.fetch_add(BUTTON_COST, Ordering::SeqCst);
            ends.push(self.vaca_follow(&link.url, &row.url, profile, cost).await?);
        }
        let found = settle_buttons(links, ends)?;
        let parsed = page_parser::parse_vaca_followed(&row.kind, &row.url, post, &found);
        // Fase 1.2: `done` magro é o sintoma que separa característica do site
        // de perda de botões. Não muda o desfecho — só deixa o dado no log. O
        // critério de contagem é o mesmo do `counted_releases` do motor (o
        // número que o painel exibe).
        let releases = parsed.releases.len()
            + parsed
                .groups
                .iter()
                .map(|g| g.releases.len())
                .sum::<usize>();
        if parsed.status == "done" && releases <= 1 {
            eprintln!(
                "[vaca] {}: {}",
                row.url_key,
                scarce_message(total, releases)
            );
        }
        Ok(parsed)
    }

    async fn vaca_movie_links(
        &self,
        row: &UrlRow,
        profile: &SiteNetworkConfig,
        post: &str,
        cost: &Arc<AtomicU32>,
    ) -> Result<Vec<ResolverLink>, String> {
        let Some(url) = extract_movie_links(post, Some(&row.url)) else {
            return no_hop(post);
        };
        let html = self.fetch_page(&url, profile, ACCEPT_PAGE, cost).await?;
        if !html.contains(LINKS_PAGE_MARK) {
            return Err("layout: página de links sem a lista de botões".to_string());
        }
        let links = try_parse_download_links(&html, Some(&url), None, None)?;
        // Só "Veja Online" é obra sem torrent; grupo Download sem botão é régua
        // desatualizada e não pode fechar a página.
        if links.is_empty() && html.contains(LINKS_DOWNLOAD_GROUP) {
            return Err("layout: grupo Download sem botão reconhecido".to_string());
        }
        Ok(links)
    }

    async fn vaca_series_links(
        &self,
        row: &UrlRow,
        profile: &SiteNetworkConfig,
        post: &str,
        cost: &Arc<AtomicU32>,
    ) -> Result<Vec<ResolverLink>, String> {
        let Some(url) = series_season_internal_url(post, Some(&row.url)) else {
            return no_hop(post);
        };
        let internal = self.fetch_page(&url, profile, ACCEPT_PAGE, cost).await?;
        let cards = filter_season_cards(&parse_season_internal(&internal, Some(&url)), None);
        if cards.is_empty() {
            return Err("layout: season-internal sem cards de temporada".to_string());
        }
        let mut out = Vec::new();
        for card in cards {
            // Card que falha volta a página inteira à fila: `done` parcial nunca
            // seria relido e a temporada ficaria faltando em silêncio.
            let html = self
                .fetch_page(&card.url, profile, ACCEPT_PAGE, cost)
                .await?;
            let card_season = card
                .season
                .map(i64::from)
                .or_else(|| season_from_card_slug(&card.url));
            let batch_title = card.is_batch.then(|| extract_batch_title(&html)).flatten();
            let opts = VacaParseOptions {
                season: card_season.and_then(|s| u32::try_from(s).ok()),
                real_title: batch_title.clone(),
            };
            for mut link in try_parse_download_links(&html, Some(&card.url), None, Some(&opts))? {
                let location = declared_series_location(&LinkEvidence {
                    card_season,
                    card_title: card.title.clone(),
                    is_batch: card.is_batch,
                    real_title: batch_title.clone(),
                    dn: None,
                    link_episode: link.episode.map(i64::from),
                });
                link.season = location.season.and_then(|s| u32::try_from(s).ok());
                link.episode = location.episode.and_then(|e| u32::try_from(e).ok());
                out.push(link);
            }
        }
        Ok(out)
    }

    /// Cadeia de UM botão. 403/503 é sessão fria: uma resolução e nova tentativa.
    /// 429 é ritmo: espera o intervalo e tenta uma vez antes de devolver a página.
    async fn vaca_follow(
        &self,
        url: &str,
        post_url: &str,
        profile: &SiteNetworkConfig,
        cost: &Arc<AtomicU32>,
    ) -> Result<ButtonEnd, String> {
        match self.vaca_chain(url, post_url, profile).await {
            Ok(magnet) => Ok(ButtonEnd::Magnet(magnet)),
            Err(ProtectorError::HttpError(403 | 503)) => {
                self.escalate_via_flare(url, cost).await?;
                match self.vaca_chain(url, post_url, profile).await {
                    Ok(magnet) => Ok(ButtonEnd::Magnet(magnet)),
                    Err(e) => button_end(e),
                }
            }
            Err(ProtectorError::HttpError(429)) => {
                tokio::time::sleep(CHAIN_GAP).await;
                match self.vaca_chain(url, post_url, profile).await {
                    Ok(magnet) => Ok(ButtonEnd::Magnet(magnet)),
                    Err(e) => button_end(e),
                }
            }
            Err(e) => button_end(e),
        }
    }

    async fn vaca_chain(
        &self,
        url: &str,
        post_url: &str,
        profile: &SiteNetworkConfig,
    ) -> Result<String, ProtectorError> {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_lowercase))
            .unwrap_or_default();
        // O clearance só vale com o User-Agent que o resolveu.
        let session = self.sessions.lock().ok().and_then(|sessions| {
            sessions
                .get(&host)
                .map(|s| (s.cookies.clone(), s.user_agent.clone()))
        });
        let user_agent = session
            .as_ref()
            .map_or(profile.user_agent.clone(), |(_, ua)| ua.clone());
        let seed = session
            .and_then(|(cookies, _)| clearance_of(&cookies))
            .map(|cookie| HashMap::from([(host, cookie)]));
        let allowlist = site_profiles::resolve_allowlist(profile);
        let allow = |u: &str| {
            allowlist
                .assert_allowed_url(u)
                .map(|_| ())
                .map_err(|e| e.to_string())
        };
        let extract = |html: &str| magnet::VACA.extract(html);
        let client = protector::build_protector_client()
            .map_err(|e| ProtectorError::Network(e.to_string()))?;
        protector::follow_protected_url(FollowOptions {
            url,
            referer: Some(post_url),
            protector_hosts: &profile.protector_suffixes,
            suffixes: &profile.protector_suffixes,
            max_hops: profile.max_hops,
            timeout: Duration::from_millis(profile.timeout_ms),
            user_agent: &user_agent,
            client: &client,
            hooks: FollowHooks {
                assert_allowed: Some(&allow),
                extract_magnet: Some(&extract),
                next_url: Some(&next_protected_url),
                non_magnet: Some(&b64_data_link_is_http),
                cookie_jar: true,
                seed_cookies: seed,
            },
        })
        .await
    }
}

/// Post sem caminho para os botões: só-streaming se ainda tem a marca do tema;
/// sem ela o layout mudou, e isso é falha, nunca "sem torrent".
fn no_hop(post: &str) -> Result<Vec<ResolverLink>, String> {
    if post.contains(POST_MARK) {
        Ok(Vec::new())
    } else {
        Err("layout: post sem caminho para os botões".to_string())
    }
}

#[cfg(test)]
#[path = "page_engine_vaca_tests.rs"]
mod tests;
