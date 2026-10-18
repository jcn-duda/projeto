//! Normalização determinística da resposta do `/stream`.
//!
//! A comparação Node × Rust só é honesta depois de tirar do caminho o que o
//! contrato declara volátil (§9.3 de `docs/rust-stream-contract.md`):
//!
//! - **ordem da lista** de streams — ordenada por `infoHash`, `url`, `title` e
//!   `externalUrl` (o Node não promete ordem estável entre variantes);
//! - **ordem de chaves** — a forma canônica ordena chaves recursivamente;
//! - **origem/host** — `url`/`externalUrl` passam a `{{base}}` (o corpus já
//!   grava assim);
//! - **`sig`** — o valor do parâmetro vira `{{sig}}` (HMAC depende do segredo);
//! - **segmento de config** — quando a fonte injeta o segmento real, ele vira
//!   `{{config}}`;
//! - **relógio/métricas/campos internos** — chaves voláteis e `_*` saem;
//! - **`cacheMaxAge`** — fica por default (é contrato), mas pode ser mascarado
//!   para comparar a forma quando as duas pontas usam TTLs diferentes.
//!
//! A normalização é **idempotente**: normalizar a saída normalizada devolve a
//! mesma coisa. É isso que permite reusar o corpus como fonte de replay.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde_json::{Map, Value};

use crate::sha256_hex;

/// Chaves que dependem de relógio/execução e nunca entram no diff.
const VOLATILE_KEYS: &[&str] = &[
    "age",
    "capturedAt",
    "date",
    "durationMs",
    "elapsedMs",
    "etag",
    "generatedAt",
    "metrics",
    "now",
    "serverTime",
    "timing",
    "timings",
    "timestamp",
    "tookMs",
    "trace",
];

/// Opções de normalização. O default é o modo de comparação do corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizeOptions {
    /// Origem real do addon (ex.: `http://127.0.0.1:7000`), trocada por
    /// `{{base}}`. Sem ela, a origem http(s) de `url`/`externalUrl` ainda é
    /// mascarada pela detecção automática.
    pub base_url: Option<String>,
    /// Segmento base64url concreto usado no replay, trocado por `{{config}}`.
    pub config_segment: Option<String>,
    /// `sig=<valor>` → `sig={{sig}}`.
    pub mask_sig: bool,
    /// Origem http(s) de `url`/`externalUrl` → `{{base}}`.
    pub mask_origin: bool,
    /// Remove `cacheMaxAge` do envelope (default: compara, porque é contrato).
    pub mask_cache_max_age: bool,
    /// Remove chaves de relógio/métricas (`trace`, `elapsedMs`, …).
    pub drop_volatile: bool,
    /// Remove campos internos `_*`.
    pub drop_internal: bool,
}

impl Default for NormalizeOptions {
    fn default() -> Self {
        Self {
            base_url: None,
            config_segment: None,
            mask_sig: true,
            mask_origin: true,
            mask_cache_max_age: false,
            drop_volatile: true,
            drop_internal: true,
        }
    }
}

impl NormalizeOptions {
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url = Some(base.into());
        self
    }

    pub fn with_config_segment(mut self, segment: impl Into<String>) -> Self {
        self.config_segment = Some(segment.into());
        self
    }

    /// `true` tira `cacheMaxAge` dos dois lados; use só quando o TTL é
    /// deliberadamente diferente entre Node e Rust.
    pub fn masking_cache_max_age(mut self, mask: bool) -> Self {
        self.mask_cache_max_age = mask;
        self
    }
}

/// Corpo que não é objeto JSON (ou `streams` que não é array).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizeError {
    pub message: String,
}

impl NormalizeError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for NormalizeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for NormalizeError {}

/// Um stream já normalizado: chaves ordenadas e sem campos voláteis.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizedStream {
    pub fields: BTreeMap<String, Value>,
}

impl NormalizedStream {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.fields.get(key)
    }

    pub fn string(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// Identidade estável para casar Node × Rust mesmo quando a ordem muda.
    /// Segue a prioridade do contrato: infoHash → `/resolve/<hash>` → URL →
    /// externalUrl → título/nome (para avisos sem link).
    pub fn identity(&self) -> String {
        if let Some(hash) = self.string("infoHash") {
            return format!("ih:{}", hash.to_ascii_lowercase());
        }
        if let Some(url) = self.string("url") {
            if let Some(hash) = resolve_hash(url) {
                return format!("resolve:{}", hash.to_ascii_lowercase());
            }
            return format!("url:{url}");
        }
        if let Some(external) = self.string("externalUrl") {
            return format!("ext:{external}");
        }
        if let Some(title) = self.string("title") {
            return format!("title:{title}");
        }
        if let Some(name) = self.string("name") {
            return format!("name:{name}");
        }
        "empty".to_string()
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in &self.fields {
            map.insert(key.clone(), value.clone());
        }
        Value::Object(map)
    }

    pub fn canonical_json(&self) -> String {
        canonical_json(&self.to_value())
    }
}

/// Resposta normalizada: envelope (inclui `cacheMaxAge`) + streams ordenados.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NormalizedResponse {
    pub fields: BTreeMap<String, Value>,
    pub streams: Vec<NormalizedStream>,
}

