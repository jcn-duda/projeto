//! Tipos compartilhados do cliente HTTP do Mico Leão Dublado.
//!
//! Inclui erros, configuração e estruturas de resposta do catálogo.

use std::fmt;

/// Tipo de catálogo: filmes ou séries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogType {
    /// Catálogo de filmes.
    Movie,
    /// Catálogo de séries.
    Series,
}

impl CatalogType {
    /// Converte para o segmento da URL (`movie` ou `series`).
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogType::Movie => "movie",
            CatalogType::Series => "series",
        }
    }
}

impl fmt::Display for CatalogType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Erros possíveis nas chamadas HTTP ao Mico.
#[derive(Debug)]
pub enum MicoError {
    /// Resposta HTTP com status não-OK (exceto 429, que tem variante própria).
    HttpError {
        /// Status HTTP (ex: 500, 404).
        status: u16,
        /// Corpo da resposta (para diagnóstico).
        body: String,
    },
    /// Rate limit (429) com header `Retry-After`.
    RateLimited {
        /// Milissegundos de espera recomendados pelo servidor.
        retry_after_ms: u64,
    },
    /// Timeout na requisição (prazo duro excedido).
    Timeout,
    /// Falha ao desserializar JSON do catálogo.
    JsonParseError(String),
    /// Erro de conexão (DNS, TLS, rede).
    ConnectionError(String),
}

impl fmt::Display for MicoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MicoError::HttpError { status, body } => {
                write!(f, "HTTP {status}: {body}")
            }
            MicoError::RateLimited { retry_after_ms } => {
                write!(f, "Rate limited (429), retry after {retry_after_ms}ms")
            }
            MicoError::Timeout => write!(f, "Request timeout"),
            MicoError::JsonParseError(msg) => write!(f, "JSON parse error: {msg}"),
            MicoError::ConnectionError(msg) => write!(f, "Connection error: {msg}"),
        }
    }
}

impl std::error::Error for MicoError {}

/// Uma página do catálogo do Mico.
#[derive(Debug, Clone)]
pub struct CatalogPage {
    /// Número real de metas retornadas pela API (pode variar por página).
    pub count: usize,
    /// IMDb ids válidos extraídos das metas (filtro `/^tt\d{1,10}$/`).
    pub ids: Vec<String>,
}

/// Configuração do cliente Mico.
#[derive(Debug, Clone)]
pub struct MicoClientConfig {
    /// URL base da API (ex: `https://mico-leao-dublado-apiv-2.vercel.app`).
    pub base_url: String,
    /// Timeout por requisição em milissegundos (default: 15_000).
    pub timeout_ms: u64,
    /// Intervalo mínimo entre chamadas em milissegundos (default: 1_000).
    pub min_gap_ms: u64,
    /// Teto do `Retry-After` honrado, em milissegundos (default: 10 min).
    pub max_retry_after_ms: u64,
}

impl Default for MicoClientConfig {
    fn default() -> Self {
        Self {
            base_url: "https://mico-leao-dublado-apiv-2.vercel.app".to_string(),
            timeout_ms: 15_000,
            min_gap_ms: 1_000,
            max_retry_after_ms: crate::mico_net::throttle::DEFAULT_MAX_RETRY_AFTER_MS,
        }
    }
}
