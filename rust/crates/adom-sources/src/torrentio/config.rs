//! Configuração do cliente Torrentio — mesmos knobs de `src/config/providers.ts`.
//!
//! Sem credencial: a URL pública NUNCA recebe segmento `realdebrid=` / apiKey.
//! Base configurável passa por guarda SSRF (`is_safe_download_url`); privado
//! barrado por default (host público). Testes com axum em loopback ligam
//! `allow_private_url`.

use std::fmt;

use adom_core::is_safe_download_url;

/// Host canônico do pool público.
pub const TORRENTIO_DEFAULT_URL: &str = "https://torrentio.strem.fun";

/// Timeout curto do oráculo (`TORRENTIO_TIMEOUT_MS`).
pub const TORRENTIO_DEFAULT_TIMEOUT_MS: u64 = 1_500;

/// Configuração do pool GLOBAL Torrentio (Fase 1).
#[derive(Clone, PartialEq, Eq)]
pub struct TorrentioConfig {
    /// Kill-switch da fonte (`TORRENTIO_ENABLED`).
    pub enabled: bool,
    /// Só o padrão de instalação nova (`TORRENTIO_DEFAULT`); não afeta o
    /// cliente HTTP — o collect decide se injeta o provider.
    pub default_on: bool,
    /// Base (`TORRENTIO_URL`), sem barra final.
    pub url: String,
    pub timeout_ms: u64,
    pub breaker_failures: u32,
    pub breaker_cooldown_ms: u64,
    /// SSRF da base: default `false` (host público). Testes loopback = `true`.
    pub allow_private_url: bool,
}

impl Default for TorrentioConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            default_on: false,
            url: TORRENTIO_DEFAULT_URL.to_string(),
            timeout_ms: TORRENTIO_DEFAULT_TIMEOUT_MS,
            breaker_failures: 3,
            breaker_cooldown_ms: 5 * 60_000,
            allow_private_url: false,
        }
    }
}

impl TorrentioConfig {
    pub fn from_env() -> Self {
        let enabled = env_trim("TORRENTIO_ENABLED")
            .map(|raw| raw.eq_ignore_ascii_case("true"))
            .unwrap_or(true);
        let default_on = env_trim("TORRENTIO_DEFAULT")
            .map(|raw| raw.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let url = env_trim("TORRENTIO_URL")
            .unwrap_or_else(|| TORRENTIO_DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        Self {
            enabled,
            default_on,
            url,
            timeout_ms: env_u64("TORRENTIO_TIMEOUT_MS")
                .unwrap_or(TORRENTIO_DEFAULT_TIMEOUT_MS)
                .max(1),
            breaker_failures: env_u64("TORRENTIO_BREAKER_FAILURES")
                .map(|n| n.max(1) as u32)
                .unwrap_or(3),
            breaker_cooldown_ms: env_u64("TORRENTIO_BREAKER_COOLDOWN_MS").unwrap_or(5 * 60_000),
            allow_private_url: false,
        }
    }

    /// Base http(s) segura para o GET. Fail-closed em scheme/host inválidos.
    pub fn base_url_allowed(&self) -> bool {
        is_safe_download_url(&self.url, self.allow_private_url)
    }
}

impl fmt::Debug for TorrentioConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TorrentioConfig")
            .field("enabled", &self.enabled)
            .field("default_on", &self.default_on)
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
    fn default_fora_dos_defaults_de_instalacao() {
        let cfg = TorrentioConfig::default();
        assert!(cfg.enabled);
        assert!(!cfg.default_on);
        assert_eq!(cfg.url, TORRENTIO_DEFAULT_URL);
        assert!(cfg.base_url_allowed());
    }

    #[test]
    fn ssrf_barra_loopback_sem_allow_private() {
        let cfg = TorrentioConfig {
            url: "http://127.0.0.1:9999".into(),
            ..TorrentioConfig::default()
        };
        assert!(!cfg.base_url_allowed());
        let ok = TorrentioConfig {
            allow_private_url: true,
            ..cfg
        };
        assert!(ok.base_url_allowed());
    }
}
