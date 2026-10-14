//! Escalonamento direto → FlareSolverr para fetch de páginas com desafio Cloudflare.
//!
//! Porte fiel de `resolvers/profiles/vacatorrent-crawl-fetch.ts:21-38`.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;

use super::client::fetch_text_via_flare;
use super::session::{build_flare_headers, FlareSession, FlareSessions};
use super::types::{FlareError, DIRECT_CHALLENGE_MSG};

use crate::net::allowlist::Allowlist;
use crate::net::{fetch_follow_redirects, FetchDirectOptions, FetchRedirectsOptions};

/// Dependências do fetch com escalonamento direto → Flare.
///
/// Agregam configuração de rede (allowlist, timeouts) e estado de sessão
/// (FlareSessions compartilhado via `Arc<Mutex<..>>`).
pub struct CrawlFetchDeps {
    /// Allowlist de hostnames permitidos.
    pub allowlist: Allowlist,
    /// Mapa de sessões FlareSolverr ativas por hostname.
    pub sessions: Arc<Mutex<FlareSessions>>,
    /// URL base do FlareSolverr (default: `http://127.0.0.1:8191`).
    pub solver_url: String,
    /// Timeout para requisições ao FlareSolverr (ms).
    pub flare_timeout_ms: u64,
    /// Timeout para fetch direto (ms).
    pub direct_timeout_ms: u64,
    /// Máximo de hops permitidos.
    pub max_hops: usize,
    /// User-Agent padrão para requisições diretas.
    pub user_agent: String,
    /// Callback opcional para contar requisições.
    pub on_request: Option<Arc<dyn Fn() + Send + Sync>>,
}

/// Busca o texto de uma URL com escalonamento automático ao FlareSolverr.
///
/// Fluxo:
/// 1. Tenta `fetch_text_direct` (caminho direto, sem FlareSolverr)
/// 2. Se o erro contém `DIRECT_CHALLENGE_MSG` ("challenge"):
///    - Conta 1 requisição via `on_request`
///    - Chama `fetch_text_via_flare`
///    - Se o body retornado ainda é desafio → limpa sessões e retorna erro
///    - Senão → retorna o body
/// 3. Se o erro é diferente de desafio → propaga o erro
pub async fn fetch_text_crawl(url: &str, deps: &CrawlFetchDeps) -> Result<String, FlareError> {
    fetch_text_crawl_accept(url, deps, "text/html").await
}

/// [`fetch_text_crawl`] com `Accept` próprio: a busca AJAX do VacaTorrent pede
/// JSON (`vacatorrent.ts`, `fetchText(ajaxUrl, 'application/json, …')`).
pub async fn fetch_text_crawl_accept(
    url: &str,
    deps: &CrawlFetchDeps,
    accept: &str,
) -> Result<String, FlareError> {
    // Monta headers de sessão (se houver sessão ativa para o hostname)
    let extra_headers = {
        let sessions_guard = deps
            .sessions
            .lock()
            .map_err(|_| FlareError::DirectError("lock de sessões envenenado".to_string()))?;
        build_flare_headers(&sessions_guard, url)
    };

    let direct_opts = FetchDirectOptions {
        timeout_ms: deps.direct_timeout_ms,
        max_hops: deps.max_hops,
        allowlist: deps.allowlist.clone(),
        user_agent: deps.user_agent.clone(),
        accept: accept.to_string(),
        cookie_jar: None,
        headers: extra_headers,
    };

    // 1. Tenta fetch direto
    match fetch_direct_detecting_challenge(url, direct_opts).await {
        Ok(body) => Ok(body),
        Err(err_msg) => {
            // 2. Se erro contém "challenge" → escala para FlareSolverr
            if err_msg.contains(DIRECT_CHALLENGE_MSG) {
                // Conta 1 requisição para o FlareSolverr
                if let Some(on_req) = &deps.on_request {
                    on_req();
                }

                let solution =
                    fetch_text_via_flare(url, &deps.solver_url, deps.flare_timeout_ms).await?;

                // Verifica se o body retornado ainda é desafio, com a mesma régua
                // estrita da ida (`isChallenge` do `createFetchTextCrawl`): a frouxa
                // casava o script `/jsd/` da página já resolvida e descartava o solve.
                if is_direct_challenge(200, &HashMap::new(), &solution.body) {
                    // Desafio não resolvido — limpa sessões
                    if let Ok(mut sessions) = deps.sessions.lock() {
                        sessions.clear();
                    }
                    return Err(FlareError::ChallengeNotResolved);
                }

                // Armazena a sessão para reuso futuro
                if !solution.cookies.is_empty() {
                    let cookies_str = solution
                        .cookies
                        .iter()
                        .map(|(n, v)| format!("{}={}", n, v))
                        .collect::<Vec<_>>()
                        .join("; ");

                    let hostname = url::Url::parse(url)
                        .ok()
                        .and_then(|u| u.host_str().map(|h| h.to_string()));

                    let final_hostname = url::Url::parse(&solution.final_url)
                        .ok()
                        .and_then(|u| u.host_str().map(|h| h.to_string()));

                    if let Some(session_host) = hostname {
                        let ttl = {
                            let sessions = deps.sessions.lock().ok();
                            sessions.as_ref().map(|s| s.session_ttl()).unwrap_or(
                                std::time::Duration::from_millis(
                                    super::types::defaults::SESSION_TTL_MS,
                                ),
                            )
                        };

                        let session =
                            FlareSession::new(cookies_str, solution.user_agent.clone(), ttl);

                        if let Ok(mut sessions) = deps.sessions.lock() {
                            let mut hosts = vec![session_host];
                            if let Some(final_h) = final_hostname {
                                if final_h != hosts[0] {
                                    hosts.push(final_h);
                                }
                            }
                            sessions.store_for_hosts(hosts, session);
                        }
                    }
                }

                Ok(solution.body)
            } else {
                // 3. Erro diferente de desafio → propaga
                Err(FlareError::DirectError(err_msg))
            }
        }
    }
}

