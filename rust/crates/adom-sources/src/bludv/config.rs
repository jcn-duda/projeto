//! Configuração do cliente BLUDV — knobs de `src/config/providers.ts` e
//! `src/config/cache.ts`.

use std::fmt;

use adom_core::is_safe_download_url;

/// Host canônico do site (mesmo default do resolvedor).
pub const BLUDV_DEFAULT_URL: &str = "https://bludvfilmes.xyz";

/// Timeout padrão (`BLUDV_TIMEOUT_MS`).
pub const BLUDV_DEFAULT_TIMEOUT_MS: u64 = 8_000;

/// TTL do `raw:v1` BR (`RAW_CACHE_TTL_BR`), como no Node.
pub const BLUDV_RAW_TTL_BR: u64 = 1_800;

/// TTL do vazio (`RAW_CACHE_EMPTY_TTL`): 200/403 disfarçado não pode congelar.
pub const BLUDV_RAW_EMPTY_TTL: u64 = 120;

/// Teto de itens por entrada bruta (`RAW_CACHE_MAX_ITEMS`); 0 desliga o cache.
pub const BLUDV_RAW_MAX_ITEMS: usize = 120;

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
    /// SSRF: default `false`. `true` só amplia a **origem da base**
    /// (loopback de teste / instalador) — hops de post/protetor/redirect fora
    /// dela continuam sob `is_safe_download_url(..., false)`.
    pub allow_private_url: bool,
    /// TTL do `raw:v1` com itens (`RAW_CACHE_TTL_BR`).
    pub raw_ttl_br: u64,
    /// TTL do `raw:v1` vazio (`RAW_CACHE_EMPTY_TTL`); 0 = vazio não cacheia.
    pub raw_empty_ttl: u64,
    /// Teto de itens para gravar o `raw:v1`; 0 = cache bruto desligado.
    pub raw_max_items: usize,
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
            raw_ttl_br: BLUDV_RAW_TTL_BR,
            raw_empty_ttl: BLUDV_RAW_EMPTY_TTL,
            raw_max_items: BLUDV_RAW_MAX_ITEMS,
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
            raw_ttl_br: env_u64("RAW_CACHE_TTL_BR").unwrap_or(BLUDV_RAW_TTL_BR),
            raw_empty_ttl: env_u64("RAW_CACHE_EMPTY_TTL").unwrap_or(BLUDV_RAW_EMPTY_TTL),
            raw_max_items: env_u64("RAW_CACHE_MAX_ITEMS").unwrap_or(BLUDV_RAW_MAX_ITEMS as u64)
                as usize,
        }
    }

    pub fn base_url_allowed(&self) -> bool {
        is_safe_download_url(&self.base_url, self.allow_private_url)
    }

    /// Cache bruto utilizável? Mesma régua do Node (`ttlBr > 0 && maxItems > 0`).
    pub fn raw_cache_enabled(&self) -> bool {
        self.raw_ttl_br > 0 && self.raw_max_items > 0
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
            .field("raw_ttl_br", &self.raw_ttl_br)
            .field("raw_empty_ttl", &self.raw_empty_ttl)
            .field("raw_max_items", &self.raw_max_items)
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
        assert!(cfg.raw_cache_enabled());
    }
}
