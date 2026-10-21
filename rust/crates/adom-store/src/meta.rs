//! Persistência SQLite dos metadados (`meta:`, `tmdb:`, `tmdbc:`, `tmdbh:`) no
//! MESMO `cache.db` do Node.
//!
//! O caminho nativo (`META_RUST`) não pode viver de memória: meta/títulos que
//! sobrevivem ao restart são a diferença entre a primeira busca depois de uma
//! queda pagar Cinemeta + TMDB de novo (e o título pt-BR, que destrava os
//! indexadores BR, chegar atrasado) ou nascer quente. Mais importante: os
//! VALORES gravados são os do Node, campo a campo.
//!
//! Compatibilidade nos dois sentidos (o operador roda os dois caminhos):
//!
//! | chave | valor do Node | leitura nativa |
//! |---|---|---|
//! | `meta:{tipo}:{imdb}` | `{name, year, type, episodes?, released?, firstAired?, episodeAired?, __metaV:2}` ou `{miss:true}` | exige `__metaV:2`; entrada antiga é MISS (o Node também reconsulta uma vez) |
//! | `tmdb:{imdb}` | `{pt, original, en, br, year}` ou `{miss:true}` | sem `en`/`br` é MISS (mesma regra do `getTitles`) |
//! | `tmdbc:{imdb}` | `{info}` (`info:null` = sem coleção) ou `{miss:true}` | `info` é autoritativo |
//! | `tmdbh:{imdb}` | `{at}` (`at:null` = sem data/falha) | `at` |
//!
//! O TTL é gravado em `expires_at` como no `cache-db.ts`; a leitura apaga o
//! vencido, como o L2 do Node. A cota por namespace é a mesma
//! (`adom_core::quota_for`), com despejo do que expira primeiro — o store NUNCA
//! toca chave de outro namespace.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use adom_core::quota_for;
use adom_sources::{
    CacheValue, CinemetaMeta, CollectionInfo, CollectionRead, HomeReleaseRead, MediaType,
    MetaStore, Titles,
};
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};

use crate::raw::{cache_db_path, cache_persist};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
";

/// Versão do formato de `meta:` — a MESMA marca do `cinemeta.ts` (META_SCHEMA).
/// É o que faz o Node servir uma entrada gravada pelo Rust sem reconsultar.
const META_SCHEMA: i64 = 2;

/// Namespace de uma chave de metadados. `None` = não é deste store.
pub fn meta_namespace(key: &str) -> Option<&'static str> {
    ["meta", "tmdb", "tmdbc", "tmdbh"]
        .into_iter()
        .find(|namespace| {
            key.strip_prefix(*namespace)
                .is_some_and(|rest| rest.starts_with(':'))
        })
}

/// Banco SQLite dos metadados (compartilhado com o `cache.db` do Node).
pub struct MetaCacheStore {
    conn: Mutex<Connection>,
}

impl MetaCacheStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do meta store: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir meta store: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema meta store: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// `CACHE_PERSIST=false` desliga o disco; o caminho é `CACHE_DB_PATH`
    /// (default `data/cache.db`), como no [`crate::RawCacheStore`].
    pub fn from_env() -> Result<Self, String> {
        if !cache_persist() {
            eprintln!("[gateway] CACHE_PERSIST=false; metadados só em memória");
            return Self::open_memory();
        }
        Self::open(&cache_db_path())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    fn read_value(&self, key: &str, now_ms: i64) -> Option<Value> {
        let conn = self.lock();
        let row = read_row(&conn, key)?;
        let (raw, expires_at) = row;
        if expires_at <= now_ms {
            let _ = conn.execute("DELETE FROM cache WHERE key = ?1", params![key]);
            return None;
        }
        match serde_json::from_str::<Value>(&raw) {
            Ok(value) => Some(value),
            Err(err) => {
                eprintln!("[gateway] meta cache: valor inválido em {key}: {err}");
                None
            }
        }
    }

    fn write_value(
        &self,
        key: &str,
        value: &Value,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        let namespace = meta_namespace(key)
            .ok_or_else(|| format!("chave fora dos namespaces de metadados: {key}"))?;
        if ttl_seconds == 0 {
            return Ok(());
        }
        let expires_at = now_ms.saturating_add(ttl_seconds.saturating_mul(1_000) as i64);
        let encoded = serde_json::to_string(value).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&conn, namespace, now_ms)?;
        Ok(())
    }

    /// `true` quando a chave pertence a um namespace de metadados.
    pub fn owns(key: &str) -> bool {
        meta_namespace(key).is_some()
    }

    pub fn len(&self) -> Result<usize, String> {
        let conn = self.lock();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE key LIKE 'meta:%' OR key LIKE 'tmdb:%'
                 OR key LIKE 'tmdbc:%' OR key LIKE 'tmdbh:%'",
                [],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        Ok(n as usize)
    }

    pub fn is_empty(&self) -> Result<bool, String> {
        Ok(self.len()? == 0)
    }
}

