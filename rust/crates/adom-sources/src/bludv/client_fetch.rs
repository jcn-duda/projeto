//! Hops HTTP do BLUDV: redirect MANUAL com a guarda SSRF em cada `Location`.

use adom_core::is_safe_download_url;
use reqwest::header::{ACCEPT, LOCATION, REFERER, USER_AGENT};
use reqwest::{StatusCode, Url};

use crate::http::remaining;

use super::super::config::{BludvConfig, BLUDV_USER_AGENT};
use super::BludvClient;

/// Teto de redirects por hop (o `fetch` do Node usa 20).
const MAX_REDIRECTS: usize = 20;

/// Erro de transporte do hop. HTTP não-2xx mantém o status (quem chama decide
/// `live.empty` × `live.failed`); bloqueio/SSRF é falha local, nunca redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum FetchError {
    Blocked(String),
    Budget,
    Http(u16),
    Network(String),
    Timeout,
    TooManyRedirects,
}

impl FetchError {
    pub(super) fn describe(&self) -> String {
        match self {
            FetchError::Blocked(url) => {
                let preview: String = url.chars().take(120).collect();
                format!("URL bloqueada pela guarda SSRF: {preview}")
            }
            FetchError::Budget => "orçamento esgotado".into(),
            FetchError::Http(status) => format!("HTTP {status}"),
            FetchError::Network(err) => format!("rede: {err}"),
            FetchError::Timeout => "prazo esgotado".into(),
            FetchError::TooManyRedirects => "redirects demais".into(),
        }
    }
}

/// Resultado cru de um hop.
enum Exchange {
    Text(String),
    Http(u16),
    Redirect(Option<String>),
}

impl BludvClient {
    /// GET de HTML seguindo redirects MANUALMENTE, com a guarda SSRF em cada
    /// hop e o prazo absoluto compartilhado entre eles.
    pub(super) async fn get_text(
        &self,
        url: &str,
        referer: Option<&str>,
        deadline: i64,
    ) -> Result<String, FetchError> {
        let mut current = url.to_string();
        for hop in 0..=MAX_REDIRECTS {
            // Guarda SSRF em CADA hop — post/protetor/redirect são HTML de terceiro.
            if !fetch_url_allowed(&current, &self.config) {
                return Err(FetchError::Blocked(current));
            }
            let Some(budget) = remaining(deadline) else {
                return Err(FetchError::Budget);
            };
            let mut request = self
                .http
                .get(&current)
                .header(ACCEPT, "text/html,application/xhtml+xml")
                .header(USER_AGENT, BLUDV_USER_AGENT)
                .timeout(budget);
            if let Some(r) = referer {
                request = request.header(REFERER, r);
            }
            let exchange = async move {
                let response = request.send().await.map_err(|e| e.to_string())?;
                let status = response.status();
                if status.is_redirection() {
                    let target = response
                        .headers()
                        .get(LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    return Ok::<Exchange, String>(Exchange::Redirect(target));
                }
                if !status.is_success() {
                    return Ok(Exchange::Http(status.as_u16()));
                }
                response
                    .text()
                    .await
                    .map(Exchange::Text)
                    .map_err(|e| e.to_string())
            };
            match tokio::time::timeout(budget, exchange).await {
                Ok(Ok(Exchange::Text(text))) => return Ok(text),
                Ok(Ok(Exchange::Http(status))) => return Err(FetchError::Http(status)),
                Ok(Ok(Exchange::Redirect(target))) => {
                    let Some(location) = target else {
                        // 3xx sem Location: não há para onde ir.
                        return Err(FetchError::Http(StatusCode::FOUND.as_u16()));
                    };
                    let base =
                        Url::parse(&current).map_err(|err| FetchError::Network(err.to_string()))?;
                    let next = base
                        .join(&location)
                        .map_err(|err| FetchError::Network(err.to_string()))?;
                    if next.scheme() != "http" && next.scheme() != "https" {
                        return Err(FetchError::Blocked(next.to_string()));
                    }
                    if hop == MAX_REDIRECTS {
                        return Err(FetchError::TooManyRedirects);
                    }
                    current = next.to_string();
                }
                Ok(Err(err)) => return Err(FetchError::Network(err)),
                Err(_) => return Err(FetchError::Timeout),
            }
        }
        Err(FetchError::TooManyRedirects)
    }
}

/// URL permitida para fetch BLUDV?
///
/// Usa o mesmo `is_safe_download_url` do Jackett. A flag `allow_private_url`
/// só amplia a **origem da base** (loopback de teste / instalador) — HTML do
/// post (e o `Location` de um redirect) não pode puxar `169.254.169.254` ou
/// outro privado arbitrário.
pub(super) fn fetch_url_allowed(url: &str, cfg: &BludvConfig) -> bool {
    if url.is_empty() {
        return false;
    }
    if is_safe_download_url(url, false) {
        return true;
    }
    cfg.allow_private_url && is_safe_download_url(url, true) && same_origin(url, &cfg.base_url)
}

fn same_origin(url: &str, base: &str) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    let Ok(base) = Url::parse(base) else {
        return false;
    };
    target.scheme() == base.scheme()
        && target.host_str() == base.host_str()
        && target.port_or_known_default() == base.port_or_known_default()
}
