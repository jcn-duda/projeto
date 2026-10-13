//! Escalonamento direto → FlareSolverr para fetch de páginas com desafio Cloudflare.
//!
//! Porte fiel de `resolvers/profiles/vacatorrent-crawl-fetch.ts:21-38`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::challenge::is_cloudflare_challenge;
use super::client::fetch_text_via_flare;
use super::session::{build_flare_headers, FlareSession, FlareSessions};
use super::types::{FlareError, DIRECT_CHALLENGE_MSG};

use crate::net::allowlist::Allowlist;
use crate::net::{fetch_text_direct, FetchDirectOptions};

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
pub async fn fetch_text_crawl(
    url: &str,
    deps: &CrawlFetchDeps,
) -> Result<String, FlareError> {
    // Monta headers de sessão (se houver sessão ativa para o hostname)
    let extra_headers = {
        let sessions_guard = deps.sessions.lock().map_err(|_| FlareError::DirectError(
            "lock de sessões envenenado".to_string(),
        ))?;
        build_flare_headers(&sessions_guard, url)
    };

    let direct_opts = FetchDirectOptions {
        timeout_ms: deps.direct_timeout_ms,
        max_hops: deps.max_hops,
        allowlist: deps.allowlist.clone(),
        user_agent: deps.user_agent.clone(),
        accept: "text/html".to_string(),
        cookie_jar: None,
        headers: extra_headers,
    };

    // 1. Tenta fetch direto
    match fetch_text_direct(url, direct_opts).await {
        Ok(body) => Ok(body),
        Err(direct_err) => {
            let err_msg = format!("{}", direct_err);

            // 2. Se erro contém "challenge" → escala para FlareSolverr
            if err_msg.contains(DIRECT_CHALLENGE_MSG) {
                // Conta 1 requisição para o FlareSolverr
                if let Some(on_req) = &deps.on_request {
                    on_req();
                }

                let solution = fetch_text_via_flare(
                    url,
                    &deps.solver_url,
                    deps.flare_timeout_ms,
                )
                .await?;

                // Verifica se o body retornado ainda é desafio
                let empty_headers = reqwest::header::HeaderMap::new();
                if is_cloudflare_challenge(200, &empty_headers, &solution.body) {
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
                            sessions
                                .as_ref()
                                .map(|s| s.session_ttl())
                                .unwrap_or(std::time::Duration::from_millis(
                                    super::types::defaults::SESSION_TTL_MS,
                                ))
                        };

                        let session = FlareSession::new(
                            cookies_str,
                            solution.user_agent.clone(),
                            ttl,
                        );

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_challenge_msg_constant() {
        assert_eq!(DIRECT_CHALLENGE_MSG, "challenge");
    }
}