impl NormalizedResponse {
    pub fn cache_max_age(&self) -> Option<&Value> {
        self.fields.get("cacheMaxAge")
    }

    pub fn stream_count(&self) -> usize {
        self.streams.len()
    }

    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        for (key, value) in &self.fields {
            map.insert(key.clone(), value.clone());
        }
        map.insert(
            "streams".to_string(),
            Value::Array(
                self.streams
                    .iter()
                    .map(NormalizedStream::to_value)
                    .collect(),
            ),
        );
        Value::Object(map)
    }

    pub fn canonical_json(&self) -> String {
        canonical_json(&self.to_value())
    }

    /// sha256 do JSON canônico — o `nodeBodyHash`/`rustBodyHash` do contrato.
    pub fn fingerprint(&self) -> String {
        sha256_hex(self.canonical_json().as_bytes())
    }
}

/// Normaliza o corpo de uma resposta. `{}` (sem `streams`) vira lista vazia;
/// um `streams` que não é array é erro de contrato, não panic.
pub fn normalize_body(
    body: &Value,
    options: &NormalizeOptions,
) -> Result<NormalizedResponse, NormalizeError> {
    let Some(object) = body.as_object() else {
        return Err(NormalizeError::new(
            "body não é objeto JSON: esperado {streams, cacheMaxAge}",
        ));
    };

    let mut fields = BTreeMap::new();
    let mut streams_value = None;
    for (key, value) in object {
        if key == "streams" {
            streams_value = Some(value);
            continue;
        }
        if should_drop_key(key, options) {
            continue;
        }
        if key == "cacheMaxAge" && options.mask_cache_max_age {
            continue;
        }
        fields.insert(key.clone(), normalize_value(value, options, false));
    }

    let streams = match streams_value {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, item)| normalize_stream(item, options, index))
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => {
            return Err(NormalizeError::new(
                "body.streams não é array: contrato do /stream exige lista",
            ))
        }
    };

    let mut normalized = NormalizedResponse { fields, streams };
    normalized.streams.sort_by_key(sort_key);
    Ok(normalized)
}

fn normalize_stream(
    value: &Value,
    options: &NormalizeOptions,
    index: usize,
) -> Result<NormalizedStream, NormalizeError> {
    let Some(object) = value.as_object() else {
        return Err(NormalizeError::new(format!(
            "streams[{index}] não é objeto JSON"
        )));
    };
    let mut fields = BTreeMap::new();
    for (key, value) in object {
        if should_drop_key(key, options) {
            continue;
        }
        let is_url = key == "url" || key == "externalUrl";
        fields.insert(key.clone(), normalize_value(value, options, is_url));
    }
    Ok(NormalizedStream { fields })
}

fn normalize_value(value: &Value, options: &NormalizeOptions, url_field: bool) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::new();
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                if should_drop_key(key, options) {
                    continue;
                }
                out.insert(key.clone(), normalize_value(&map[key], options, false));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize_value(item, options, false))
                .collect(),
        ),
        Value::String(text) if url_field => Value::String(mask_url(text, options)),
        _ => value.clone(),
    }
}

fn should_drop_key(key: &str, options: &NormalizeOptions) -> bool {
    (options.drop_internal && key.starts_with('_'))
        || (options.drop_volatile && VOLATILE_KEYS.contains(&key))
}

/// Ordena por infoHash, URL, título e externalUrl; o JSON canônico desempata
/// itens que só diferem em outros campos, garantindo ordem total estável.
fn sort_key(stream: &NormalizedStream) -> (String, String, String, String, String) {
    (
        stream
            .string("infoHash")
            .unwrap_or_default()
            .to_ascii_lowercase(),
        stream.string("url").unwrap_or_default().to_string(),
        stream.string("title").unwrap_or_default().to_string(),
        stream.string("externalUrl").unwrap_or_default().to_string(),
        stream.canonical_json(),
    )
}

/// Extrai o infoHash de `/resolve/<hash>?...`, quando a URL for do addon.
fn resolve_hash(url: &str) -> Option<&str> {
    let rest = url.split("/resolve/").nth(1)?;
    let hash = rest.split(['?', '/', '#']).next().unwrap_or(rest);
    if !hash.is_empty() {
        Some(hash)
    } else {
        None
    }
}

#[path = "normalize_mask.rs"]
mod normalize_mask;
pub use normalize_mask::mask_url;

/// JSON canônico: chaves de objeto ordenadas recursivamente. Não depende da
/// feature `preserve_order` do `serde_json` nem da ordem de construção do Node.
pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                out.push_str(&canonical_json(&map[*key]));
            }
            out.push('}');
            out
        }
        Value::Array(items) => {
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&canonical_json(item));
            }
            out.push(']');
            out
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
    }
}

/// Conjunto de chaves presentes em qualquer stream — usado no diagnóstico.
pub fn stream_field_names(response: &NormalizedResponse) -> BTreeSet<String> {
    response
        .streams
        .iter()
        .flat_map(|stream| stream.fields.keys().cloned())
        .collect()
}

#[cfg(test)]
#[path = "normalize_tests.rs"]
mod tests;
