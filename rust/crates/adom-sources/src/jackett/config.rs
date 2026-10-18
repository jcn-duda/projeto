//! Configuração do cliente Jackett — mesmos knobs de `src/config/jackett.ts`.
//!
//! `api_key` NUNCA entra em `Debug`/`Display` nem em log: a chave viaja só na
//! query Torznab e some ao fim da requisição.

use std::fmt;

/// Base padrão no container único (Jackett em loopback).
pub const JACKETT_DEFAULT_URL: &str = "http://127.0.0.1:9117";

/// `User-Agent` do oráculo (`jackett.ts`).
pub const JACKETT_USER_AGENT: &str = "stremio-adom/1.0";

/// Configuração do cliente Torznab/JSON.
#[derive(Clone, PartialEq, Eq)]
pub struct JackettConfig {
    /// Base do Jackett (`JACKETT_URL`), sem barra final.
    pub url: String,
    /// `JACKETT_API_KEY`. Vazio → `search` devolve `[]` (fail-open).
    pub api_key: String,
    pub user_agent: String,
    /// Indexers da consulta ao vivo. Vazio = ramo agregado `/all`.
    pub indexers: Vec<String>,
    /// Query em pt-BR + `strip_diacritics` + token SxxEyy moldado.
    pub pt_br_indexers: Vec<String>,
    /// Isolados no plano + orçamento BR (`budget_for`).
    pub slow_indexers: Vec<String>,
    /// Ano final sai da query (`bareTitleIndexers`).
    pub bare_title_indexers: Vec<String>,
    /// Opt-in do salto `/dl` (Link → magnet).
    pub resolve_download_indexers: Vec<String>,
    pub indexer_timeout_ms: u64,
    pub br_indexer_timeout_ms: u64,
    pub download_timeout_ms: u64,
    pub max_download_resolves: usize,
    /// SSRF: permitir IP privado no `Link` de terceiro.
    pub allow_private_download_ips: bool,
    pub breaker_enabled: bool,
    pub breaker_failures: u32,
    pub breaker_cooldown_ms: u64,
}

impl Default for JackettConfig {
    fn default() -> Self {
        Self {
            url: JACKETT_DEFAULT_URL.to_string(),
            api_key: String::new(),
            user_agent: JACKETT_USER_AGENT.to_string(),
            indexers: Vec::new(),
            pt_br_indexers: default_pt_br_indexers(),
            slow_indexers: default_slow_indexers(),
            bare_title_indexers: default_bare_title_indexers(),
            resolve_download_indexers: default_resolve_download_indexers(),
            indexer_timeout_ms: 4_000,
            br_indexer_timeout_ms: 20_000,
            download_timeout_ms: 8_000,
            max_download_resolves: 20,
            allow_private_download_ips: false,
            breaker_enabled: true,
            breaker_failures: 3,
            breaker_cooldown_ms: 5 * 60_000,
        }
    }
}

impl JackettConfig {
    /// Lê `JACKETT_*` do ambiente. Ausência de chave NÃO é erro — o cliente
    /// só devolve lista vazia (mesmo contrato do TS).
    pub fn from_env() -> Self {
        let url = env_trim("JACKETT_URL")
            .unwrap_or_else(|| JACKETT_DEFAULT_URL.to_string())
            .trim_end_matches('/')
            .to_string();
        let api_key = env_trim("JACKETT_API_KEY").unwrap_or_default();
        Self {
            url,
            api_key,
            indexers: env_trim("JACKETT_INDEXERS")
                .map(|list| split_indexers(&list))
                .unwrap_or_default(),
            pt_br_indexers: env_trim("JACKETT_PT_BR_INDEXERS")
                .map(|list| split_indexers(&list))
                .unwrap_or_else(default_pt_br_indexers),
            slow_indexers: env_trim("JACKETT_SLOW_INDEXERS")
                .map(|list| split_indexers(&list))
                .unwrap_or_else(default_slow_indexers),
            bare_title_indexers: env_trim("JACKETT_BARE_TITLE_INDEXERS")
                .map(|list| split_indexers(&list))
                .unwrap_or_else(default_bare_title_indexers),
            resolve_download_indexers: env_trim("JACKETT_RESOLVE_DOWNLOAD_INDEXERS")
                .map(|list| split_indexers(&list))
                .unwrap_or_else(default_resolve_download_indexers),
            indexer_timeout_ms: env_u64("JACKETT_INDEXER_TIMEOUT_MS").unwrap_or(4_000),
            br_indexer_timeout_ms: env_u64("JACKETT_BR_INDEXER_TIMEOUT_MS").unwrap_or(20_000),
            download_timeout_ms: env_u64("JACKETT_DOWNLOAD_TIMEOUT_MS").unwrap_or(8_000),
            max_download_resolves: env_u64("JACKETT_MAX_DOWNLOAD_RESOLVES")
                .map(|n| n as usize)
                .unwrap_or(20),
            allow_private_download_ips: env_trim("JACKETT_ALLOW_PRIVATE_DOWNLOAD_IPS")
                .is_some_and(|raw| raw.eq_ignore_ascii_case("true")),
            breaker_enabled: env_trim("JACKETT_BREAKER_ENABLED")
                .map(|raw| !raw.eq_ignore_ascii_case("false"))
                .unwrap_or(true),
            breaker_failures: env_u64("JACKETT_BREAKER_FAILURES")
                .map(|n| n.max(1) as u32)
                .unwrap_or(3),
            breaker_cooldown_ms: env_u64("JACKETT_BREAKER_COOLDOWN_MS").unwrap_or(5 * 60_000),
            ..Self::default()
        }
    }

