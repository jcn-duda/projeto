//! PageEngine real: fetch de rede + parser, costurado no loop do raspador (C5).
//! Cobre os 8 sites de página HTML; o Mico, de ritmo próprio, fica para o
//! adaptador dedicado do C6 (ver o passo `own_pace` em [`PageEngine::execute`]).
//!
//! Lê por `fetch_follow_redirects`, não `fetch_text_direct`: o gatilho da escalada
//! precisa de status + headers (`vacatorrent.ts:221` só escala 200/403/503
//! desafiados) e o `requestCost` é medido por hop. Também não usa a escada de
//! `flare/escalate.rs`: ela só escala se o erro do direto contém `"challenge"`,
//! rótulo que nenhum `CrawlFetchError` produz — nunca escalaria.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use reqwest::header::HeaderMap;
use tokio::sync::Mutex as AsyncMutex;

use crate::flare::{self, build_flare_headers, FlareSession, FlareSessions};
use crate::motor::types::{
    now_ms, CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus, CrawlWorkResult, PageEngine,
    PageFuture, PageOutcome,
};
use crate::net::{fetch_follow_redirects, FetchRedirectsOptions, FetchResponse};
use crate::page_parser::{self, CrawlPageParsed, CrawlParsedGroup, CrawlParsedRelease};
use crate::site_profiles::{self, SiteNetworkConfig};
use crate::store::ops::UrlRow;

const ACCEPT_PAGE: &str = "text/html,application/xhtml+xml"; // mesmo par do profile TS
/// Tempo que o solver fica riscado depois de um `SolverNotReachable`: fora do ar,
/// ele não merece um browser lançado por página.
const SOLVER_COOLDOWN_MS: i64 = 120_000;

/// Fetch + parse de UMA página pela costura [`PageEngine`] do loop. Os campos de
/// rede são públicos para o binário do sidecar preenchê-los do ambiente (lib
/// não lê `.env`, mesma régua do TS).
pub struct CrawlPageEngine {
    pub solver_url: String,
    /// Prazo de UM pedido ao solver (`maxTimeout`).
    pub flare_timeout_ms: u64,
    pub flare_session_ttl_ms: u64, // TTL do cf_clearance memorizado
    /// A resolução de hoje faz o direto das próximas páginas do mesmo host passar.
    sessions: Arc<StdMutex<FlareSessions>>,
    /// O solver atende um pedido por vez e é o MESMO da busca ao vivo.
    flare_gate: Arc<AsyncMutex<()>>,
    solver_off_until: Arc<AtomicI64>,
}

impl Default for CrawlPageEngine {
    fn default() -> Self {
        use crate::flare::types::defaults as d;
        Self {
            solver_url: d::SOLVER_URL.to_string(),
            flare_timeout_ms: d::TIMEOUT_MS,
            flare_session_ttl_ms: d::SESSION_TTL_MS,
            sessions: Arc::new(StdMutex::new(FlareSessions::new(d::SESSION_TTL_MS))),
            flare_gate: Arc::new(AsyncMutex::new(())),
            solver_off_until: Arc::new(AtomicI64::new(0)),
        }
    }
}

