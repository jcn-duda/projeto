//! Cliente HTTP do addon Mico (busca por IMDb).
//!
//! - fail-open → `[]`; breaker local (429/5xx/rede/timeout);
//! - 4xx ≠ 429 é NEUTRO (não reseta nem incrementa o circuito) e vira
//!   `{items:[], ok:false}` no fetch puro / `Http(4xx)` no desfecho tipado;
//! - `fetch_streams` sem breaker/banco (núcleo compartilhado com o crawl);
//! - `search_outcome` devolve o desfecho tipado do coletor; o breaker só é
//!   lido/escrito no caminho VIVO (`MicoSearchOptions::LIVE`).
//! - base configurável sob guarda SSRF.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::{Client, Url};
use serde_json::Value;

use super::breaker::now_ms;
use super::breaker::Breaker;
use super::config::MicoConfig;
use super::parse::map_stream;
use super::retry_after::retry_after_ms;
use super::types::{
    MicoFetchOutcome, MicoMediaType, MicoOutcome, MicoRawItem, MicoSearchArgs, MicoSearchOptions,
};

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

/// Falha interna de transporte: o coletor distingue timeout de rede, mas os
/// dois alimentam o breaker no caminho vivo.
enum FetchFailure {
    Timeout,
    Network(String),
}

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
    /// Equivale ao caminho VIVO (`MicoSearchOptions::LIVE`).
    pub async fn search(&self, args: &MicoSearchArgs) -> Vec<MicoRawItem> {
        self.search_outcome(args, MicoSearchOptions::LIVE)
            .await
            .into_items()
    }

    /// Consulta detalhada: distingue resposta válida (inclusive vazia) de
    /// configuração, falha declarada e `pending` no prazo. O breaker só
    /// participa quando `options.read_only` é falso — na sombra a referência
    /// ignora o circuito aberto e NÃO o abre/reseta (contrato do `readOnly`).
    pub async fn search_outcome(
        &self,
        args: &MicoSearchArgs,
        options: MicoSearchOptions,
    ) -> MicoOutcome {
        if !self.config.enabled {
            return MicoOutcome::Disabled;
        }
        if !self.config.base_url_allowed() {
            eprintln!("[mico] MICO_URL bloqueada pela guarda SSRF");
            return MicoOutcome::BlockedUrl;
        }
        let Some(url) = endpoint_url(&self.config.url, args) else {
            return MicoOutcome::NoEndpoint;
        };
        let now = now_ms();
        let configured_timeout = self.config.timeout_ms.max(1);
        // O prazo do COLETOR vence antes do timeout do cliente? A consulta
        // fica `pending` (como no Node) e não há rede.
        let (timeout_ms, deadline_bound) = match options.deadline_at {
            Some(deadline) => {
                let remaining = deadline.saturating_sub(now).max(0) as u64;
                if remaining == 0 {
                    return MicoOutcome::Pending;
                }
                (
                    remaining.min(configured_timeout),
                    remaining < configured_timeout,
                )
            }
            None => (configured_timeout, false),
        };
        if !options.read_only && self.breaker.is_open(&self.config, now) {
            return MicoOutcome::BreakerOpen;
        }
        let timeout = Duration::from_millis(timeout_ms);
        match fetch_once(&self.http, url.as_str(), timeout).await {
            Ok((status, retry, bytes)) => {
                if !(200..300).contains(&status) {
                    // 4xx (salvo rate limit) pertence à obra — não abre breaker.
                    if status < 500 && status != 429 {
                        eprintln!("[mico] HTTP {status} para {url}");
                        return MicoOutcome::Http(status);
                    }
                    if !options.read_only {
                        self.breaker.note_failure(&self.config, now_ms());
                    }
                    let retry_ms = retry_after_ms(retry.as_deref(), now_ms());
                    eprintln!(
                        "[mico] falha na consulta de {}: HTTP {status}{}",
                        args.imdb_id,
                        retry_ms
                            .map(|ms| format!(" (Retry-After {ms} ms)"))
                            .unwrap_or_default()
                    );
                    return MicoOutcome::Http(status);
                }
                match serde_json::from_slice::<Value>(&bytes) {
                    // JSON sem `streams` é resposta vazia válida: o TS lê
                    // `Array.isArray(data?.streams) ? … : []` e conta sucesso.
                    Ok(data) => {
                        if !options.read_only {
                            self.breaker.note_success();
                        }
                        MicoOutcome::Ok(collect_streams(&data))
                    }
                    Err(err) => {
                        if !options.read_only {
                            self.breaker.note_failure(&self.config, now_ms());
                        }
                        eprintln!(
                            "[mico] falha na consulta de {}: JSON inválido: {err}",
                            args.imdb_id
                        );
                        MicoOutcome::InvalidJson
                    }
                }
            }
            Err(FetchFailure::Timeout) => {
                // O timeout pode ser o do cliente (falha) ou o do prazo do
                // coletor (pending — o Node ainda teria a consulta em voo).
                // `deadline_bound` cobre o timer que dispara no limite sem que
                // o relógio já tenha cruzado `deadline` por 1 ms.
                if deadline_bound
                    || options
                        .deadline_at
                        .is_some_and(|deadline| now_ms() >= deadline)
                {
                    return MicoOutcome::Pending;
                }
                if !options.read_only {
                    self.breaker.note_failure(&self.config, now_ms());
                }
                eprintln!("[mico] falha na consulta de {}: timeout", args.imdb_id);
                MicoOutcome::Timeout
            }
            Err(FetchFailure::Network(message)) => {
                if !options.read_only {
                    self.breaker.note_failure(&self.config, now_ms());
                }
                eprintln!("[mico] falha na consulta de {}: {message}", args.imdb_id);
                MicoOutcome::Network(message)
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
    let http = Client::builder().build().map_err(|err| MicoHttpError {
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
    match fetch_once(http, url, timeout).await {
        Ok((status, retry, bytes)) => {
            if !(200..300).contains(&status) {
                if status < 500 && status != 429 {
                    eprintln!("[mico] HTTP {status} para {url}");
                    return Ok(MicoFetchOutcome {
                        items: Vec::new(),
                        ok: false,
                    });
                }
                return Err(MicoHttpError {
                    message: format!("HTTP {status}"),
                    status: Some(status),
                    retry_after_ms: retry_after_ms(retry.as_deref(), now_ms()),
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
        Err(FetchFailure::Timeout) => Err(MicoHttpError {
            message: "timeout".into(),
            status: None,
            retry_after_ms: None,
        }),
        Err(FetchFailure::Network(message)) => Err(MicoHttpError {
            message,
            status: None,
            retry_after_ms: None,
        }),
    }
}

/// GET com prazo DURO de rede (fetch + corpo), como o `fetchJsonWithin` do TS.
async fn fetch_once(
    http: &Client,
    url: &str,
    timeout: Duration,
) -> Result<(u16, Option<String>, Vec<u8>), FetchFailure> {
    let request = http
        .get(url)
        .header(ACCEPT, "application/json")
        .timeout(timeout);
    let exchange = async move {
        let response = request.send().await.map_err(classify)?;
        let status = response.status().as_u16();
        let retry = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response.bytes().await.map_err(classify)?;
        Ok::<_, FetchFailure>((status, retry, bytes.to_vec()))
    };
    match tokio::time::timeout(timeout, exchange).await {
        Ok(result) => result,
        Err(_) => Err(FetchFailure::Timeout),
    }
}

fn classify(error: reqwest::Error) -> FetchFailure {
    if error.is_timeout() {
        FetchFailure::Timeout
    } else {
        FetchFailure::Network(error.to_string())
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