impl MetaStore for MetaCacheStore {
    fn get(&self, key: &str, now_ms: i64) -> Option<CacheValue> {
        let namespace = meta_namespace(key)?;
        let value = self.read_value(key, now_ms)?;
        decode(namespace, &value)
    }

    fn set(&self, key: &str, value: CacheValue, ttl_seconds: u64, now_ms: i64) {
        let Some(namespace) = meta_namespace(key) else {
            eprintln!("[gateway] meta cache: chave fora do namespace ignorada: {key}");
            return;
        };
        match encode(namespace, &value) {
            Ok(encoded) => {
                if let Err(err) = self.write_value(key, &encoded, ttl_seconds, now_ms) {
                    eprintln!("[gateway] meta cache não gravou {key}: {err}");
                }
            }
            Err(err) => eprintln!("[gateway] meta cache: {key}: {err}"),
        }
    }
}

// ── Codificação (tipo → JSON do Node) ───────────────────────────────────────

fn encode(namespace: &str, value: &CacheValue) -> Result<Value, String> {
    match (namespace, value) {
        ("meta", CacheValue::Cinemeta(meta)) => Ok(match meta {
            Some(meta) => encode_cinemeta(meta),
            None => json!({ "miss": true }),
        }),
        ("tmdb", CacheValue::Titles(titles)) => Ok(match titles {
            Some(titles) => encode_titles(titles),
            None => json!({ "miss": true }),
        }),
        ("tmdbc", CacheValue::Collection(read)) => Ok(if !read.ok {
            // Falha: o Node grava `{miss:true}` com TTL curto. `ok:true`
            // SEM coleção é ausência autoritativa e vai como `info:null`.
            json!({ "miss": true })
        } else {
            json!({ "info": read.info.as_ref().map(encode_collection) })
        }),
        ("tmdbh", CacheValue::HomeRelease(read)) => Ok(json!({ "at": read.at })),
        (namespace, _) => Err(format!("valor incompatível com o namespace {namespace}")),
    }
}

fn encode_cinemeta(meta: &CinemetaMeta) -> Value {
    let mut out = Map::new();
    if let Some(name) = &meta.name {
        out.insert("name".into(), json!(name));
    }
    if let Some(year) = &meta.year {
        out.insert("year".into(), json!(year));
    }
    out.insert("type".into(), json!(meta.media_type.as_str()));
    if meta.media_type.is_series() {
        // Série SEMPRE leva `episodes` (mesmo `{}`): o `getMeta` do Node só
        // serve do cache uma série com o campo presente.
        let episodes: Map<String, Value> = meta
            .episodes_by_season
            .iter()
            .map(|(season, count)| (season.to_string(), json!(count)))
            .collect();
        out.insert("episodes".into(), Value::Object(episodes));
    }
    if let Some(released) = &meta.released {
        out.insert("released".into(), json!(released));
    }
    if let Some(first_aired) = &meta.first_aired {
        out.insert("firstAired".into(), json!(first_aired));
    }
    if !meta.episode_aired.is_empty() {
        let aired: Map<String, Value> = meta
            .episode_aired
            .iter()
            .map(|aired| {
                (
                    format!("{}:{}", aired.season, aired.episode),
                    json!(aired.date),
                )
            })
            .collect();
        out.insert("episodeAired".into(), Value::Object(aired));
    }
    out.insert("__metaV".into(), json!(META_SCHEMA));
    Value::Object(out)
}

fn encode_titles(titles: &Titles) -> Value {
    // Exatamente as cinco chaves do `getTitles`: `en` e `br` são o marcador de
    // formato (entrada sem eles é MISS lá e aqui).
    json!({
        "pt": titles.pt,
        "original": titles.original,
        "en": titles.en,
        "br": titles.aliases_br,
        "year": titles.year,
    })
}

fn encode_collection(info: &CollectionInfo) -> Value {
    json!({ "name": info.name, "root": info.root, "years": info.years })
}

// ── Decodificação (JSON do Node → tipo) ─────────────────────────────────────