/// Fetch direto que sinaliza o desafio do Cloudflare com `DIRECT_CHALLENGE_MSG`,
/// como o `fetchTextDirect` do TS. O `fetch_text_direct` descarta o corpo e só
/// devolve `HttpError{status}`, então a escalada acima nunca disparava.
async fn fetch_direct_detecting_challenge(
    url: &str,
    opts: FetchDirectOptions,
) -> Result<String, String> {
    let response = fetch_follow_redirects(
        url,
        FetchRedirectsOptions {
            timeout_ms: opts.timeout_ms,
            max_hops: opts.max_hops,
            allowlist: opts.allowlist,
            user_agent: opts.user_agent,
            accept: opts.accept,
            headers: opts.headers,
            cookie_jar: opts.cookie_jar,
            on_request: None,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    if is_direct_challenge(response.status, &response.headers, &response.body) {
        return Err(DIRECT_CHALLENGE_MSG.to_string());
    }
    if !response.is_ok() {
        return Err(format!("http_{}", response.status));
    }
    Ok(response.body)
}

/// Regra do `isVacaChallenge` + status do `fetchTextDirect` (`vacatorrent.ts`):
/// só 2xx/403/503 contam, e corpo JSON (a busca AJAX) nunca é desafio, a menos
/// que o header `cf-mitigated` diga que é.
pub fn is_direct_challenge(status: u16, headers: &HashMap<String, String>, body: &str) -> bool {
    if !(200..300).contains(&status) && status != 403 && status != 503 {
        return false;
    }
    let mitigated = headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case("cf-mitigated") && v.eq_ignore_ascii_case("challenge")
    });
    if mitigated {
        return true;
    }
    let trimmed = body.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        return false;
    }
    // O `is_cloudflare_challenge` casa qualquer `challenge-platform`, inclusive o
    // script `/jsd/` de telemetria que página normal do Cloudflare carrega: num
    // 200 isso mandaria toda busca ao FlareSolverr. Aqui vale a régua exata do TS.
    static PLATFORM_SRC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)<script\b[^>]*\bsrc\s*=\s*["'][^"']*/cdn-cgi/challenge-platform/([^"']*)"#,
        )
        .expect("regex de script do desafio")
    });
    static CHL_OPT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b_cf_chl_opt\s*=").expect("regex _cf_chl_opt"));
    static WAIT_PAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)Just a moment|Checking your browser").expect("regex da espera")
    });
    static CF_HOST: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)challenges\.cloudflare\.com").expect("regex do host"));
    PLATFORM_SRC
        .captures_iter(body)
        .any(|c| !c[1].contains("/jsd/"))
        || CHL_OPT.is_match(body)
        || (WAIT_PAGE.is_match(body) && CF_HOST.is_match(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_challenge_msg_constant() {
        assert_eq!(DIRECT_CHALLENGE_MSG, "challenge");
    }

    fn no_headers() -> HashMap<String, String> {
        HashMap::new()
    }

    const CF_PAGE: &str = "<html><title>Just a moment...</title>\
        <script src=\"https://challenges.cloudflare.com/x\"></script>\
        <script>window._cf_chl_opt = {}</script></html>";

    /// O 403 do Cloudflare (BLUDV, RedeTorrent) escala; antes virava `http_403`.
    #[test]
    fn desafio_em_403_escala() {
        assert!(is_direct_challenge(403, &no_headers(), CF_PAGE));
        assert!(is_direct_challenge(503, &no_headers(), CF_PAGE));
    }

    #[test]
    fn header_cf_mitigated_escala_ate_com_json() {
        let mut h = no_headers();
        h.insert("CF-Mitigated".into(), "challenge".into());
        assert!(is_direct_challenge(403, &h, "{}"));
    }

    #[test]
    fn json_e_erro_comum_nao_escalam() {
        assert!(!is_direct_challenge(
            200,
            &no_headers(),
            "[{\"title\":\"x\"}]"
        ));
        assert!(!is_direct_challenge(
            403,
            &no_headers(),
            "<html>forbidden</html>"
        ));
        assert!(!is_direct_challenge(404, &no_headers(), CF_PAGE));
    }

    /// Página normal com o script `/jsd/` de telemetria do Cloudflare não escala.
    #[test]
    fn script_jsd_de_telemetria_nao_e_desafio() {
        let ok = "<html><script src=\"/cdn-cgi/challenge-platform/scripts/jsd/main.js\"></script>\
            <h2>Batman</h2></html>";
        assert!(!is_direct_challenge(200, &no_headers(), ok));
        let chl =
            "<script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script>";
        assert!(is_direct_challenge(403, &no_headers(), chl));
    }
}