impl CrawlPageEngine {
    /// Busca a página: direto primeiro (reusa a sessão quente) e escalada ao solver
    /// UMA vez se o direto vier desafiado. Custo contado por hop (`requestCost`).
    async fn fetch_page(
        &self,
        url: &str,
        profile: &SiteNetworkConfig,
        cost: &Arc<AtomicU32>,
    ) -> Result<String, String> {
        let headers = match self.sessions.lock() {
            Ok(sessions) if profile.uses_flare => build_flare_headers(&sessions, url),
            _ => HashMap::new(),
        };
        let counter = cost.clone();
        let opts = FetchRedirectsOptions {
            timeout_ms: profile.timeout_ms,
            max_hops: profile.max_hops,
            allowlist: site_profiles::resolve_allowlist(profile),
            user_agent: profile.user_agent.clone(),
            accept: ACCEPT_PAGE.to_string(),
            headers,
            cookie_jar: None,
            on_request: Some(Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            })),
        };
        let response = fetch_follow_redirects(url, opts)
            .await
            .map_err(|e| format!("fetch direto: {e}"))?;
        if !response_is_challenge(&response) {
            if !response.is_ok() {
                return Err(format!("http_{}", response.status));
            }
            return Ok(response.body);
        }
        if !profile.uses_flare {
            return Err("desafio cloudflare no caminho direto (perfil sem flare)".to_string());
        }
        self.escalate_via_flare(url, cost).await
    }

    /// UM pedido ao solver, serializado na faixa única, com a solução validada.
    async fn escalate_via_flare(&self, url: &str, cost: &Arc<AtomicU32>) -> Result<String, String> {
        let now = now_ms();
        if now < self.solver_off_until.load(Ordering::SeqCst) {
            return Err("flaresolverr indisponível (cooldown)".to_string());
        }
        let _guard = self.flare_gate.lock().await;
        // Faixa única do solver; a resolução conta UMA requisição no custo (TS: hooks.onRequest).
        cost.fetch_add(1, Ordering::SeqCst);
        let pedido = flare::fetch_text_via_flare(url, &self.solver_url, self.flare_timeout_ms);
        let solution = match pedido.await {
            Ok(s) => s,
            Err(e) => {
                if matches!(e, flare::FlareError::SolverNotReachable(_)) {
                    self.solver_off_until
                        .store(now + SOLVER_COOLDOWN_MS, Ordering::SeqCst);
                }
                return Err(format!("flare: {e}"));
            }
        };
        if flare::is_cloudflare_challenge(200, &HeaderMap::new(), &solution.body) {
            // Desafio persistente É FALHA, sem laço: o cookie de uma solução que
            // ainda é o desafio envenenaria a página seguinte.
            if let Ok(mut sessions) = self.sessions.lock() {
                sessions.clear();
            }
            return Err("desafio não resolvido pelo flaresolverr".to_string());
        }
        self.store_session(url, &solution);
        Ok(solution.body)
    }

    /// Memoriza `cf_clearance` + User-Agent no host pedido e no resolvido.
    fn store_session(&self, url: &str, solution: &flare::FlareSolution) {
        if solution.cookies.is_empty() {
            return;
        }
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        let mut parts = Vec::new();
        for (n, v) in &solution.cookies {
            parts.push(format!("{n}={v}"));
        }
        let ttl = Duration::from_millis(self.flare_session_ttl_ms);
        let session = FlareSession::new(parts.join("; "), solution.user_agent.clone(), ttl);
        let hosts: Vec<String> = [url, solution.final_url.as_str()]
            .iter()
            .filter_map(|u| url::Url::parse(u).ok())
            .filter_map(|u| u.host_str().map(|h| h.to_lowercase()))
            .collect();
        sessions.store_for_hosts(hosts, session);
    }
}

impl PageEngine for CrawlPageEngine {
    /// Fetch e parser ligados: é isto que libera o tick a reivindicar URLs.
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        Box::pin(async move {
            // 1. Sem perfil de rede não há host, timeout nem allowlist a usar.
            let Some(profile) = site_profiles::site_network_config(&row.site) else {
                return PageOutcome::Failed(format!("site sem perfil de rede: {}", row.site));
            };
            // 2. Mico (`own_pace`): recusar aqui degrada a fila sem gastar rede.
            //    TODO(C6): adaptador dedicado com throttle e laço de episódios.
            if profile.own_pace {
                return PageOutcome::Failed(format!(
                    "{}: ritmo próprio exige adaptador dedicado",
                    row.site
                ));
            }
            // 3. Fetch com custo medido; o solver entra só com desafio real.
            let cost = Arc::new(AtomicU32::new(0));
            let html = match self.fetch_page(&row.url, profile, &cost).await {
                Ok(h) => h,
                Err(msg) => return PageOutcome::Failed(msg),
            };
            // 4. Parser unificado e conversão para o contrato do Node.
            let parsed = page_parser::parse_crawl_page(&row.site, &row.kind, &row.url, &html);
            PageOutcome::Work(Box::new(to_work(row, parsed, cost.load(Ordering::SeqCst))))
        })
    }
}

