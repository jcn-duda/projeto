//! Cliente HTTP do pool público Torrentio.
//!
//! - Sem credencial na URL; fail-open → `[]`; breaker local (429/5xx/rede).
//! - `fileIdx` preservado; dedupe por `infoHash` (primeiro vence).
//! - Base configurável sob guarda SSRF.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde_json::Value;

use super::breaker::{now_ms, Breaker};
use super::config::TorrentioConfig;
use super::parse::map_stream;
use super::types::{TorrentioMediaType, TorrentioRawItem, TorrentioSearchArgs};

/// Cliente Torrentio reutilizável (HTTP + breaker compartilhado).
#[derive(Clone)]
pub struct TorrentioClient {
    config: Arc<TorrentioConfig>,
    http: Client,
    breaker: Arc<Breaker>,
}

impl TorrentioClient {
    pub fn new(config: TorrentioConfig) -> Result<Self, String> {
        let http = Client::builder()
            .build()
            .map_err(|err| format!("cliente HTTP Torrentio: {err}"))?;
        Ok(Self {
            config: Arc::new(config),
            http,
            breaker: Arc::new(Breaker::new()),
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(TorrentioConfig::from_env())
    }

    pub fn config(&self) -> &TorrentioConfig {
        &self.config
    }

    pub fn breaker(&self) -> &Breaker {
        &self.breaker
    }

    /// Reset do circuito para testes (espelha `_resetBreaker`).
    pub fn reset_breaker(&self) {
        self.breaker.reset();
    }

    /// Consulta o pool. Fail-open: sempre `Vec` (nunca `Err` para o caller).
    pub async fn search(&self, args: &TorrentioSearchArgs) -> Vec<TorrentioRawItem> {
        if !self.config.enabled {
            return Vec::new();
        }
        if !self.config.base_url_allowed() {
            eprintln!("[torrentio] TORRENTIO_URL bloqueada pela guarda SSRF");
            return Vec::new();
        }
        let Some(url) = endpoint_url(&self.config.url, args) else {
            return Vec::new();
        };
        let now = now_ms();
        if self.breaker.is_open(&self.config, now) {
            return Vec::new();
        }

        let timeout = Duration::from_millis(self.config.timeout_ms.max(1));
        let request = self
            .http
            .get(url)
            .header(ACCEPT, "application/json")
            .timeout(timeout);
        let imdb = args.imdb_id.clone();
        let exchange = async move {
            let response = request.send().await.map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((status, bytes))
        };

        match tokio::time::timeout(timeout, exchange).await {
            Ok(Ok((status, bytes))) => {
                if !(200..300).contains(&status) {
                    // 4xx (salvo rate limit) pertence à obra — não abre breaker.
                    if status < 500 && status != 429 {
                        eprintln!("[torrentio] HTTP {status} para {imdb}");
                        return Vec::new();
                    }
                    self.breaker.note_failure(&self.config, now_ms());
                    eprintln!("[torrentio] falha na consulta de {imdb}: HTTP {status}");
                    return Vec::new();
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    Ok(data) => {
                        let out = collect_streams(&data);
                        self.breaker.note_success();
                        out
                    }
                    Err(err) => {
                        self.breaker.note_failure(&self.config, now_ms());
                        eprintln!(
                            "[torrentio] falha na consulta de {imdb}: JSON inválido: {err}"
                        );
                        Vec::new()
                    }
                }
            }
            Ok(Err(err)) => {
                self.breaker.note_failure(&self.config, now_ms());
                eprintln!("[torrentio] falha na consulta de {imdb}: {err}");
                Vec::new()
            }
            Err(_) => {
                self.breaker.note_failure(&self.config, now_ms());
                eprintln!("[torrentio] falha na consulta de {imdb}: timeout");
                Vec::new()
            }
        }
    }
}

/// Monta a URL pública. `None` = args incompletos (sem rede).
pub fn endpoint_url(base: &str, args: &TorrentioSearchArgs) -> Option<Url> {
    let base = base.trim_end_matches('/');
    let path = match args.media_type {
        TorrentioMediaType::Movie => {
            if args.imdb_id.is_empty() {
                return None;
            }
            format!("{base}/stream/movie/{}.json", args.imdb_id)
        }
        TorrentioMediaType::Series => {
            let season = args.season?;
            let episode = args.episode?;
            if args.imdb_id.is_empty() {
                return None;
            }
            format!(
                "{base}/stream/series/{}:{}:{}.json",
                args.imdb_id, season, episode
            )
        }
    };
    // Credencial nunca entra: path só com imdb/S/E.
    if path.contains("realdebrid=") || path.contains("apiKey") {
        return None;
    }
    Url::parse(&path).ok()
}

fn collect_streams(data: &Value) -> Vec<TorrentioRawItem> {
    let Some(raw) = data.get("streams").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in raw {
        let Some(parsed) = map_stream(item) else {
            continue;
        };
        if !seen.insert(parsed.info_hash.clone()) {
            continue;
        }
        out.push(parsed);
    }
    out
}
