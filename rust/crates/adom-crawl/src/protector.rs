//! Protetor de link — port Rust do `followProtectedUrl` do TS.
//!
//! Loop de fetches com `redirect: manual`, extração de magnet e descoberta
//! do próximo salto. Referência: `resolvers/transport.ts:76-176`.

use adom_core::decode_entities;
use regex::Regex;
use reqwest::Client;
use std::time::Duration;
use url::Url;

/// Erros possíveis no loop do protetor.
#[derive(Debug)]
pub enum ProtectorError {
    InvalidUrl,
    MissingRedirect,
    LinkExpired,
    HttpError(u16),
    NoMagnet,
    TooManyRedirects,
    Timeout,
    Network(String),
}

impl std::fmt::Display for ProtectorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl => write!(f, "URL inválida"),
            Self::MissingRedirect => write!(f, "redirect sem Location"),
            Self::LinkExpired => write!(f, "link expirado"),
            Self::HttpError(s) => write!(f, "HTTP {}", s),
            Self::NoMagnet => write!(f, "sem magnet no HTML final"),
            Self::TooManyRedirects => write!(f, "excedeu saltos máximos"),
            Self::Timeout => write!(f, "timeout"),
            Self::Network(m) => write!(f, "rede: {}", m),
        }
    }
}
impl std::error::Error for ProtectorError {}

// ── Regex ────────────────────────────────────────────────────────────────────

