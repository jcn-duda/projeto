//! Cliente HTTP do addon Mico (busca por IMDb).
//!
//! - fail-open → `[]`; breaker local (429/5xx/rede/timeout);
//! - 4xx ≠ 429 neutro (não reseta nem incrementa o circuito);
//! - `fetch_streams` sem breaker/banco (núcleo compartilhado com crawl futuro);
//! - base configurável sob guarda SSRF.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde_json::Value;

use super::breaker::{now_ms, Breaker};
use super::config::MicoConfig;
use super::parse::{map_stream, retry_after_ms};
use super::types::{MicoFetchOutcome, MicoMediaType, MicoRawItem, MicoSearchArgs};

/// Erro HTTP do Mico que o fetch puro propaga (429/5xx/rede).
#[derive(Debug, Clone)]
pub struct MicoHttpError {
    pub message: String,
    pub status: Option<u16>,
    pub retry_after_ms: Option<u64>,
}

impl std::fmt::Display for MicoHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for MicoHttpError {}

/// Cliente Mico reutilizável (HTTP + breaker compartilhado).
#[derive(Clone)]
pub struct MicoClient {
    config: Arc<MicoConfig>,
    http: Client,
    breaker: Arc<Breaker>,
}

impl MicoClient {
    pub fn new(config: MicoConfig) -> Result<Self, String> {
        let http = Client::builder()
            .build()
            .map_err(|err| format!("cliente HTTP Mico: {err}"))?;
        Ok(Self {
            config: Arc::new(config),
            http,
            breaker: Arc::new(Breaker::new()),
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(MicoConfig::from_env())
    }

    pub fn config(&self) -> &MicoConfig {
        &self.config
    }

    pub fn breaker(&self) -> &Breaker {
        &self.breaker
    }

    /// Reset do circuito para testes (`_resetBreaker`).
    pub fn reset_breaker(&self) {
        self.breaker.reset();
    }

    /// Reparo do diagnóstico (`repairBreaker`).
    pub fn repair_breaker(&self) {
        self.breaker.repair();
    }

    /// Consulta o addon. Fail-open: sempre `Vec` (nunca `Err` para o caller).
    pub async fn search(&self, args: &MicoSearchArgs) -> Vec<MicoRawItem> {
        if !self.config.enabled {
            return Vec::new();
        }
        if !self.config.base_url_allowed() {
            eprintln!("[mico] MICO_URL bloqueada pela guarda SSRF");
            return Vec::new();
        }
        let Some(url) = endpoint_url(&self.config.url, args) else {
            return Vec::new();
        };
        let now = now_ms();
        if self.breaker.is_open(&self.config, now) {
            return Vec::new();
        }

        match fetch_streams_with(&self.http, url.as_str(), self.config.timeout_ms).await {
            Ok(outcome) => {
                if outcome.ok {
                    self.breaker.note_success();
                }
                // 4xx ≠ 429: neutro — não reseta, não incrementa.
                outcome.items
            }
            Err(err) => {
                self.breaker.note_failure(&self.config, now_ms());
                eprintln!(
                    "[mico] falha na consulta de {}: {}",
                    args.imdb_id, err.message
                );
                Vec::new()
            }
        }
    }
}

/// URL do endpoint de filme; `None` com IMDb inválido.
pub fn mico_movie_stream_url(base: &str, tt: &str) -> Option<String> {
    if !valid_imdb(tt) {
        return None;
    }
    let base = base.trim_end_matches('/');
    Some(format!("{base}/stream/movie/{tt}.json"))
}

/// URL do endpoint de episódio; `None` com IMDb/S/E inválidos.
pub fn mico_episode_stream_url(base: &str, tt: &str, season: i32, episode: i32) -> Option<String> {
    if !valid_imdb(tt) || season < 0 || episode < 0 {
        return None;
    }
    let base = base.trim_end_matches('/');
    Some(format!("{base}/stream/series/{tt}:{season}:{episode}.json"))
}

/// Monta a URL. `None` = args incompletos (sem rede).
pub fn endpoint_url(base: &str, args: &MicoSearchArgs) -> Option<Url> {
    let path = match args.media_type {
        MicoMediaType::Movie => mico_movie_stream_url(base, &args.imdb_id)?,
        MicoMediaType::Series => {
            let season = args.season?;
            let episode = args.episode?;
            mico_episode_stream_url(base, &args.imdb_id, season, episode)?
        }
    };
    Url::parse(&path).ok()
}

fn valid_imdb(tt: &str) -> bool {
    let b = tt.as_bytes();
    if b.len() < 3 || b.len() > 12 {
        return false;
    }
    if &b[..2] != b"tt" {
        return false;
    }
    let digits = &b[2..];
    !digits.is_empty() && digits.len() <= 10 && digits.iter().all(|c| c.is_ascii_digit())
}

/// Fetch puro dos streams (sem breaker/banco) — espelha `fetchMicoStreams`.
pub async fn fetch_streams(url: &str, timeout_ms: u64) -> Result<MicoFetchOutcome, MicoHttpError> {
    let http = Client::builder()
        .build()
        .map_err(|err| MicoHttpError {
            message: format!("cliente HTTP: {err}"),
            status: None,
            retry_after_ms: None,
        })?;
    fetch_streams_with(&http, url, timeout_ms).await
}

async fn fetch_streams_with(
    http: &Client,
    url: &str,
    timeout_ms: u64,
) -> Result<MicoFetchOutcome, MicoHttpError> {
    let timeout = Duration::from_millis(timeout_ms.max(1));
    let request = http
        .get(url)
        .header(ACCEPT, "application/json")
        .timeout(timeout);
    let exchange = async move {
        let response = request.send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        Ok::<_, String>((status, retry, bytes))
    };

    match tokio::time::timeout(timeout, exchange).await {
        Ok(Ok((status, retry, bytes))) => {
            if !(200..300).contains(&status) {
                if status < 500 && status != 429 {
                    eprintln!("[mico] HTTP {status} para {url}");
                    return Ok(MicoFetchOutcome {
                        items: Vec::new(),
                        ok: false,
                    });
                }
                let retry_ms = retry_after_ms(retry.as_deref(), now_ms());
                return Err(MicoHttpError {
                    message: format!("HTTP {status}"),
                    status: Some(status),
                    retry_after_ms: retry_ms,
                });
            }
            match serde_json::from_slice::<Value>(&bytes) {
                Ok(data) => Ok(MicoFetchOutcome {
                    items: collect_streams(&data),
                    ok: true,
                }),
                Err(err) => Err(MicoHttpError {
                    message: format!("JSON inválido: {err}"),
                    status: None,
                    retry_after_ms: None,
                }),
            }
        }
        Ok(Err(err)) => Err(MicoHttpError {
            message: err,
            status: None,
            retry_after_ms: None,
        }),
        Err(_) => Err(MicoHttpError {
            message: "timeout".into(),
            status: None,
            retry_after_ms: None,
        }),
    }
}

fn collect_streams(data: &Value) -> Vec<MicoRawItem> {
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
