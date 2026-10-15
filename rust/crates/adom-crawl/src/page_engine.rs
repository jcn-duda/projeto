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

use tokio::sync::Mutex as AsyncMutex;

use crate::flare::{self, build_flare_headers, FlareSession, FlareSessions};
use crate::motor::types::{
    now_ms, CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus, CrawlWorkResult, PageEngine,
    PageFuture, PageOutcome,
};
use crate::net::{fetch_follow_redirects, FetchRedirectsOptions, FetchResponse};
use crate::page_parser::{self, CrawlPageParsed, CrawlParsedGroup, CrawlParsedRelease};
use crate::protector_follow::ProtectorFollow;
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
    /// Resolver local que segue os botões de protetor (Nerd, Comando, TDF).
    /// `None` fecha a página só-protetor como `no-torrent` (testes, kill-switch).
    pub protector: Option<ProtectorFollow>,
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
            protector: None,
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
        // Régua estrita do TS (`isVacaChallenge`): a frouxa casa o script `/jsd/`
        // de telemetria de qualquer página do Cloudflare e descartava o solve.
        if flare::is_direct_challenge(200, &HashMap::new(), &solution.body) {
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
            // 2. Mico (`own_pace`): CINTA DE SEGURANÇA. O dono é o motor TS e o
            //    claim do store já o exclui (roteamento single-owner) — se isto
            //    dispara, alguém reivindicou fora do caminho normal. Recusar
            //    aqui degrada a fila SEM gastar rede (nunca deveria acontecer).
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
            // 4. Botões de protetor seguidos pelo resolver local ANTES do
            //    veredito: sem isto a página só-protetor sairia `no-torrent`.
            let mut resolved = HashMap::new();
            if let Some(follow) = &self.protector {
                let buttons = page_parser::protector_buttons(&row.site, &row.url, &html);
                if !buttons.is_empty() {
                    match follow
                        .resolve_buttons(&row.site, &row.url, &buttons, &cost)
                        .await
                    {
                        Ok(map) => resolved = map,
                        Err(msg) => return PageOutcome::Failed(msg),
                    }
                }
            }
            // 5. Parser unificado e conversão para o contrato do Node.
            let parsed = page_parser::parse_crawl_page_with(
                &row.site, &row.kind, &row.url, &html, &resolved,
            );
            PageOutcome::Work(Box::new(to_work(row, parsed, cost.load(Ordering::SeqCst))))
        })
    }
}

/// A resposta é o desafio do Cloudflare? Só 200/403/503 carregam o desafio; o
/// `cf-mitigated` é a prova que o body sozinho não dá.
fn response_is_challenge(r: &FetchResponse) -> bool {
    // Régua estrita do TS (status 2xx/403/503, `cf-mitigated`, script do desafio
    // fora de `/jsd/`, `_cf_chl_opt`, espera + challenges.cloudflare.com). A
    // frouxa marcava como desafio TODA página do comando (200 com o script
    // `/cdn-cgi/challenge-platform/scripts/jsd/main.js` de telemetria), e o
    // perfil sem Flare recusava a página inteira.
    flare::is_direct_challenge(r.status, &r.headers, &r.body)
}

/// Rótulo do parser → enum do contrato. Desconhecido é `Error` (nunca inventar
/// `done`, que gravaria página lixo no índice).
fn status_from(label: &str) -> CrawlResultStatus {
    match label {
        "done" => CrawlResultStatus::Done,
        "no-torrent" => CrawlResultStatus::NoTorrent,
        "gate-pending" => CrawlResultStatus::GatePending,
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
/// `pub(crate)`: o executor de portão também grava no acervo e precisa da
/// MESMA tradução (uma só régua, zero divergência).
pub(crate) fn kind_from(kind: &str) -> String {
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
        // O href do portão fica no crate: o motor o grava na `crawl_gate` e o
        // executor de fundo paga depois — o Node não recebe este status.
        gate: parsed.gate,
    }
}

impl crate::gate::FlareProbe for CrawlPageEngine {
    /// Há raspagem FlareSolverr em curso no motor? O solver atende UM pedido
    /// por vez e é o MESMO da busca ao vivo — o pagamento de portão do executor
    /// de fundo não pode enfileirar atrás (nem na frente) de uma raspagem.
    /// `try_lock`: a faixa única (`flare_gate`) está livre só quando ninguém
    /// está escalando ao solver.
    fn flare_busy(&self) -> bool {
        match self.flare_gate.try_lock() {
            Ok(guard) => {
                drop(guard);
                false
            }
            Err(_) => true,
        }
    }
}

#[cfg(test)]
#[path = "page_engine_tests.rs"]
mod tests;
