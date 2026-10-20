//! Cache dos metadados: trait injetável + implementação em memória.
//!
//! A regra do oráculo é a mesma do TMDB: **TTL longo SÓ quando as consultas
//! responderam de verdade** (`ok:true`). Falha/timeout é degradação e vai para
//! o TTL curto (`retry_ttl_secs`), senão um blip congelaria o título por 7 dias.
//! Por isso o valor de coleção/data carrega `ok` junto: quem lê o cache sabe se
//! aquela ausência é autoritativa ou só degradação.
//!
//! O store recebe `now_ms` por parâmetro (mesmo padrão do `SwrStore` do
//! `adom-search`): o TTL é testável sem dormir e o produtor pode plugar SQLite
//! depois sem mudar a régua.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::types::{CinemetaMeta, CollectionInfo, MediaType, Titles};

/// Valor gravado no cache. O `Option` interno é o MISS: `None` é "a API não
/// conhece" (negativo), nunca "não consultei".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CacheValue {
    /// Meta do Cinemeta (`None` = miss autoritativo ou transitório, o TTL
    /// gravado é que distingue).
    Cinemeta(Option<CinemetaMeta>),
    /// Títulos do TMDB (`None` = miss).
    Titles(Option<Titles>),
    /// Leitura da coleção com o flag de resposta autoritativa.
    Collection(CollectionRead),
    /// Leitura da data doméstica com o flag de resposta autoritativa.
    HomeRelease(HomeReleaseRead),
}

/// `getCollection`: `ok:true` (mesmo sem coleção) pode ir para o TTL longo;
/// `ok:false` é falha e só vale `retry_ttl_secs`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CollectionRead {
    pub info: Option<CollectionInfo>,
    pub ok: bool,
}

/// `getHomeReleaseAt`: mesma distinção de autoritativa × falha.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HomeReleaseRead {
    /// Epoch ms do 1º lançamento doméstico; `None` = sem data/obra.
    pub at: Option<i64>,
    pub ok: bool,
}

/// Cache injetável. `now_ms` é epoch ms e o TTL é em segundos, como no
/// `cache.set(key, value, ttlSeconds)` do TS.
pub trait MetaStore: Send + Sync {
    /// Entrada viva (TTL não vencido). `None` também cobre chave inexistente.
    fn get(&self, key: &str, now_ms: i64) -> Option<CacheValue>;

    /// Grava com TTL. `ttl_seconds == 0` desliga a escrita (semântica do TS).
    fn set(&self, key: &str, value: CacheValue, ttl_seconds: u64, now_ms: i64);
}

/// Implementação em memória (testes e fatia sem persistência).
#[derive(Default)]
pub struct MemoryMetaStore {
    inner: Mutex<HashMap<String, MemoryRecord>>,
}

#[derive(Debug, Clone)]
struct MemoryRecord {
    value: CacheValue,
    expires_at_ms: i64,
}

impl MemoryMetaStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("store envenenado").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl MetaStore for MemoryMetaStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<CacheValue> {
        let mut map = self.inner.lock().expect("store envenenado");
        let record = map.get(key)?;
        // Vencido é lixo: apaga na leitura, como o `forget` do SWR.
        if now_ms >= record.expires_at_ms {
            map.remove(key);
            return None;
        }
        Some(record.value.clone())
    }

    fn set(&self, key: &str, value: CacheValue, ttl_seconds: u64, now_ms: i64) {
        if ttl_seconds == 0 {
            return;
        }
        let expires_at_ms = now_ms.saturating_add(ttl_seconds.saturating_mul(1_000) as i64);
        self.inner.lock().expect("store envenenado").insert(
            key.to_string(),
            MemoryRecord {
                value,
                expires_at_ms,
            },
        );
    }
}

