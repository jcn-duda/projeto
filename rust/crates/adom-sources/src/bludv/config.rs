//! Configuração do cliente BLUDV — knobs de `src/config/providers.ts`.

use std::fmt;

use adom_core::is_safe_download_url;

/// Host canônico do site (mesmo default do resolvedor).
pub const BLUDV_DEFAULT_URL: &str = "https://bludvfilmes.xyz";

/// Timeout padrão (`BLUDV_TIMEOUT_MS`).
pub const BLUDV_DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// UA Chrome-like do scraper TS.
pub const BLUDV_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

/// Configuração da busca WordPress do BLUDV.
#[derive(Clone, PartialEq, Eq)]
pub struct BludvConfig {
    /// Kill-switch (`BLUDV_ENABLED`, default **off**).
    pub enabled: bool,
    /// Base (`BLUDV_URL`), sem barra final.
    pub base_url: String,
    pub max_posts: usize,
    pub max_links_per_post: usize,
    pub concurrency: usize,
    pub timeout_ms: u64,
    /// SSRF da base: default `false`. Testes loopback = `true`.
    pub allow_private_url: bool,
}

impl Default for BludvConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: BLUDV_DEFAULT_URL.to_string(),
            max_posts: 3,
            max_links_per_post: 12,
            concurrency: 6,
            timeout_ms: BLUDV_DEFAULT_TIMEOUT_MS,
            allow_private_url: false,
        }
    }
}

impl BludvConfig {
    pub fn from_env() -> Self {
        let enabled = env_trim("BLUDV_ENABLED")
            .map(|raw| raw.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        let base_url = env_trim("BLUDV_URL")
            .unwrap_or_else(|| BLUDV_DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        Self {
            enabled,
            base_url,
            max_posts: env_u64("BLUDV_MAX_POSTS").unwrap_or(3).max(1) as usize,
            max_links_per_post: env_u64("BLUDV_MAX_LINKS").unwrap_or(12).max(1) as usize,
            concurrency: env_u64("BLUDV_CONCURRENCY").unwrap_or(6).max(1) as usize,
            timeout_ms: env_u64("BLUDV_TIMEOUT_MS")
                .unwrap_or(BLUDV_DEFAULT_TIMEOUT_MS)
                .max(1),
            allow_private_url: false,
        }
    }

    pub fn base_url_allowed(&self) -> bool {
        is_safe_download_url(&self.base_url, self.allow_private_url)
    }
}

impl fmt::Debug for BludvConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BludvConfig")
            .field("enabled", &self.enabled)
            .field("base_url", &self.base_url)
            .field("max_posts", &self.max_posts)
            .field("max_links_per_post", &self.max_links_per_post)
            .field("concurrency", &self.concurrency)
            .field("timeout_ms", &self.timeout_ms)
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
    fn default_desligado() {
        let cfg = BludvConfig::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.base_url, BLUDV_DEFAULT_URL);
        assert!(cfg.base_url_allowed());
    }
}