fn decode(namespace: &str, value: &Value) -> Option<CacheValue> {
    match namespace {
        "meta" => decode_cinemeta(value).map(CacheValue::Cinemeta),
        "tmdb" => decode_titles(value).map(CacheValue::Titles),
        "tmdbc" => Some(CacheValue::Collection(CollectionRead {
            info: decode_collection(value),
            ok: true,
        })),
        "tmdbh" => Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: value.get("at").and_then(Value::as_i64),
            ok: true,
        })),
        _ => None,
    }
}

fn is_miss(value: &Value) -> bool {
    value.get("miss").and_then(Value::as_bool).unwrap_or(false)
}

fn decode_cinemeta(value: &Value) -> Option<Option<CinemetaMeta>> {
    if is_miss(value) {
        return Some(None);
    }
    // Formato anterior ao `__metaV` (ou gravado por outra ferramenta): o Node
    // reconsulta UMA vez e regrava; aqui vira MISS pelo mesmo motivo — não
    // servir metadado sem as datas que a guarda de pré-air consome.
    if value.get("__metaV").and_then(Value::as_i64) != Some(META_SCHEMA) {
        return None;
    }
    let media_type = value
        .get("type")
        .and_then(Value::as_str)
        .and_then(MediaType::parse)
        .unwrap_or(MediaType::Movie);
    let episodes_by_season = value
        .get("episodes")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(season, count)| season.parse::<i64>().ok().zip(count.as_i64()))
                .collect()
        })
        .unwrap_or_default();
    let episode_aired = value
        .get("episodeAired")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, date)| {
                    let (season, episode) = key.split_once(':')?;
                    Some(adom_sources::EpisodeAired {
                        season: season.parse().ok()?,
                        episode: episode.parse().ok()?,
                        date: date.as_str().filter(|s| !s.is_empty())?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Some(CinemetaMeta {
        name: nonempty(value.get("name")),
        year: nonempty(value.get("year")),
        media_type,
        episodes_by_season,
        released: nonempty(value.get("released")),
        first_aired: nonempty(value.get("firstAired")),
        episode_aired,
    }))
}

fn decode_titles(value: &Value) -> Option<Option<Titles>> {
    if is_miss(value) {
        return Some(None);
    }
    let object = value.as_object()?;
    // `getTitles` trata entrada sem `en`/`br` (ou com o campo legado `aliases`)
    // como MISS: o canônico inglês e os aliases BR mudam o recall e não podem
    // ficar congelados no TTL longo por um formato velho.
    if !object.contains_key("en") || !object.contains_key("br") || object.contains_key("aliases") {
        return None;
    }
    let aliases_br = object
        .get("br")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|alias| !alias.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(Some(Titles {
        pt: nonempty(object.get("pt")),
        original: nonempty(object.get("original")),
        en: nonempty(object.get("en")),
        aliases_br,
        year: nonempty(object.get("year")),
        // O Node não persiste estes campos; só o cliente em memória os tem.
        original_language: None,
        tmdb_id: None,
        is_series: false,
    }))
}

fn decode_collection(value: &Value) -> Option<CollectionInfo> {
    let info = value.get("info")?;
    if info.is_null() {
        return None;
    }
    let name = info
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let root = info
        .get("root")
        .and_then(Value::as_str)
        .filter(|root| !root.is_empty())
        .map(str::to_string)?;
    let years = info
        .get("years")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    Some(CollectionInfo { name, root, years })
}

fn nonempty(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn read_row(conn: &Connection, key: &str) -> Option<(String, i64)> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .ok()?;
    stmt.query_row(params![key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })
    .ok()
}

/// Fora do TTL some; acima da cota o que expira primeiro cede lugar. Escopo do
/// NAMESPACE (`meta:` etc.), como o `enforceQuota` do Node — nenhuma chave de
/// outro namespace é apagada.
fn enforce_quota(conn: &Connection, namespace: &str, now_ms: i64) -> Result<(), String> {
    let prefix = format!("{namespace}:");
    let quota = quota_for(namespace) as i64;
    conn.execute(
        "DELETE FROM cache WHERE expires_at <= ?1 AND substr(key, 1, length(?2)) = ?2",
        params![now_ms, prefix],
    )
    .map_err(|err| err.to_string())?;
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            params![prefix],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let extra = count - quota;
    if extra <= 0 {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM cache WHERE key IN (
            SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1
            ORDER BY expires_at ASC LIMIT ?2
        )",
        params![prefix, extra],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// Caminho default do `cache.db` (diagnóstico/teste do `from_env`).
pub fn default_cache_db_path() -> PathBuf {
    cache_db_path()
}

#[cfg(test)]
#[path = "meta_tests.rs"]
mod tests;
