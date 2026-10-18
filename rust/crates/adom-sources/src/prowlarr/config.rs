//! Configuração do cliente Prowlarr — mesmos knobs de `src/config/providers.ts`.
//!
//! `api_key` NUNCA entra em `Debug`/`Display` nem em log: a chave viaja só na
//! query + header `X-Api-Key` e some ao fim da requisição. Base default é
//! loopback (`:9696`); URL configurável passa por guarda SSRF
//! (`is_safe_download_url` com privado permitido — serviço do operador).

use std::fmt;

use adom_core::is_safe_download_url;

/// Base padrão no container / instalação local (Prowlarr em loopback).
pub const PROWLARR_DEFAULT_URL: &str = "http://127.0.0.1:9696";

/// `User-Agent` do oráculo (`prowlarr.ts`).
pub const PROWLARR_USER_AGENT: &str = "stremio-adom/1.0";

/// Timeout de busca do oráculo (`SEARCH_TIMEOUT_MS`, default 8000).
pub const PROWLARR_DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// Configuração do cliente `/api/v1/search`.
#[derive(Clone, PartialEq, Eq)]
pub struct ProwlarrConfig {
    /// Base do Prowlarr (`PROWLARR_URL`), sem barra final.
    pub url: String,
    /// `PROWLARR_API_KEY`. Vazio → `search` devolve `[]` (fail-open).
    pub api_key: String,
    pub user_agent: String,
    /// Orçamento de uma consulta (`SEARCH_TIMEOUT_MS` no TS).
    pub timeout_ms: u64,
    /// SSRF da base: permite IP privado/loopback (default `true` — serviço
    /// do operador). `false` barra `127.0.0.1` / RFC1918.
    pub allow_private_url: bool,
}

impl Default for ProwlarrConfig {
    fn default() -> Self {
        Self {
            url: PROWLARR_DEFAULT_URL.to_string(),
            api_key: String::new(),
            user_agent: PROWLARR_USER_AGENT.to_string(),
            timeout_ms: PROWLARR_DEFAULT_TIMEOUT_MS,
            allow_private_url: true,
        }
    }
}

impl ProwlarrConfig {
    /// Lê `PROWLARR_*` do ambiente. Ausência de chave NÃO é erro — o cliente
    /// só devolve lista vazia (mesmo contrato do TS).
    pub fn from_env() -> Self {
        let url = env_trim("PROWLARR_URL")
            .unwrap_or_else(|| PROWLARR_DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let api_key = env_trim("PROWLARR_API_KEY").unwrap_or_default();
        let timeout_ms = env_u64("SEARCH_TIMEOUT_MS")
            .or_else(|| env_u64("PROWLARR_TIMEOUT_MS"))
            .unwrap_or(PROWLARR_DEFAULT_TIMEOUT_MS)
            .max(1);
        Self {
            url,
            api_key,
            timeout_ms,
            ..Self::default()
        }
    }

    pub fn has_api_key(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    /// Base http(s) segura para o GET. Fail-closed em scheme/host inválidos.
    pub fn base_url_allowed(&self) -> bool {
        is_safe_download_url(&self.url, self.allow_private_url)
    }
}

impl fmt::Debug for ProwlarrConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProwlarrConfig")
            .field("url", &self.url)
            .field("api_key", &redact_secret(&self.api_key))
            .field("user_agent", &self.user_agent)
            .field("timeout_ms", &self.timeout_ms)
            .field("allow_private_url", &self.allow_private_url)
            .finish()
    }
}

fn redact_secret(value: &str) -> &'static str {
    if value.trim().is_empty() {
        ""
    } else {
        "***"
    }
}

fn env_trim(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_u64(key: &str) -> Option<u64> {
    env_trim(key)?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_nao_vaza_api_key() {
        let cfg = ProwlarrConfig {
            api_key: "segredo-real".into(),
            ..ProwlarrConfig::default()
        };
        let text = format!("{cfg:?}");
        assert!(!text.contains("segredo-real"));
        assert!(text.contains("***"));
    }

    #[test]
    fn url_default_e_loopback() {
        let cfg = ProwlarrConfig::default();
        assert_eq!(cfg.url, PROWLARR_DEFAULT_URL);
        assert!(cfg.base_url_allowed());
    }

    #[test]
    fn ssrf_barra_scheme_nao_http() {
        let cfg = ProwlarrConfig {
            url: "file:///etc/passwd".into(),
            ..ProwlarrConfig::default()
        };
        assert!(!cfg.base_url_allowed());
    }
}
