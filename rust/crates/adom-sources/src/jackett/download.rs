//! Resolução do `Link` Torznab → magnet.
//!
//! O Link é input de TERCEIRO: `is_safe_download_url` (núcleo) + exceção
//! estreita do próprio `/dl/<indexer>/` do Jackett. Fetch com
//! `redirect: manual` — só o `Location: magnet:?…` (ou magnet no corpo) vale.

use std::time::Duration;

use adom_core::is_safe_download_url;
use reqwest::header::ACCEPT;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};

use super::config::JackettConfig;

/// Exceção SSRF: origem do Jackett + path `/dl/<indexer>/` (não qualquer path
/// admin). Mesma régua de `isJackettDownloadLink` no TS.
pub fn is_jackett_download_link(url: &str, jackett_base: &str) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    let Ok(base) = Url::parse(jackett_base) else {
        return false;
    };
    // Compara scheme/host/port — `Origin` opaco divergiria em edge cases.
    if target.scheme() != base.scheme()
        || target.host_str() != base.host_str()
        || target.port_or_known_default() != base.port_or_known_default()
    {
        return false;
    }
    let base_prefix = base.path().trim_end_matches('/');
    let path = target.path();
    if !path.starts_with(base_prefix) {
        return false;
    }
    let rest = &path[base_prefix.len()..];
    is_dl_path(rest)
}

fn is_dl_path(rest: &str) -> bool {
    // `/dl/<indexer>/…` — indexer = [A-Za-z0-9._-]+
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let mut parts = rest.split('/');
    if parts.next() != Some("dl") {
        return false;
    }
    let Some(indexer) = parts.next() else {
        return false;
    };
    if indexer.is_empty()
        || !indexer
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
    {
        return false;
    }
    // Precisa ter algo depois do indexer (barra do path do download).
    parts.next().is_some() || rest.ends_with('/')
}

/// URL permitida para o salto de download?
pub fn download_url_allowed(url: &str, cfg: &JackettConfig) -> bool {
    if url.is_empty() {
        return false;
    }
    if is_jackett_download_link(url, &cfg.url) {
        return true;
    }
    is_safe_download_url(url, cfg.allow_private_download_ips)
}

/// GET com redirect manual. Devolve magnet do `Location` ou do corpo.
///
/// Rede/timeout/bloqueio → `None` (nunca panic). A chave da API NÃO viaja
/// neste salto — o `Link` já carrega o que o Jackett assinou.
pub async fn resolve_download_magnet(
    http: &Client,
    url: &str,
    cfg: &JackettConfig,
    budget_ms: u64,
) -> Option<String> {
    if !download_url_allowed(url, cfg) {
        let preview: String = url.chars().take(160).collect();
        eprintln!("[jackett] URL de download bloqueada por segurança: {preview}");
        return None;
    }
    let timeout = Duration::from_millis(budget_ms.min(cfg.download_timeout_ms).max(1));
    let request = http
        .get(url)
        .header(ACCEPT, "text/plain,application/x-bittorrent")
        .timeout(timeout);
    let response = match request.send().await {
        Ok(r) => r,
        Err(err) => {
            eprintln!("[jackett] download: falha de rede: {err}");
            return None;
        }
    };
    if let Some(location) = response.headers().get(reqwest::header::LOCATION) {
        if let Ok(loc) = location.to_str() {
            if loc.to_ascii_lowercase().starts_with("magnet:?") {
                return Some(loc.to_string());
            }
        }
    }
    if !response.status().is_success() {
        return None;
    }
    let body = match response.text().await {
        Ok(t) => t,
        Err(err) => {
            eprintln!("[jackett] download: corpo: {err}");
            return None;
        }
    };
    extract_magnet(&body)
}

/// Cliente HTTP dedicado ao download: `redirect: none()`.
pub fn download_client(user_agent: &str) -> Result<Client, String> {
    let mut builder = Client::builder().redirect(Policy::none());
    let agent = user_agent.trim();
    if !agent.is_empty() {
        builder = builder.user_agent(agent);
    }
    builder
        .build()
        .map_err(|err| format!("cliente download Jackett: {err}"))
}

fn extract_magnet(body: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let start = lower.find("magnet:?")?;
    let slice = &body[start..];
    let end = slice
        .find(|c: char| c == '"' || c == '\'' || c == '<' || c == '>' || c.is_whitespace())
        .unwrap_or(slice.len());
    let mut magnet = slice[..end].to_string();
    // `&amp;` → `&` (mesmo replace do TS).
    while let Some(idx) = magnet.find("&amp;") {
        magnet.replace_range(idx..idx + 5, "&");
    }
    if magnet.to_ascii_lowercase().starts_with("magnet:?") {
        Some(magnet)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jackett_dl_link_aceita_so_path_dl() {
        let base = "http://127.0.0.1:9117";
        assert!(is_jackett_download_link(
            "http://127.0.0.1:9117/dl/bludv-cardigann/abc.torrent",
            base
        ));
        assert!(!is_jackett_download_link(
            "http://127.0.0.1:9117/api/v2.0/server/config",
            base
        ));
        assert!(!is_jackett_download_link(
            "http://evil.example/dl/bludv-cardigann/x",
            base
        ));
    }

    #[test]
    fn url_publica_passa_pelo_nucleo() {
        let cfg = JackettConfig::default();
        assert!(download_url_allowed(
            "https://tracker.example/download.torrent",
            &cfg
        ));
        assert!(!download_url_allowed("http://127.0.0.1:8080/file", &cfg));
        assert!(!download_url_allowed("file:///etc/passwd", &cfg));
    }

    #[test]
    fn extract_magnet_do_corpo() {
        let body = r#"<a href="magnet:?xt=urn:btih:abcd&amp;dn=x">x</a>"#;
        assert_eq!(
            extract_magnet(body).as_deref(),
            Some("magnet:?xt=urn:btih:abcd&dn=x")
        );
    }
}
