//! Fetch de conveniência: chama `fetch_follow_redirects` e devolve o body.
//!
//! Porta do `fetchTextDirect` que os perfis usam no caminho do crawl.

use std::collections::HashMap;

use crate::net::allowlist::Allowlist;
use crate::net::cookie_jar::CookieJar;
use crate::net::redirect::{fetch_follow_redirects, FetchRedirectsOptions};
use crate::net::types::CrawlFetchError;

/// Opções do `fetch_text_direct`.
pub struct FetchDirectOptions {
    /// Prazo da cadeia inteira (ms).
    pub timeout_ms: u64,
    /// Teto de saltos.
    pub max_hops: usize,
    /// Allowlist de hosts.
    pub allowlist: Allowlist,
    /// User-Agent.
    pub user_agent: String,
    /// Header Accept.
    pub accept: String,
    /// CookieJar opcional.
    pub cookie_jar: Option<CookieJar>,
    /// Headers extras.
    pub headers: HashMap<String, String>,
}

/// Busca `url` com redirect manual + allowlist e devolve o body como String.
///
/// Se o status final não for 2xx, retorna `CrawlFetchError::HttpError`.
/// Porta do `fetchTextDirect` dos perfis (torrentdosfilmes, nerdfilmes, etc).
pub async fn fetch_text_direct(
    url: &str,
    opts: FetchDirectOptions,
) -> Result<String, CrawlFetchError> {
    let redirect_opts = FetchRedirectsOptions {
        timeout_ms: opts.timeout_ms,
        max_hops: opts.max_hops,
        allowlist: opts.allowlist,
        user_agent: opts.user_agent,
        accept: opts.accept,
        headers: opts.headers,
        cookie_jar: opts.cookie_jar,
        on_request: None,
    };

    let response = fetch_follow_redirects(url, redirect_opts).await?;

    if !response.is_ok() {
        return Err(CrawlFetchError::HttpError {
            status: response.status,
        });
    }

    Ok(response.body)
}
