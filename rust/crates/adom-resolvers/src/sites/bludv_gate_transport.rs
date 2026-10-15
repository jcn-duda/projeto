//! Gate transport: trait + guards + erro. Espelho de
//! resolvers/profiles/bludv-gate-transport.ts.

use std::fmt;
use std::sync::LazyLock;

use url::Url;

use super::gate_links::safe_gate_url;

// --- Erro ---

/// Causa estruturada da falha do portao.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    Refused(String),
    Cancelled,
}

impl GateError {
    pub fn refused(reason: &str) -> Self {
        Self::Refused(format!("bludv: portao de anuncio ({reason})"))
    }
}

impl fmt::Display for GateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(msg) => write!(f, "{}", msg),
            Self::Cancelled => write!(f, "bludv: portao de anuncio (cancelado)"),
        }
    }
}
impl std::error::Error for GateError {}

pub type GateResult<T> = Result<T, GateError>;

// --- Hosts de anuncio ---

static AD_HOSTS: LazyLock<Vec<&'static str>> =
    LazyLock::new(|| vec!["promobr.online", "x.gd", "valedesconto.shop"]);

pub fn is_ad_host(host: &str) -> bool {
    AD_HOSTS.contains(&host)
}

pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_REDIRECTS: u32 = 6;
pub const CLEANUP_MS: u64 = 3_000;

pub type UrlGuard = dyn Fn(&Url) -> bool + Send + Sync;

// --- Tipos de saida ---

#[derive(Debug, Clone)]
pub struct FlareGetResult {
    pub url: Url,
    pub html: String,
}

#[derive(Debug, Clone)]
pub struct GetResult {
    pub url: Url,
    pub location: Option<Url>,
    pub html: String,
}

// --- Trait ---

#[async_trait::async_trait]
pub trait GateTransport: Send + Sync {
    async fn create_session(&self) -> GateResult<()>;
    async fn flare_get(&self, value: &str, guard: &UrlGuard) -> GateResult<FlareGetResult>;
    async fn direct_get(&self, value: &str) -> GateResult<GetResult>;
    async fn follow_text(&self, value: &str, guard: &UrlGuard) -> GateResult<String>;
    async fn destroy_session(&self);
    fn allowed(&self, value: &str, base: Option<&str>) -> GateResult<Url>;
}

// --- Guards ---

pub fn at(host: &str, path_prefix: &str) -> Box<UrlGuard> {
    let host = host.to_string();
    let path_prefix = path_prefix.to_string();
    Box::new(move |url: &Url| {
        url.host_str().unwrap_or("") == host.as_str() && url.path().starts_with(&path_prefix)
    })
}

pub fn at_regex(host: &str, pattern: &str) -> Box<UrlGuard> {
    let host = host.to_string();
    let re = regex::Regex::new(pattern).expect("regex de path do gate");
    Box::new(move |url: &Url| {
        url.host_str().unwrap_or("") == host.as_str() && re.is_match(url.path())
    })
}

pub fn check_allowed(gate_hostname: &str, value: &str, base: Option<&str>) -> GateResult<Url> {
    let url =
        safe_gate_url(value, base).ok_or_else(|| GateError::refused("destino nao permitido"))?;
    let host = url.host_str().unwrap_or("");
    if host != gate_hostname && !is_ad_host(host) {
        return Err(GateError::refused("destino nao permitido"));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ad_hosts_exatos() {
        assert!(is_ad_host("promobr.online"));
        assert!(is_ad_host("x.gd"));
        assert!(is_ad_host("valedesconto.shop"));
        assert!(!is_ad_host("malware.com"));
        assert!(!is_ad_host("sub.promobr.online"));
    }

    #[test]
    fn check_allowed_aceita_gate_host() {
        let r = check_allowed(
            "bludvfilmes1.xyz",
            "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=1",
            None,
        );
        assert!(r.is_ok());
    }

    #[test]
    fn check_allowed_aceita_ad_host() {
        let r = check_allowed("bludvfilmes1.xyz", "https://promobr.online/jump/abc", None);
        assert!(r.is_ok());
    }

    #[test]
    fn check_allowed_rejeita_outro() {
        let r = check_allowed("bludvfilmes1.xyz", "https://evil.com/path", None);
        assert!(r.is_err());
    }

    #[test]
    fn gate_error_nao_vaza_url() {
        let e = GateError::refused("destino nao permitido");
        let msg = e.to_string();
        assert!(msg.contains("portao"));
        assert!(!msg.contains("http"));
    }

    #[test]
    fn at_regex_funciona() {
        let g = at_regex("promobr.online", "^/jump/.+$");
        let u = Url::parse("https://promobr.online/jump/xyz").unwrap();
        assert!(g(&u));
        let u2 = Url::parse("https://promobr.online/other").unwrap();
        assert!(!g(&u2));
    }
}
