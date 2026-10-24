//! Laço de redirects HTTP com allowlist por hop e deadline da cadeia.
//!
//! Porta do `fetchFollowRedirects` do `resolvers/transport.ts` (linhas 204-225):
//! cada salto 3xx é validado na allowlist ANTES do fetch seguinte; o timeout
//! é da CADEIA inteira, não por hop.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderName, HeaderValue};
use url::Url;

use crate::net::allowlist::Allowlist;
use crate::net::cookie_jar::CookieJar;
use crate::net::types::{CrawlFetchError, FetchResponse};

/// Opções do laço de redirects HTTP do fetch DIRETO (crawl).
pub struct FetchRedirectsOptions {
    /// Prazo da CADEIA inteira, não por hop.
    pub timeout_ms: u64,
    /// Teto de saltos (mesmo `maxHops` do transporte do protetor).
    pub max_hops: usize,
    /// Allowlist: cada salto passa por ela ANTES do fetch.
    pub allowlist: Allowlist,
    /// User-Agent do fetch.
    pub user_agent: String,
    /// Header Accept do fetch.
    pub accept: String,
    /// Headers extras (ex: Cookie do FlareSolverr).
    pub headers: HashMap<String, String>,
    /// CookieJar opcional (reenvia cookies por hostname).
    pub cookie_jar: Option<CookieJar>,
    /// Callback disparado ANTES de cada fetch real (custo por HOP, F3).
    pub on_request: Option<Box<dyn Fn() + Send>>,
}

/// Laço de redirects HTTP com `redirect: Policy::none()` (manual).
///
/// Fluxo:
/// 1. `allowlist.assert_allowed_url(url)` → URL validada.
/// 2. `deadline_at = Instant::now() + timeout_ms` — prazo da cadeia inteira.
/// 3. Loop até `max_hops`:
///    - `remaining = deadline_at - Instant::now()`
///    - `on_request?.call()` — conta hop
///    - reqwest GET com redirect manual, headers, timeout restante
///    - 3xx → `Location` → `allowlist.assert_allowed_url(new_url)` → continua
///    - Não-3xx → retorna `FetchResponse { status, body, url, headers }`
/// 4. Esgotou hops → `Err(CrawlFetchError::TooManyRedirects)`
pub async fn fetch_follow_redirects(
    url: &str,
    opts: FetchRedirectsOptions,
) -> Result<FetchResponse, CrawlFetchError> {
    // Validação inicial na allowlist.
    let mut current: Url = opts.allowlist.assert_allowed_url(url)?;

    let deadline_at = Instant::now() + Duration::from_millis(opts.timeout_ms);
    let mut cookie_jar = opts.cookie_jar;

    for _hop in 0..=opts.max_hops {
        let remaining = deadline_at.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(CrawlFetchError::Timeout);
        }

        // Custo por HOP (F3): cada fetch do laço conta.
        if let Some(ref on_request) = opts.on_request {
            on_request();
        }

        // Monta headers deste hop.
        let mut req_headers = reqwest::header::HeaderMap::new();
        req_headers.insert(
            reqwest::header::USER_AGENT,
            HeaderValue::from_str(&opts.user_agent)
                .map_err(|_| CrawlFetchError::ConnectionError("invalid user-agent".into()))?,
        );
        req_headers.insert(
            reqwest::header::ACCEPT,
            HeaderValue::from_str(&opts.accept)
                .map_err(|_| CrawlFetchError::ConnectionError("invalid accept".into()))?,
        );

        // Headers extras do caller.
        for (key, value) in &opts.headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                req_headers.insert(name, val);
            }
        }

        // Cookie do jar (somente para o mesmo hostname).
        if let Some(ref jar) = cookie_jar {
            if let Some(host) = current.host_str() {
                if let Some(cookie_header) = jar.headers_for(host) {
                    if let Ok(val) = HeaderValue::from_str(&cookie_header) {
                        req_headers.insert(reqwest::header::COOKIE, val);
                    }
                }
            }
        }

        // Cria client com redirect manual (sem seguir automaticamente).
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| CrawlFetchError::ConnectionError(e.to_string()))?;

        let response = client
            .get(current.as_str())
            .headers(req_headers)
            .timeout(remaining)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    CrawlFetchError::Timeout
                } else if e.is_connect() {
                    CrawlFetchError::ConnectionError(e.to_string())
                } else if e.is_redirect() {
                    // reqwest considera "too many redirects" como redirect error
                    CrawlFetchError::TooManyRedirects
                } else {
                    CrawlFetchError::ConnectionError(e.to_string())
                }
            })?;

        // Colhe cookies da resposta (se jar ativo).
        if let Some(ref mut jar) = cookie_jar {
            if let Some(host) = current.host_str() {
                jar.store_from_response(&response, host);
            }
        }

        let status = response.status().as_u16();

        // 3xx → redirect manual: valida Location na allowlist.
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(CrawlFetchError::MissingRedirectLocation)?;

            // Resolve Location relativa contra a URL atual.
            let next_url = Url::options()
                .base_url(Some(&current))
                .parse(location)
                .map_err(|_| CrawlFetchError::InvalidUrl)?;

            // Valida o próximo hop na allowlist.
            current = opts.allowlist.assert_allowed_url(next_url.as_str())?;
            continue;
        }

        // Destino final: extrai headers ANTES de consumir o body.
        let mut resp_headers = HashMap::new();
        for (name, value) in response.headers().iter() {
            if let Ok(v) = value.to_str() {
                resp_headers.insert(name.as_str().to_string(), v.to_string());
            }
        }

        let body = response
            .text()
            .await
            .map_err(|e| CrawlFetchError::BodyReadError(e.to_string()))?;

        return Ok(FetchResponse {
            status,
            body,
            url: current.to_string(),
            headers: resp_headers,
        });
    }

    // Esgotou hops sem destino final.
    Err(CrawlFetchError::TooManyRedirects)
}
