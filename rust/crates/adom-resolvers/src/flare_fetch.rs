//! Fetch dos sites atrás do Cloudflare (BLUDV, RedeTorrent, VacaTorrent): direto
//! primeiro, FlareSolverr só quando a resposta é o desafio — a mesma mecânica
//! do `fetchText` de `bludv.ts`/`redetorrent.ts`. Separado de `profile.rs` pela
//! catraca de 400 linhas.

use std::collections::HashMap;

use adom_crawl::flare::{fetch_text_crawl_accept, CrawlFetchDeps};
use url::Url;

use crate::profile::ResolverProfile;

/// FlareSolverr do container, em loopback: o `flare.solverUrl` dos profiles TS.
/// `pub(crate)` porque o warm da sessão (flare_warm.rs) usa a MESMA mecânica.
pub(crate) const SOLVER_URL: &str = "http://127.0.0.1:8191";
/// Prazo do solve: o `flare.timeoutMs` dos profiles TS.
pub(crate) const FLARE_TIMEOUT_MS: u64 = 55_000;
pub(crate) const HTML_ACCEPT: &str = "text/html,application/xhtml+xml";
const JSON_ACCEPT: &str = "application/json, text/html, */*";

impl ResolverProfile {
    /// `cf_clearance` e User-Agent da sessão do solver para o host da cadeia. O
    /// clearance só vale com o UA que o resolveu; sem sessão, a cadeia sai crua.
    pub(crate) fn chain_session(&self, url: &str) -> (Option<HashMap<String, String>>, String) {
        let host = Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_lowercase))
            .unwrap_or_default();
        let session = self.flare_sessions.lock().ok().and_then(|sessions| {
            sessions
                .get(&host)
                .map(|s| (s.cookies.clone(), s.user_agent.clone()))
        });
        let Some((cookies, user_agent)) = session else {
            return (None, self.network.user_agent.clone());
        };
        let clearance = cookies
            .split(';')
            .map(str::trim)
            .find(|c| c.starts_with("cf_clearance="))
            .map(|c| HashMap::from([(host, c.to_string())]));
        (clearance, user_agent)
    }

    pub(crate) async fn fetch_with_flare(&self, url: &str) -> Result<String, String> {
        // Porte do warm (flare_warm.rs): um fetch de usuário em andamento faz
        // o laço de fundo pular o ciclo — o FlareSolverr atende um por vez. O
        // guard RAII garante o decremento se o future for cancelado (drop).
        let _fetch_guard = crate::flare_warm::GLOBAL_WARM.fetch_guard();
        self.fetch_with_flare_inner(url).await
    }

    async fn fetch_with_flare_inner(&self, url: &str) -> Result<String, String> {
        let deps = CrawlFetchDeps {
            allowlist: self.allowlist.clone(),
            sessions: self.flare_sessions.clone(),
            solver_url: SOLVER_URL.to_string(),
            flare_timeout_ms: FLARE_TIMEOUT_MS,
            direct_timeout_ms: self.network.timeout_ms,
            max_hops: self.network.max_hops,
            user_agent: self.network.user_agent.clone(),
            on_request: None,
        };
        // Só a busca AJAX do Vaca pede JSON; post e protetor são HTML.
        let accept = if url.contains("/wp-admin/admin-ajax.php") {
            JSON_ACCEPT
        } else {
            HTML_ACCEPT
        };
        match fetch_text_crawl_accept(url, &deps, accept).await {
            Ok(body) => {
                self.selector.note_success();
                Ok(body)
            }
            Err(err) => {
                let msg = err.to_string();
                self.account_failure(&msg).await;
                Err(msg)
            }
        }
    }
}