/// A resposta é o desafio do Cloudflare? Só 200/403/503 carregam o desafio; o
/// `cf-mitigated` é a prova que o body sozinho não dá.
fn response_is_challenge(r: &FetchResponse) -> bool {
    if !(r.is_ok() || r.status == 403 || r.status == 503) {
        return false;
    }
    let mitigated = r.headers.iter().any(|(n, v)| {
        n.eq_ignore_ascii_case("cf-mitigated") && v.eq_ignore_ascii_case("challenge")
    });
    mitigated || flare::is_cloudflare_challenge(r.status, &HeaderMap::new(), &r.body)
}

/// Rótulo do parser → enum do contrato. Desconhecido é `Error` (nunca inventar
/// `done`, que gravaria página lixo no índice).
fn status_from(label: &str) -> CrawlResultStatus {
    match label {
        "done" => CrawlResultStatus::Done,
        "no-torrent" => CrawlResultStatus::NoTorrent,
        _ => CrawlResultStatus::Error,
    }
}

fn release_from(r: &CrawlParsedRelease) -> CrawlRawItem {
    CrawlRawItem {
        title: r.title.clone(),
        // O Node extrai o infoHash do magnet; vazio não é magnet, é ruído.
        magnet: (!r.magnet.is_empty()).then(|| r.magnet.clone()),
        link: None,
        size: r.size.clone(),
        seeders: (r.seeders > 0).then_some(r.seeders as u32),
        tracker: (!r.tracker.is_empty()).then(|| r.tracker.clone()),
        is_br: r.is_br,
    }
}

fn group_from(g: &CrawlParsedGroup) -> CrawlReleaseGroup {
    CrawlReleaseGroup {
        season: g.season.map(|s| s as u32),
        episode: g.episode.map(|e| e as u32),
        releases: g.releases.iter().map(release_from).collect(),
    }
}

/// `kind` da fila (`movie`/`tv_show`) → vocabulário do Node (`movie`/`series`).
fn kind_from(kind: &str) -> String {
    if kind == "tv_show" || kind == "series" {
        "series".to_string()
    } else {
        "movie".to_string()
    }
}