const MAGNET_PREFIX: &str = "magnet:";
fn magnet_raw_re() -> Regex {
    Regex::new(r#"(?i)magnet:\?[^""'<>\s]+"#).unwrap()
}
// regex sem backreference (crate `regex` não suporta \1); aspa de fecho livre
fn href_magnet_re() -> Regex {
    Regex::new(r#"(?i)href\s*=\s*["']?(magnet:\?[^"'<>\s]+)"#).unwrap()
}
fn meta_tag_re() -> Regex {
    Regex::new(r"(?i)<meta\b[^>]*>").unwrap()
}
fn meta_refresh_re() -> Regex {
    Regex::new(r#"(?i)\bhttp-equiv\s*=\s*["']?refresh["']?"#).unwrap()
}
fn meta_content_re() -> Regex {
    Regex::new(r#"(?i)\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
}
fn meta_url_re() -> Regex {
    Regex::new(r#"(?i)\burl\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s;]+))"#).unwrap()
}
fn js_var_url_re() -> Regex {
    Regex::new(r#"(?i)(?:DEST_URL|DOWNLOAD_URL|NEXT_URL|TARGET_URL|destino|link|url)\s*[:=]\s*["'](https?://[^"']+)["']"#).unwrap()
}

// ── extract_meta_refresh ─────────────────────────────────────────────────────

/// Extrai destino de `<meta http-equiv="refresh">`. Varredura tag por tag
/// (protetores publicam content com aspas aninhadas e ponto-e-vírgula).
pub fn extract_meta_refresh(html: &str) -> Option<String> {
    for tag in meta_tag_re().find_iter(html) {
        let t = tag.as_str();
        if !meta_refresh_re().is_match(t) {
            continue;
        }
        let content = meta_content_re().captures(t).and_then(|c| {
            c.get(1)
                .or(c.get(2))
                .or(c.get(3))
                .map(|m| decode_entities(m.as_str()))
        })?;
        let target = meta_url_re().captures(&content).and_then(|c| {
            let raw = c
                .get(1)
                .or(c.get(2))
                .or(c.get(3))
                .map(|m| m.as_str().trim())?;
            let cleaned = raw.trim_matches(|ch| ch == '\'' || ch == '"');
            if cleaned.is_empty() {
                None
            } else {
                Some(decode_entities(cleaned))
            }
        })?;
        if !target.is_empty() {
            return Some(target);
        }
    }
    None
}

// ── extract_magnet ───────────────────────────────────────────────────────────

/// Extrai o primeiro magnet do HTML (href entre aspas primeiro, depois cru).
/// Normaliza scheme para minúsculo (`MAGNET:` → `magnet:`).
pub fn extract_magnet(html: &str) -> Option<String> {
    if let Some(cap) = href_magnet_re().captures(html) {
        if let Some(m) = cap.get(1) {
            return Some(normalize_magnet(m.as_str()));
        }
    }
    magnet_raw_re()
        .find(html)
        .map(|m| normalize_magnet(m.as_str()))
}

fn normalize_magnet(v: &str) -> String {
    if v.len() >= MAGNET_PREFIX.len()
        && v[..MAGNET_PREFIX.len()].eq_ignore_ascii_case(MAGNET_PREFIX)
    {
        format!("magnet:{}", &v[MAGNET_PREFIX.len()..])
    } else {
        v.to_string()
    }
}

fn is_magnet(v: &str) -> bool {
    v.len() >= MAGNET_PREFIX.len() && v[..MAGNET_PREFIX.len()].eq_ignore_ascii_case(MAGNET_PREFIX)
}

// ── discover_next_url ────────────────────────────────────────────────────────

/// Descobre próxima URL de protetor no HTML.
/// 1. Variável JS com URL em host permitido. 2. Busca genérica por sufixos.
pub fn discover_next_url(
    html: &str,
    base_url: &str,
    hosts: &[String],
    suffixes: &[String],
) -> Option<String> {
    let base = Url::parse(base_url).ok()?;
    // 1. Variável JavaScript.
    if let Some(cap) = js_var_url_re().captures(html) {
        if let Some(m) = cap.get(1) {
            let decoded = decode_entities(m.as_str());
            if let Ok(u) = Url::parse(&decoded).or_else(|_| base.join(&decoded)) {
                if is_protector_host(u.host_str().unwrap_or(""), hosts) && u.as_str() != base_url {
                    return Some(u.into());
                }
            }
        }
    }
    // 2. Busca genérica por sufixos.
    if !suffixes.is_empty() {
        let esc: Vec<String> = suffixes.iter().map(|s| regex::escape(s)).collect();
        let pat = format!(
            r#"(?i)https?://[^""'<>\s]*?(?:{})[^""'<>\s]*"#,
            esc.join("|")
        );
        if let Ok(re) = Regex::new(&pat) {
            if let Some(m) = re.find(html) {
                let decoded = decode_entities(m.as_str());
                if let Ok(u) = Url::parse(&decoded).or_else(|_| base.join(&decoded)) {
                    if is_protector_host(u.host_str().unwrap_or(""), hosts)
                        && u.as_str() != base_url
                    {
                        return Some(u.into());
                    }
                }
            }
        }
    }
    None
}

fn is_protector_host(hostname: &str, hosts: &[String]) -> bool {
    let low = hostname.to_lowercase();
    hosts.iter().any(|h| {
        let hl = h.to_lowercase();
        low == hl || low.ends_with(&format!(".{}", hl))
    })
}

// ── follow_protected_url ─────────────────────────────────────────────────────

pub type ProtectorResult = Result<String, ProtectorError>;

/// Opções do loop do protetor.
pub struct FollowOptions<'a> {
    pub url: &'a str,
    pub referer: Option<&'a str>,
    pub protector_hosts: &'a [String],
    pub suffixes: &'a [String],
    pub max_hops: usize,
    pub timeout: Duration,
    pub user_agent: &'a str,
    pub client: &'a Client,
}

/// Loop de saltos pelo protetor. Retorna o magnet final ou erro.
pub async fn follow_protected_url(opts: FollowOptions<'_>) -> ProtectorResult {
    if opts.url.is_empty() {
        return Err(ProtectorError::InvalidUrl);
    }
    if is_magnet(opts.url) {
        return Ok(normalize_magnet(opts.url));
    }

    let mut cur = Url::parse(opts.url).map_err(|_| ProtectorError::InvalidUrl)?;
    let mut prev_ref = opts.referer.map(|s| s.to_string());

    for _ in 0..=opts.max_hops {
        let mut hdrs = reqwest::header::HeaderMap::new();
        hdrs.insert(
            reqwest::header::USER_AGENT,
            reqwest::header::HeaderValue::from_str(opts.user_agent)
                .unwrap_or_else(|_| reqwest::header::HeaderValue::from_static("Mozilla/5.0")),
        );
        hdrs.insert(
            reqwest::header::ACCEPT,
            reqwest::header::HeaderValue::from_static("text/html,application/xhtml+xml"),
        );
        if let Some(ref r) = prev_ref {
            if let Ok(v) = reqwest::header::HeaderValue::from_str(r) {
                hdrs.insert(reqwest::header::REFERER, v);
            }
        }
        let resp = opts
            .client
            .get(cur.as_str())
            .headers(hdrs)
            .timeout(opts.timeout)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ProtectorError::Timeout
                } else {
                    ProtectorError::Network(e.to_string())
                }
            })?;
        let st = resp.status().as_u16();

        // Redirect 3xx.
        if (300..400).contains(&st) {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or(ProtectorError::MissingRedirect)?;
            if is_magnet(loc) {
                return Ok(normalize_magnet(loc));
            }
            prev_ref = Some(cur.to_string());
            cur = Url::parse(loc)
                .or_else(|_| cur.join(loc))
                .map_err(|_| ProtectorError::InvalidUrl)?;
            continue;
        }
        // HTTP error.
        if !resp.status().is_success() {
            if st == 400 {
                let body = resp.text().await.unwrap_or_default();
                if body.contains("Link inválido ou expirado")
                    || body.contains("link inválido ou expirado")
                {
                    return Err(ProtectorError::LinkExpired);
                }
            }
            return Err(ProtectorError::HttpError(st));
        }
        let html = resp
            .text()
            .await
            .map_err(|e| ProtectorError::Network(format!("body: {}", e)))?;
        if let Some(m) = extract_magnet(&html) {
            return Ok(m);
        }
        if let Some(next) =
            discover_next_url(&html, cur.as_str(), opts.protector_hosts, opts.suffixes)
        {
            prev_ref = Some(cur.to_string());
            cur = Url::parse(&next)
                .or_else(|_| cur.join(&next))
                .map_err(|_| ProtectorError::InvalidUrl)?;
            continue;
        }
        if let Some(tgt) = extract_meta_refresh(&html) {
            if is_magnet(&tgt) {
                return Ok(normalize_magnet(&tgt));
            }
            prev_ref = Some(cur.to_string());
            cur = Url::parse(&tgt)
                .or_else(|_| cur.join(&tgt))
                .map_err(|_| ProtectorError::InvalidUrl)?;
            continue;
        }
        return Err(ProtectorError::NoMagnet);
    }
    Err(ProtectorError::TooManyRedirects)
}

/// Cria `reqwest::Client` sem redirect automático (adequado ao protetor).
pub fn build_protector_client() -> Result<Client, reqwest::Error> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
}

// ── Testes ───────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "protector_tests.rs"]
mod tests;