/// Store do cache bruto `raw:v1` (o `cache.get`/`cache.set` do Node).
///
/// O valor é o `serde_json::Value` que o Node grava (`{"items":[…]}`), não um
/// tipo do cliente: a mesma tabela `cache` (`key`, `value`, `expires_at`) é
/// compartilhada entre Node e gateway, e o namespace é versionado em
/// `adom_core::cache_key("raw", …)`.
///
/// `now_ms` entra por parâmetro (mesma razão do [`MetaStore`]): o TTL é
/// testável sem dormir.
pub trait RawStore: Send + Sync {
    /// Entrada VIVA (TTL não vencido); `None` = miss/expirada.
    fn get(&self, key: &str, now_ms: i64) -> Option<Value>;

    /// Grava com TTL em segundos. `ttl_seconds == 0` desliga a escrita.
    fn set(&self, key: &str, value: &Value, ttl_seconds: u64, now_ms: i64);
}

/// `RawStore` em memória, para testes e para o caminho sem SQLite.
#[derive(Default)]
pub struct MemoryRawStore {
    inner: Mutex<HashMap<String, RawRecord>>,
}

#[derive(Debug, Clone)]
struct RawRecord {
    value: Value,
    expires_at_ms: i64,
}

impl MemoryRawStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().expect("store envenenado").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Chaves vivas em ordem estável (diagnóstico/teste do formato da chave).
    pub fn keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .inner
            .lock()
            .expect("store envenenado")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        keys
    }
}

impl RawStore for MemoryRawStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<Value> {
        let mut map = self.inner.lock().expect("store envenenado");
        let record = map.get(key)?;
        if now_ms >= record.expires_at_ms {
            map.remove(key);
            return None;
        }
        Some(record.value.clone())
    }

    fn set(&self, key: &str, value: &Value, ttl_seconds: u64, now_ms: i64) {
        if ttl_seconds == 0 {
            return;
        }
        let expires_at_ms = now_ms.saturating_add(ttl_seconds.saturating_mul(1_000) as i64);
        self.inner.lock().expect("store envenenado").insert(
            key.to_string(),
            RawRecord {
                value: value.clone(),
                expires_at_ms,
            },
        );
    }
}

/// `cache.set` com o `ttl > 0` do TS centralizado (o store também barra, mas
/// quem grava não pode registrar um set que "não aconteceu").
pub(crate) fn set_cached(
    store: &dyn MetaStore,
    key: &str,
    value: CacheValue,
    ttl_seconds: u64,
    now_ms: i64,
) {
    if ttl_seconds > 0 {
        store.set(key, value, ttl_seconds, now_ms);
    }
}

/// Espelho READ-ONLY de um [`MetaStore`]: lê o cache do Node (warm) e nunca
/// grava. É o store da referência NATIVA na sombra de metadados — comparar não
/// pode alterar o que o caminho de resposta lê depois.
pub struct ReadOnlyMetaStore {
    inner: Arc<dyn MetaStore>,
}

impl ReadOnlyMetaStore {
    pub fn new(inner: Arc<dyn MetaStore>) -> Self {
        Self { inner }
    }
}

impl MetaStore for ReadOnlyMetaStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<CacheValue> {
        self.inner.get(key, now_ms)
    }

    fn set(&self, _key: &str, _value: CacheValue, _ttl_seconds: u64, _now_ms: i64) {
        // Compare-only: nenhuma escrita, nem negativa.
    }
}

// As chaves são as do TS — o operador reconhece e a migração pode compartilhar
// o mesmo banco mais tarde sem tradução.
pub(crate) fn cinemeta_key(media_type: MediaType, imdb: &str) -> String {
    format!("meta:{}:{imdb}", media_type.as_str())
}

pub(crate) fn titles_key(imdb: &str) -> String {
    format!("tmdb:{imdb}")
}

pub(crate) fn collection_key(imdb: &str) -> String {
    format!("tmdbc:{imdb}")
}

pub(crate) fn home_release_key(imdb: &str) -> String {
    format!("tmdbh:{imdb}")
}