/// `CrawlPageParsed` → `CrawlWorkResult`, com o custo medido na esteira.
fn to_work(row: &UrlRow, parsed: CrawlPageParsed, cost: u32) -> CrawlWorkResult {
    let kind = parsed
        .work_type
        .clone()
        .unwrap_or_else(|| kind_from(&row.kind));
    CrawlWorkResult {
        url: row.url.clone(),
        url_key: row.url_key.clone(),
        site: row.site.clone(),
        status: status_from(&parsed.status),
        // IMDb ancorado na ficha; a fila traz o do card, que é a mesma origem.
        imdb: parsed.imdb.clone().or_else(|| row.imdb.clone()),
        title: parsed.title.clone(),
        year: parsed.year,
        kind,
        releases: parsed.releases.iter().map(release_from).collect(),
        groups: parsed.groups.iter().map(group_from).collect(),
        unlocated: parsed.unlocated.iter().map(release_from).collect(),
        progress: None,            // o parser Rust ainda não emite progresso de série
        request_cost: cost.max(1), // a página em si sempre saiu (crawl-types.ts:284)
        error: parsed.error.clone().unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(site: &str) -> UrlRow {
        UrlRow {
            site: site.to_string(),
            url: format!("https://exemplo.tv/{site}/a"),
            url_key: "/a".to_string(),
            kind: "movie".to_string(),
            status: "pending".to_string(),
            lastmod: String::new(),
            imdb: Some("tt9999999".to_string()),
            tries: 0,
            next_at: 0,
            checked_at: 0,
            releases: 0,
            error: String::new(),
            progress: String::new(),
            added_at: 0,
        }
    }

    fn release() -> CrawlParsedRelease {
        CrawlParsedRelease {
            title: "Obra 2024 1080p".to_string(),
            is_br: true,
            magnet: String::new(),
            indexer: "nerdfilmes".to_string(),
            tracker: String::new(),
            seeders: 0,
            size: None,
        }
    }

    /// Página com uma release plana e um grupo S2:E5; só `status` muda por teste.
    fn page(status: &str) -> CrawlPageParsed {
        CrawlPageParsed {
            status: status.to_string(),
            imdb: Some("tt1234567".to_string()),
            title: Some("A Obra".to_string()),
            year: Some(2024),
            work_type: Some("movie".to_string()),
            error: None,
            releases: vec![release()],
            groups: vec![CrawlParsedGroup {
                season: Some(2),
                episode: Some(5),
                releases: vec![release()],
            }],
            ..CrawlPageParsed::error("https://exemplo.tv/a", "campos não usados")
        }
    }

    fn response_of(status: u16, body: &str, headers: &[(&str, &str)]) -> FetchResponse {
        FetchResponse {
            status,
            body: body.to_string(),
            url: "https://exemplo.tv/a".to_string(),
            headers: headers
                .iter()
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn challenge_so_em_200_403_503() {
        let moment = response_of(403, "<h1>Just a moment</h1>", &[]);
        let mitigada = response_of(200, "ok", &[("cf-mitigated", "challenge")]);
        let erro = response_of(500, "Just a moment", &[]);
        let limpa = response_of(200, "<h1>Filme</h1>", &[]);
        assert!(response_is_challenge(&moment), "403 com página de desafio");
        assert!(response_is_challenge(&mitigada), "cf-mitigated no 200");
        // 500 não é faixa de desafio, e página limpa de 200 também não.
        assert!(!response_is_challenge(&erro));
        assert!(!response_is_challenge(&limpa));
    }

    #[test]
    fn work_traduz_status_custos_tipos_e_grupos() {
        let w = to_work(&row("nerdfilmes"), page("done"), 0);
        assert!(CrawlPageEngine::default().is_ready(), "libera o tick");
        assert_eq!(w.status, CrawlResultStatus::Done);
        assert_eq!(w.request_cost, 1, "piso de uma requisição por página");
        assert_eq!(w.imdb.as_deref(), Some("tt1234567"));
        assert_eq!((w.title.as_deref(), w.year), (Some("A Obra"), Some(2024)));
        assert_eq!(w.kind, "movie");
        let r = &w.releases[0];
        assert!(r.magnet.is_none(), "magnet vazio não é magnet");
        assert!(r.seeders.is_none() && r.tracker.is_none() && r.is_br);
        assert_eq!(
            (w.groups[0].season, w.groups[0].episode),
            (Some(2), Some(5))
        );
        let caro = to_work(&row("nerdfilmes"), page("no-torrent"), 7);
        assert_eq!(caro.request_cost, 7, "custo por hop passa inteiro");
        assert_eq!(caro.status, CrawlResultStatus::NoTorrent);
        // Sem work_type na ficha, vale o kind da fila.
        let mut sem_tipo = page("done");
        sem_tipo.work_type = None;
        let mut serie = row("nerdfilmes");
        serie.kind = "tv_show".to_string();
        assert_eq!(to_work(&serie, sem_tipo, 1).kind, "series");
    }

    #[test]
    fn erro_de_parse_e_rotulo_desconhecido_caem_em_error() {
        let mut p = page("layout inesperado");
        p.error = Some("layout: página sem <h1> de título".to_string());
        p.imdb = None;
        let w = to_work(&row("nerdfilmes"), p, 1);
        assert_eq!(w.status, CrawlResultStatus::Error);
        assert_eq!(w.error, "layout: página sem <h1> de título");
        // A fila sabia do IMDb e a página não provou o contrário: não se perde.
        assert_eq!(w.imdb.as_deref(), Some("tt9999999"));
    }

    #[tokio::test]
    async fn fora_do_caminho_generico_falha_sem_rede() {
        let engine = CrawlPageEngine::default();
        // Site sem perfil de rede e site de ritmo próprio (Mico) caem antes da rede.
        for site in ["site-inexistente", "mico"] {
            let outcome = engine.execute(&row(site)).await;
            let PageOutcome::Failed(msg) = outcome else {
                panic!("esperava Failed para {site}, veio {outcome:?}");
            };
            assert!(msg.contains(site), "a mensagem precisa nomear o site");
        }
    }
}
