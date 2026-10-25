//! Cache da busca por TÍTULO e do `external_ids` do TMDB.
//!
//! Separado de `search.rs` pela catraca de linhas. O `MetaStore` do crate não
//! serve aqui: ele carrega o formato do `/find` (`CacheValue::Titles`) e o
//! valor da busca é outro (hits crus + `ok`). O cache vive na instância do
//! [`super::TmdbClient`], então cada cliente de teste nasce limpo.
//!
//! TTL (mesma régua do TS): `hits` não vazio → `cache_ttl_secs`; busca vazia
//! AUTORITATIVA → `miss_ttl_secs` (o TMDB ganha obras o tempo todo e a página
//! raspada é permanente, então o vazio não pode congelar por 7 dias); falha →
//! `retry_ttl_secs()`. `ttl == 0` desliga a escrita, como no `cache.set` do TS.

use std::collections::HashMap;
use std::sync::Mutex;

use adom_core::normalize_title;

use super::search::{ExternalImdbResult, SearchFuture, SearchWorkType, TmdbSearchResult};
use super::TmdbClient;
use crate::http::now_ms;

/// O que o cache guarda (duas leituras, uma tabela).
#[derive(Debug, Clone)]
pub(crate) enum CachedRead {
    Search(TmdbSearchResult),
    External(ExternalImdbResult),
}

struct CacheEntry {
    value: CachedRead,
    expires_at_ms: i64,
}

/// Cache em memória da instância. Mutex envenenado NÃO derruba a raspagem: o
/// estado é descartável, então o guard é recuperado em vez de `expect`.
#[derive(Default)]
pub(crate) struct SearchCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

impl SearchCache {
    pub(crate) fn get(&self, key: &str, now: i64) -> Option<CachedRead> {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let entry = entries.get(key)?;
        if now >= entry.expires_at_ms {
            entries.remove(key);
            return None;
        }
        Some(entry.value.clone())
    }

    pub(crate) fn set(&self, key: &str, value: CachedRead, ttl_secs: u64, now: i64) {
        if ttl_secs == 0 {
            return;
        }
        let expires_at_ms = now.saturating_add(ttl_secs.saturating_mul(1_000) as i64);
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.insert(
            key.to_string(),
            CacheEntry {
                value,
                expires_at_ms,
            },
        );
    }
}

/// Chave do cache compartilhada por grafia: acento/caixa/pontuação não mudam a
/// busca (mesma normalização do filtro de título do addon).
fn search_cache_key(kind: SearchWorkType, title: &str) -> String {
    let norm = normalize_title(title);
    format!(
        "tmdb:search:{}:{}",
        kind.label(),
        if norm.is_empty() { "vazio" } else { &norm }
    )
}

/// `tmdb:ext:{tipo}:{id}` — cache de `external_ids` nunca cruza tipos (o id
/// numérico do TMDB colide entre filme e série: são espaços distintos).
fn external_cache_key(kind: SearchWorkType, tmdb_id: u64) -> String {
    format!("tmdb:ext:{}:{tmdb_id}", kind.label())
}

impl super::search::TmdbSearchApi for TmdbClient {
    fn search<'a>(
        &'a self,
        kind: SearchWorkType,
        title: &'a str,
    ) -> SearchFuture<'a, TmdbSearchResult> {
        Box::pin(async move {
            if !self.config.has_api_key() || title.trim().is_empty() {
                return TmdbSearchResult::default();
            }
            let key = search_cache_key(kind, title);
            let now = now_ms();
            if let Some(CachedRead::Search(cached)) = self.search_cache.get(&key, now) {
                return cached;
            }
            let result = self.fetch_search(kind, title).await;
            let ttl = if result.ok {
                if result.hits.is_empty() {
                    self.config.miss_ttl_secs
                } else {
                    self.config.cache_ttl_secs
                }
            } else {
                self.config.retry_ttl_secs()
            };
            self.search_cache
                .set(&key, CachedRead::Search(result.clone()), ttl, now);
            result
        })
    }

    fn external_imdb<'a>(
        &'a self,
        tmdb_id: u64,
        kind: SearchWorkType,
    ) -> SearchFuture<'a, ExternalImdbResult> {
        Box::pin(async move {
            if !self.config.has_api_key() || tmdb_id == 0 {
                return ExternalImdbResult::default();
            }
            let key = external_cache_key(kind, tmdb_id);
            let now = now_ms();
            if let Some(CachedRead::External(cached)) = self.search_cache.get(&key, now) {
                return cached;
            }
            let result = self.fetch_external_imdb(tmdb_id, kind).await;
            let ttl = if result.ok {
                self.config.cache_ttl_secs
            } else {
                self.config.retry_ttl_secs()
            };
            self.search_cache
                .set(&key, CachedRead::External(result.clone()), ttl, now);
            result
        })
    }
}
