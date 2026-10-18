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

/// Aplica as máscaras de URL. Pública para os testes e para o CLI.
pub fn mask_url(raw: &str, options: &NormalizeOptions) -> String {
    let mut text = raw.to_string();
    if let Some(base) = &options.base_url {
        text = replace_base(&text, base);
    }
    if options.mask_origin {
        text = mask_auto_origin(&text);
    }
    if let Some(segment) = &options.config_segment {
        text = mask_config_segment(&text, segment);
    }
    if options.mask_sig {
        text = mask_sig_param(&text);
    }
    text
}

fn replace_base(text: &str, base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.is_empty() {
        return text.to_string();
    }
    if text == base {
        return "{{base}}".to_string();
    }
    if let Some(rest) = text.strip_prefix(base) {
        if rest.starts_with('/') || rest.starts_with('?') || rest.starts_with('#') {
            return format!("{{{{base}}}}{rest}");
        }
    }
    text.to_string()
}

/// `url`/`externalUrl` só apontam para o addon por contrato; qualquer origem
/// http(s) nesses campos vira `{{base}}`. O corpus já grava `{{base}}`, então
/// a operação é idempotente.
fn mask_auto_origin(text: &str) -> String {
    let rest = if let Some(rest) = text.strip_prefix("http://") {
        rest
    } else if let Some(rest) = text.strip_prefix("https://") {
        rest
    } else {
        return text.to_string();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if authority_end == 0 {
        return text.to_string();
    }
    let suffix = &rest[authority_end..];
    format!("{{{{base}}}}{suffix}")
}

fn mask_config_segment(text: &str, segment: &str) -> String {
    let segment = segment.trim_matches('/');
    if segment.is_empty() {
        return text.to_string();
    }
    text.replace(&format!("/{segment}/"), "/{{config}}/")
}

/// Mascara o valor de `sig` preservando os demais parâmetros da query.
fn mask_sig_param(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'?' | b'&' => {
                out.push(bytes[index] as char);
                index += 1;
                let name_start = index;
                while index < bytes.len() && !matches!(bytes[index], b'=' | b'&' | b'#') {
                    index += 1;
                }
                let name = &text[name_start..index];
                if name == "sig" && bytes.get(index) == Some(&b'=') {
                    out.push_str(name);
                    out.push('=');
                    index += 1;
                    while index < bytes.len() && !matches!(bytes[index], b'&' | b'#') {
                        index += 1;
                    }
                    out.push_str("{{sig}}");
                } else {
                    out.push_str(name);
                }
            }
            _ => {
                let start = index;
                while index < bytes.len() && !matches!(bytes[index], b'?' | b'&') {
                    index += 1;
                }
                out.push_str(&text[start..index]);
            }
        }
    }
    out
}

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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mascara_sig_preserva_os_outros_parametros() {
        let options = NormalizeOptions::default();
        let url = "http://x/{{config}}/resolve/abc?w=%7B%22a%22%3A1%7D&sig=deadbeef&s=2";
        assert_eq!(
            mask_url(url, &options),
            "{{base}}/{{config}}/resolve/abc?w=%7B%22a%22%3A1%7D&sig={{sig}}&s=2"
        );
    }

    #[test]
    fn mascaras_sao_idempotentes() {
        let options = NormalizeOptions::default()
            .with_base_url("http://127.0.0.1:7000")
            .with_config_segment("eyJwIjoiamFja2V0dCJ9");
        let once = mask_url(
            "http://127.0.0.1:7000/eyJwIjoiamFja2V0dCJ9/resolve/abc?sig=deadbeef",
            &options,
        );
        assert_eq!(once, "{{base}}/{{config}}/resolve/abc?sig={{sig}}");
        assert_eq!(mask_url(&once, &options), once);
    }

    #[test]
    fn origem_automatica_nao_toca_tracker() {
        let options = NormalizeOptions::default();
        let normalized = normalize_body(
            &json!({
                "streams": [{
                    "infoHash": "ABC",
                    "url": "http://host:7000/ct/resolve/abc?sig=1",
                    "externalUrl": "https://outro/configure",
                    "sources": ["tracker:udp://tracker.example:1337/announce"]
                }],
                "cacheMaxAge": 0
            }),
            &options,
        )
        .expect("corpo válido");
        let stream = &normalized.streams[0];
        assert_eq!(
            stream.string("url"),
            Some("{{base}}/ct/resolve/abc?sig={{sig}}")
        );
        assert_eq!(stream.string("externalUrl"), Some("{{base}}/configure"));
        // `sources` é dado público do torrent: a origem NÃO vira `{{base}}`.
        assert_eq!(
            stream
                .get("sources")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );
        assert!(stream
            .get("sources")
            .and_then(Value::as_array)
            .and_then(|items| items[0].as_str())
            .is_some_and(|s| s.starts_with("tracker:udp://tracker.example")));
    }

    #[test]
    fn body_sem_streams_vira_lista_vazia_sem_panic() {
        let normalized = normalize_body(&json!({"cacheMaxAge": 0}), &NormalizeOptions::default())
            .expect("{} é tolerado");
        assert_eq!(normalized.stream_count(), 0);
        assert_eq!(normalized.cache_max_age(), Some(&json!(0)));
    }

    #[test]
    fn streams_que_nao_e_array_vira_erro_de_contrato() {
        let error = normalize_body(&json!({"streams": "x"}), &NormalizeOptions::default())
            .expect_err("string em streams deve ser erro");
        assert!(error.message.contains("não é array"), "{error}");
    }
}