    pub fn has_api_key(&self) -> bool {
        !self.api_key.trim().is_empty()
    }

    pub fn is_br(&self, indexer: &str) -> bool {
        self.pt_br_indexers.iter().any(|id| id == indexer)
    }

    pub fn is_slow(&self, indexer: &str) -> bool {
        self.slow_indexers.iter().any(|id| id == indexer)
    }

    pub fn is_bare_title(&self, indexer: &str) -> bool {
        self.bare_title_indexers.iter().any(|id| id == indexer)
    }

    pub fn resolves_download(&self, indexer: &str) -> bool {
        self.resolve_download_indexers
            .iter()
            .any(|id| id == indexer)
    }
}

impl fmt::Debug for JackettConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JackettConfig")
            .field("url", &self.url)
            .field("api_key", &redact_secret(&self.api_key))
            .field("user_agent", &self.user_agent)
            .field("indexers", &self.indexers)
            .field("pt_br_indexers", &self.pt_br_indexers)
            .field("slow_indexers", &self.slow_indexers)
            .field("bare_title_indexers", &self.bare_title_indexers)
            .field("resolve_download_indexers", &self.resolve_download_indexers)
            .field("indexer_timeout_ms", &self.indexer_timeout_ms)
            .field("br_indexer_timeout_ms", &self.br_indexer_timeout_ms)
            .field("download_timeout_ms", &self.download_timeout_ms)
            .field("max_download_resolves", &self.max_download_resolves)
            .field(
                "allow_private_download_ips",
                &self.allow_private_download_ips,
            )
            .field("breaker_enabled", &self.breaker_enabled)
            .field("breaker_failures", &self.breaker_failures)
            .field("breaker_cooldown_ms", &self.breaker_cooldown_ms)
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

fn split_indexers(raw: &str) -> Vec<String> {
    raw.split(|c: char| c == ',' || c.is_whitespace())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn default_pt_br_indexers() -> Vec<String> {
    split_indexers(
        "bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,vacatorrent,\
         redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
    )
}

fn default_slow_indexers() -> Vec<String> {
    split_indexers(
        "bludv-cardigann,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
    )
}

fn default_bare_title_indexers() -> Vec<String> {
    split_indexers("redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann")
}

fn default_resolve_download_indexers() -> Vec<String> {
    split_indexers(
        "comandotorrents,nerdfilmes,bludv-cardigann,torrentdosfilmesv2,vacatorrent,\
         magnetdownload,limetorrents,1337x",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_nao_vaza_api_key() {
        let cfg = JackettConfig {
            api_key: "segredo-real".into(),
            ..JackettConfig::default()
        };
        let text = format!("{cfg:?}");
        assert!(!text.contains("segredo-real"));
        assert!(text.contains("***"));
    }

    #[test]
    fn url_default_e_loopback() {
        assert_eq!(JackettConfig::default().url, JACKETT_DEFAULT_URL);
    }
}
