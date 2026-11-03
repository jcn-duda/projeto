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
    /// Status HTTP não-2xx no destino final. `retry_after_ms` carrega o header
    /// `Retry-After` da resposta em MILISSEGUNDOS — é o que deixa o motor ADIAR
    /// (não falhar) o 429/503 pelo prazo que o próprio site pediu (Fase 0).
    /// HTTP-date (RFC 7231) não é convertido: quem chamou aplica o default.
    HttpError {
        status: u16,
        retry_after_ms: Option<u64>,
    },
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
            // O rótulo tem de continuar EXATAMENTE `http_{status}`: os
            // contadores do painel e o store (que decide não queimar `tries`
            // pelo prefixo `http_429`/`http_503`) olham este texto. O prazo
            // viaja no campo, não no Display.
            Self::HttpError { status, .. } => write!(f, "http_{status}"),
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

/// Lê o header `Retry-After` de UMA resposta, em milissegundos.
///
/// Só a forma em SEGUNDOS inteiros é interpretada — é o que 429/503 do
/// Cloudflare e dos indexers mandam na prática. HTTP-date (`Wed, 21 Oct…`)
/// exigiria parser de data e a incerteza do relógio local: devolvemos `None`
/// e quem chama aplica o default conservador. A busca é case-insensitive de
/// propósito — o reqwest entrega chaves minúsculas, mas proxies e respostas
/// de teste podem reescrever a capitalização.
pub fn retry_after_ms_from_headers(headers: &HashMap<String, String>) -> Option<u64> {
    let raw = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("retry-after"))?
        .1;
    // Segundos inteiros → ms. Lixo, vazio e negativo não parseiam em `u64`
    // e viram ausência: o default do motor (60 s) é mais seguro do que
    // honrar uma espera vazia.
    raw.trim().parse::<u64>().ok().map(|s| s * 1000)
}
