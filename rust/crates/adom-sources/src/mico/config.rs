//! Configuração do cliente Mico — knobs de `src/config/providers.ts` (busca).
//!
//! Crawl-only (gap, pages, full-sweep) fica fora: este módulo é o card virtual
//! de indexer consultado por IMDb.

use std::fmt;

use adom_core::is_safe_download_url;

/// Host canônico do addon público.
pub const MICO_DEFAULT_URL: &str = "https://mico-leao-dublado-apiv-2.vercel.app";

/// Timeout padrão (`MICO_TIMEOUT_MS`).
pub const MICO_DEFAULT_TIMEOUT_MS: u64 = 15_000;

/// Id do card virtual (fora das listas que viram consulta Jackett).
pub const MICO_ID: &str = "mico";

/// Configuração da busca ao vivo do Mico.
#[derive(Clone, PartialEq, Eq)]
pub struct MicoConfig {
    /// Kill-switch (`MICO_ENABLED`, default ligado).
    pub enabled: bool,
    /// Base (`MICO_URL`), sem barra final.
    pub url: String,
    pub timeout_ms: u64,
    pub breaker_failures: u32,
    pub breaker_cooldown_ms: u64,
    /// SSRF da base: default `false`. Testes loopback = `true`.
    pub allow_private_url: bool,
}

impl Default for MicoConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            url: MICO_DEFAULT_URL.to_string(),
            timeout_ms: MICO_DEFAULT_TIMEOUT_MS,
            breaker_failures: 3,
            breaker_cooldown_ms: 10 * 60_000,
            allow_private_url: false,
        }
    }
}

impl MicoConfig {
    pub fn from_env() -> Self {
        let enabled = env_trim("MICO_ENABLED")
            .map(|raw| !raw.eq_ignore_ascii_case("false"))
            .unwrap_or(true);
        let url = env_trim("MICO_URL")
            .unwrap_or_else(|| MICO_DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        Self {
            enabled,
            url,
            timeout_ms: env_u64("MICO_TIMEOUT_MS")
                .unwrap_or(MICO_DEFAULT_TIMEOUT_MS)
                .max(1),
            breaker_failures: env_u64("MICO_BREAKER_FAILURES")
                .map(|n| n.max(1) as u32)
                .unwrap_or(3),
            breaker_cooldown_ms: env_u64("MICO_BREAKER_COOLDOWN_MS").unwrap_or(10 * 60_000),
            allow_private_url: false,
        }
    }

    /// Base http(s) segura para o GET. Fail-closed em scheme/host inválidos.
    pub fn base_url_allowed(&self) -> bool {
        is_safe_download_url(&self.url, self.allow_private_url)
    }
}

impl fmt::Debug for MicoConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MicoConfig")
            .field("enabled", &self.enabled)
            .field("url", &self.url)
            .field("timeout_ms", &self.timeout_ms)
            .field("breaker_failures", &self.breaker_failures)
            .field("breaker_cooldown_ms", &self.breaker_cooldown_ms)
            .field("allow_private_url", &self.allow_private_url)
            .finish()
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
    fn default_ligado_com_url_publica() {
        let cfg = MicoConfig::default();
        assert!(cfg.enabled);
        assert_eq!(cfg.url, MICO_DEFAULT_URL);
        assert!(cfg.base_url_allowed());
    }

    #[test]
    fn ssrf_barra_loopback_sem_allow_private() {
        let cfg = MicoConfig {
            url: "http://127.0.0.1:9999".into(),
            ..MicoConfig::default()
        };
        assert!(!cfg.base_url_allowed());
        let ok = MicoConfig {
            allow_private_url: true,
            ..cfg
        };
        assert!(ok.base_url_allowed());
    }
}
