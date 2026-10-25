//! Descoberta nativa por LISTAGEM paginada (fase 6, trilha de listing).
//!
//! Porte do `discover()` de `hdrtorrents.ts` e `apachetorrent.ts`. Esses dois
//! sites NÃO publicam sitemap de obra: a fila deles sai de uma janela
//! deslizante (`/`, `/pagina/2/`, …), e o fim do acervo é um FATO OBSERVADO —
//! página calcanhar por contagem de cards brutos.
//!
//! Este módulo é a costura: lê o estado durável, resolve o portão de séries,
//! monta o leitor do site, chama a caminhada ([`walk_listing`]) e devolve o
//! relatório no MESMO contrato do sitemap — com uma diferença: o cursor de
//! listagem NÃO cabe em `next_cursor` (ele corta por posição e âncora, não por
//! data), então ele viaja em `state_writes` e o motor grava depois de a fila
//! aceitar as URLs.
//!
//! Duas regras herdadas que doem se esquecidas:
//!
//! - **A listagem é MISTA** (card de filme e de série na mesma página). Com
//!   séries desligadas as URLs `tv_show` são lidas e DESCARTADAS, e por isso
//!   `complete_tv_show` sai `false` — afirmação honesta, e o marcador de
//!   séries ([`series`]) é o que faz a inversão do portão recomeçar a varredura
//!   em vez de pular o acervo descartado.
//! - **`urls: []` com `complete: true` só sai quando a caminhada PROVOU a
//!   cobertura** (âncora achada no incremental ou fim declarado). Página sem
//!   card reconhecido é falha, nunca vazio completo.

pub mod config;
pub mod reader;
pub mod series;

use std::sync::Arc;
use std::time::Duration;

use tokio::time::timeout;

use crate::discovery::fetch::SitemapFetch;
use crate::discovery::types::{DiscoveryOptions, DiscoveryReport};
use crate::listing::cursor::{
    decode_listing_cursor, encode_listing_cursor, listing_cursor_key, start_listing_cursor,
};
use crate::listing::walk::{walk_listing, ListingWalkInput};
use crate::site_profiles;
use crate::sitemap::CrawlPageKind;

pub use config::{listing_config, listing_sites, ListingDiscoveryConfig, ListingFlavor};
pub use reader::{page_url, SiteListingReader, ACCEPT_LISTING};
pub use series::{listing_series_key, load_with_gate, marker_of, GateLoad, LISTING_SERIES_SUFFIX};

/// Kind que identifica a LISTAGEM no cursor (a página é mista; o tipo de cada
/// URL vem do card). Não troque por `tv_show`: partiria a mesma listagem em dois
/// cursores, cada um lendo o acervo inteiro por conta própria.
const LISTING_KIND: CrawlPageKind = CrawlPageKind::Movie;

/// Descoberta por listagem: um fetcher e o prazo da rodada.
pub struct ListingDiscovery {
    fetcher: Arc<dyn SitemapFetch>,
    deadline: Duration,
}

impl ListingDiscovery {
    pub fn new(fetcher: Arc<dyn SitemapFetch>, deadline: Duration) -> Self {
        Self { fetcher, deadline }
    }

    /// Chaves de `crawl_state` que a rodada do site precisa ler antes de rodar.
    /// O motor lê estas e passa os valores em `opts.site_state`.
    pub fn state_keys(&self, site: &str) -> Vec<String> {
        let Some(cfg) = listing_config(site) else {
            return Vec::new();
        };
        vec![
            listing_cursor_key(LISTING_KIND, cfg.page_path),
            listing_series_key(LISTING_KIND, cfg.page_path),
        ]
    }

    /// UMA rodada. `Err` = nenhuma fonte utilizável (o motor agenda retry
    /// curto); falha de página viaja em `failures` e derruba a completude.
    pub async fn discover(
        &self,
        site: &str,
        opts: &DiscoveryOptions,
    ) -> Result<DiscoveryReport, String> {
        let Some(cfg) = listing_config(site) else {
            return Err(format!("{site}: site sem descoberta de listagem"));
        };
        match timeout(self.deadline, self.run(cfg, site, opts)).await {
            Ok(result) => result,
            Err(_) => Err(format!(
                "{site}: descoberta por listagem estourou o prazo de {}ms",
                self.deadline.as_millis()
            )),
        }
    }

    async fn run(
        &self,
        cfg: &ListingDiscoveryConfig,
        site: &str,
        opts: &DiscoveryOptions,
    ) -> Result<DiscoveryReport, String> {
        let profile = site_profiles::site_network_config(site)
            .ok_or_else(|| format!("{site}: site sem perfil de rede"))?;
        if profile.candidate_hosts.is_empty() {
            return Err(format!("{site}: perfil de rede sem host candidato"));
        }
        let bases: Vec<String> = profile
            .candidate_hosts
            .iter()
            .map(|host| format!("https://{host}"))
            .collect();
        let allow = site_profiles::resolve_allowlist(profile);

        let cursor_key = listing_cursor_key(LISTING_KIND, cfg.page_path);
        let marker_key = listing_series_key(LISTING_KIND, cfg.page_path);
        let stored = opts.state(&cursor_key).and_then(decode_listing_cursor);
        let gate = load_with_gate(stored, opts.state(&marker_key), opts.emit_series);

        let mut state_writes: Vec<(String, String)> = Vec::new();
        if gate.clear {
            // Cursor de outra varredura (portão ou régua de fim diferentes):
            // recomeçar da página 1 é o lado barato e recupera o que a rodada
            // anterior leu e descartou.
            eprintln!(
                "[crawl] {site}: cursor da listagem descartado (portão/régua mudou) — \
                 a varredura recomeça da página 1"
            );
            state_writes.push((cursor_key.clone(), String::new()));
        }
        let cursor = gate
            .cursor
            .unwrap_or_else(|| start_listing_cursor(site, LISTING_KIND, cfg.page_path, opts.now));

        let reader = SiteListingReader::new(
            site,
            bases,
            cfg.flavor,
            cfg.page_path,
            self.fetcher.clone(),
            allow,
        );
        let walk = walk_listing(ListingWalkInput {
            reader: &reader,
            expected_per_page: cfg.cards_per_page,
            round_max_pages: opts.listing_round_max_pages,
            series_enabled: opts.emit_series,
            default_kind: LISTING_KIND,
            cursor,
            now: opts.now,
        })
        .await;

        if walk.pages_consumed > 0 {
            // Marcador ANTES do cursor de propósito: um crash entre as duas
            // escritas deixa o cursor ANTIGO com o marcador novo (a rodada
            // seguinte continua daquele ponto: releitura barata). Na ordem
            // inversa, o cursor novo ficaria com o marcador velho e a próxima
            // rodada jogaria a varredura inteira fora.
            state_writes.push((marker_key, marker_of(opts.emit_series)));
            state_writes.push((cursor_key, encode_listing_cursor(&walk.cursor)));
        }

        let complete = walk.complete;
        Ok(DiscoveryReport {
            urls: walk.urls,
            complete,
            complete_movie: complete,
            // Com séries desligadas as URLs de série foram LIDAS e
            // DESCARTADAS: `true` afirmaria cobertura que não existe.
            complete_tv_show: opts.emit_series && complete,
            failures: walk.failures,
            request_cost: walk.requests,
            state_writes,
        })
    }
}

#[cfg(test)]
#[path = "tests_listing.rs"]
mod tests;
