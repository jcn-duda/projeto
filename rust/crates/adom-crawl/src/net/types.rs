//! Tipos compartilhados do módulo de rede (fetch, redirect, cookie, allowlist).

use std::collections::HashMap;
use std::fmt;

/// Erros do fetch/redirect/crawl de rede.
///
/// Mapeiam os erros do TypeScript (`invalid_url`, `blocked_host`,
/// `too_many_redirects`, `http_${status}`) para variantes tipadas.
#[derive(Debug, Clone)]
pub enum CrawlFetchError {
    /// URL inválida (parse falhou).
    InvalidUrl,
    /// Protocolo fora de `http:` / `https:`.
    UnsupportedProtocol,
    /// Host bloqueado pela allowlist.
    BlockedHost { host: String },
    /// Status HTTP não-2xx no destino final.
    HttpError { status: u16 },
    /// Timeout da cadeia (deadline estourou).
    Timeout,
    /// Esgotou o teto de saltos sem destino final.
    TooManyRedirects,
    /// Erro de conexão (DNS, TCP, TLS).
    ConnectionError(String),
    /// Falha ao ler o body da resposta.
    BodyReadError(String),
    /// Redirect 3xx sem header `Location`.
    MissingRedirectLocation,
}

impl fmt::Display for CrawlFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl => write!(f, "invalid_url"),
            Self::UnsupportedProtocol => write!(f, "unsupported_protocol"),
            Self::BlockedHost { host } => write!(f, "blocked_host:{host}"),
            Self::HttpError { status } => write!(f, "http_{status}"),
            Self::Timeout => write!(f, "timeout"),
            Self::TooManyRedirects => write!(f, "too_many_redirects"),
            Self::ConnectionError(msg) => write!(f, "connection_error:{msg}"),
            Self::BodyReadError(msg) => write!(f, "body_read_error:{msg}"),
            Self::MissingRedirectLocation => write!(f, "missing_redirect"),
        }
    }
}

impl std::error::Error for CrawlFetchError {}

/// Resposta bem-sucedida do `fetch_follow_redirects`.
#[derive(Debug, Clone)]
pub struct FetchResponse {
    /// Status HTTP do destino final.
    pub status: u16,
    /// Body como texto.
    pub body: String,
    /// URL final (após redirects).
    pub url: String,
    /// Headers da resposta final.
    pub headers: HashMap<String, String>,
}

impl FetchResponse {
    /// True quando status é 2xx.
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}
