//! Cliente HTTP `/api/v1/search` do Prowlarr.
//!
//! - Sem chave / query vazia / base SSRF → `[]`.
//! - Rede/timeout/HTTP/JSON inválido → `[]` (fail-open, sem panic).
//! - A API key nunca entra em log (só na query + `X-Api-Key`).

use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT};
use reqwest::{Client, Url};
use serde_json::Value;

use super::config::ProwlarrConfig;
use super::types::ProwlarrRawItem;

/// Cliente Prowlarr reutilizável.
#[derive(Clone)]
pub struct ProwlarrClient {
    config: Arc<ProwlarrConfig>,
    http: Client,
}

impl ProwlarrClient {
    pub fn new(config: ProwlarrConfig) -> Result<Self, String> {
        let mut builder = Client::builder();
        let agent = config.user_agent.trim();
        if !agent.is_empty() {
            builder = builder.user_agent(agent);
        }
        let http = builder
            .build()
            .map_err(|err| format!("cliente HTTP Prowlarr: {err}"))?;
        Ok(Self {
            config: Arc::new(config),
            http,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(ProwlarrConfig::from_env())
    }

    pub fn config(&self) -> &ProwlarrConfig {
        &self.config
    }

    /// Consulta `/api/v1/search`. Sem chave / query vazia / falha → `[]`.
    pub async fn search(&self, query: &str) -> Vec<ProwlarrRawItem> {
        if !self.config.has_api_key() {
            eprintln!("[prowlarr] PROWLARR_API_KEY não configurada");
            return Vec::new();
        }
        if query.is_empty() {
            return Vec::new();
        }
        if !self.config.base_url_allowed() {
            eprintln!("[prowlarr] PROWLARR_URL bloqueada pela guarda SSRF");
            return Vec::new();
        }

        let Ok(mut url) = self.search_url() else {
            eprintln!("[prowlarr] URL inválida");
            return Vec::new();
        };
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("apikey", &self.config.api_key);
            pairs.append_pair("query", query);
        }

        let timeout = Duration::from_millis(self.config.timeout_ms.max(1));
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if let Ok(name) = HeaderName::from_bytes(b"X-Api-Key") {
            if let Ok(value) = HeaderValue::from_str(self.config.api_key.trim()) {
                headers.insert(name, value);
            }
        }

        // NÃO logar `url` — carrega a apikey.
        let request = self.http.get(url).headers(headers).timeout(timeout);
        let exchange = async move {
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((status, bytes))
        };

        match tokio::time::timeout(timeout, exchange).await {
            Ok(Ok((status, bytes))) => {
                if !(200..300).contains(&status) {
                    let body = String::from_utf8_lossy(&bytes);
                    let preview: String = body.chars().take(200).collect();
                    eprintln!("[prowlarr] HTTP {status} {preview}");
                    return Vec::new();
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(data) => map_results(&data),
                    Err(_) => {
                        eprintln!("[prowlarr] JSON inválido");
                        Vec::new()
                    }
                }
            }
            Ok(Err(err)) => {
                eprintln!("[prowlarr] {err}");
                Vec::new()
            }
            Err(_) => {
                eprintln!("[prowlarr] timeout");
                Vec::new()
            }
        }
    }

    fn search_url(&self) -> Result<Url, String> {
        let base = self.config.url.trim_end_matches('/');
        let raw = format!("{base}/api/v1/search");
        Url::parse(&raw).map_err(|err| format!("URL Prowlarr inválida: {err}"))
    }
}

fn map_results(data: &Value) -> Vec<ProwlarrRawItem> {
    let Some(arr) = data.as_array() else {
        return Vec::new();
    };
    arr.iter().filter_map(map_one).collect()
}

fn map_one(raw: &Value) -> Option<ProwlarrRawItem> {
    let title = raw
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let magnet = first_string(raw, &["magnetUrl", "guid", "downloadUrl"]);
    let info_hash = raw
        .get("infoHash")
        .and_then(Value::as_str)
        .map(str::to_string);
    let seeders = json_number(raw.get("seeders"));
    let size = json_number(raw.get("size"));
    let tracker = first_string(raw, &["indexer", "indexerId"]);
    Some(ProwlarrRawItem {
        title,
        magnet,
        info_hash,
        seeders,
        size,
        tracker,
    })
}

fn first_string(raw: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = raw.get(*key).and_then(Value::as_str) {
            if !s.is_empty() {
                return Some(s.to_string());
            }
        }
        // indexerId numérico no Prowlarr → String no tracker (como JS).
        if let Some(n) = raw.get(*key).and_then(Value::as_i64) {
            return Some(n.to_string());
        }
        if let Some(n) = raw.get(*key).and_then(Value::as_u64) {
            return Some(n.to_string());
        }
    }
    None
}

fn json_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}
