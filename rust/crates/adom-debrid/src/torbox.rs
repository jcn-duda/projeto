//! Fundação do adaptador TorBox. Só o HTTP que o TypeScript já faz:
//! `call`, `check_cached`, `resolve_link` e `account_status`.
//! Fora: enqueue, inventário, `torrentStatus`, `removeTorrent`, ocupação
//! e `assertDubbedFiles`. Sem log de chave, magnet ou corpo.

use std::time::Duration;

use adom_core::{default_magnet, pick_file, DebridFile, PickOutcome, PlayHint};
use reqwest::Method;
use serde_json::{Map, Value};

use crate::error::DebridError;
use crate::http::{Call, HttpClient};

const DEFAULT_BASE: &str = "https://api.torbox.app/v1/api";
const CALL_TIMEOUT: Duration = Duration::from_millis(6_000);
const DEFAULT_BATCH: usize = 25;
const MAX_POLLS: u32 = 4;

/// Teto de downloads ativos do plano Pro. Planos menores recusam com ACTIVE_LIMIT.
pub const ACTIVE_LIMIT: u32 = 10;
/// TorBox publica checagem de cache em lote.
pub const CACHE_CHECK: bool = true;
const _: () = assert!(CACHE_CHECK);

#[derive(Debug, Clone, PartialEq)]
pub struct CacheFile {
    pub path: String,
    pub size: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CacheReport {
    pub cached: Vec<String>,
    pub complete: bool,
    pub files: Vec<(String, Vec<CacheFile>)>,
}

/// O que `accountStatus` devolve: total do mylist, prontos e os que ocupam vaga.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountStatus {
    pub magnets: u64,
    pub ready: u64,
    pub active: u64,
}

#[derive(Clone)]
pub struct TorBox {
    pub client: HttpClient,
    pub base: String,
    pub batch_size: usize,
}

impl TorBox {
    /// Base recusada fica vazia: a chamada erra sem pedir nada na rede.
    pub fn new(client: HttpClient) -> Self {
        let base = match std::env::var("TORBOX_API_BASE") {
            Ok(raw) if !raw.trim().is_empty() => {
                torbox_check::accepted_base(&raw).unwrap_or_default()
            }
            _ => DEFAULT_BASE.to_string(),
        };
        let parsed = std::env::var("DEBRID_BATCH_SIZE")
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok());
        Self {
            client,
            base,
            batch_size: parsed.filter(|n| *n > 0).unwrap_or(DEFAULT_BATCH),
        }
    }

    /// Lotes paralelos de `/torrents/checkcached`. `None` no prazo usa 10s.
    pub async fn check_cached(
        &self,
        api_key: &str,
        hashes: &[String],
        file_hashes: &[String],
        timeout: Option<Duration>,
    ) -> Result<CacheReport, DebridError> {
        torbox_check::check_cached(self, api_key, hashes, file_hashes, timeout).await
    }

    /// `poll_wait` na produção é 700 ms. Os testes passam `Duration::ZERO`.
    pub async fn resolve_link(
        &self,
        api_key: &str,
        hash: &str,
        hint: &PlayHint,
        magnet: Option<&str>,
        poll_wait: Duration,
    ) -> Result<Option<String>, DebridError> {
        let magnet = magnet_for(hash, magnet);
        let created = self
            .call(
                api_key,
                "/torrents/createtorrent",
                Method::POST,
                &[],
                Some(create_body(&magnet)),
                CALL_TIMEOUT,
            )
            .await?;
        let Some(torrent_id) = torrent_id(&created) else {
            return Ok(None);
        };
        let Some(entry) = self.poll_ready(api_key, &torrent_id, poll_wait).await? else {
            return Ok(None);
        };
        self.link_for(api_key, &torrent_id, &entry, hint).await
    }

    pub async fn account_status(&self, api_key: &str) -> Result<AccountStatus, DebridError> {
        let list = self
            .call(
                api_key,
                "/torrents/mylist",
                Method::GET,
                &[],
                None,
                CALL_TIMEOUT,
            )
            .await?;
        let rows = account_rows(&list);
        let mut ready = 0u64;
        let mut active = 0u64;
        for row in &rows {
            match torbox_check::slot_of(row) {
                torbox_check::Slot::Ready => ready += 1,
                torbox_check::Slot::Dead => {}
                torbox_check::Slot::Active => active += 1,
            }
        }
        Ok(AccountStatus {
            magnets: rows.len() as u64,
            ready,
            active,
        })
    }

    /// HTTP 200 com `success: false` sobe erro. Lista vazia seria "nada em cache".
    #[allow(clippy::too_many_arguments)]
    pub async fn call(
        &self,
        api_key: &str,
        path: &str,
        method: Method,
        params: &[(&str, &str)],
        body: Option<Vec<u8>>,
        timeout: Duration,
    ) -> Result<Value, DebridError> {
        let mut headers = vec![("Authorization".to_string(), format!("Bearer {api_key}"))];
        if body.is_some() {
            headers.push((
                "Content-Type".to_string(),
                "application/x-www-form-urlencoded".to_string(),
            ));
        }
        let data = self
            .client
            .json(Call {
                method,
                url: torbox_check::with_query(&format!("{}{path}", self.usable_base()?), params),
                headers,
                body,
                timeout,
                abort_safe: false,
            })
            .await?;
        let Some(data) = data else {
            return Err(DebridError::other("torbox retornou erro"));
        };
        if let Some(err) = envelope_failure(&data) {
            return Err(err);
        }
        Ok(data)
    }

    fn usable_base(&self) -> Result<&str, DebridError> {
        if self.base.is_empty() {
            Err(torbox_check::base_rejected())
        } else {
            Ok(&self.base)
        }
    }

    /// A espera fica entre as leituras. O quarto poll sem pronto devolve na hora.
    async fn poll_ready(
        &self,
        api_key: &str,
        torrent_id: &str,
        poll_wait: Duration,
    ) -> Result<Option<Value>, DebridError> {
        for attempt in 0..MAX_POLLS {
            let list = self
                .call(
                    api_key,
                    "/torrents/mylist",
                    Method::GET,
                    &[("id", torrent_id), ("bypass_cache", "true")],
                    None,
                    CALL_TIMEOUT,
                )
                .await?;
            if let Some(entry) = poll_entry(&list).filter(is_ready) {
                return Ok(Some(entry));
            }
            if attempt + 1 < MAX_POLLS {
                tokio::time::sleep(poll_wait).await;
            }
        }
        Ok(None)
    }

    async fn link_for(
        &self,
        api_key: &str,
        torrent_id: &str,
        entry: &Value,
        hint: &PlayHint,
    ) -> Result<Option<String>, DebridError> {
        let remote = torbox_check::remote_files(entry);
        let files: Vec<DebridFile> = remote
            .iter()
            .map(|file| DebridFile {
                path: file.path.clone(),
                size: file.size,
            })
            .collect();
        let (path, size) = match pick_file(&files, hint) {
            PickOutcome::Empty => return Ok(None),
            PickOutcome::Error {
                code,
                evidence,
                context,
            } => return Err(torbox_check::pick_error(code, evidence, context)),
            PickOutcome::File { path, size } => (path, size),
        };
        let file_id = torbox_check::chosen_id(&remote, &path, size);
        let dl = self
            .call(
                api_key,
                "/torrents/requestdl",
                Method::GET,
                &[
                    ("token", api_key),
                    ("torrent_id", torrent_id),
                    ("file_id", file_id.as_str()),
                    ("redirect", "false"),
                ],
                None,
                CALL_TIMEOUT,
            )
            .await?;
        Ok(torbox_check::download_url(&dl))
    }
}

fn envelope_failure(data: &Value) -> Option<DebridError> {
    let obj = data.as_object()?;
    if obj.get("success").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    Some(classify_failure(obj))
}

fn classify_failure(obj: &Map<String, Value>) -> DebridError {
    let code = match obj.get("error") {
        Some(Value::String(text)) if !text.is_empty() => text.as_str(),
        _ => "",
    };
    let detail = trimmed(obj.get("detail"));
    let error_text = trimmed(obj.get("error"));
    let message = if !detail.is_empty() {
        detail
    } else if !error_text.is_empty() {
        error_text
    } else if !code.is_empty() {
        code.to_string()
    } else {
        "torbox retornou erro".to_string()
    };
    let full = if !code.is_empty() && !message.contains(code) {
        format!("{message} ({code})")
    } else {
        message
    };
    if code.eq_ignore_ascii_case("ACTIVE_LIMIT") || code.eq_ignore_ascii_case("MONTHLY_LIMIT") {
        return DebridError::Quota(full);
    }
    if code.eq_ignore_ascii_case("COOLDOWN_LIMIT") || mentions_rate_limit(&full) {
        return DebridError::RateLimit {
            message: full,
            retry_after_ms: None,
        };
    }
    DebridError::Other(full)
}

fn trimmed(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

/// `rate limit`, `ratelimit` ou `rate-limit` — o mesmo `rate.?limit` do TS.
fn mentions_rate_limit(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.match_indices("rate").any(|(idx, _)| {
        let rest = &lower[idx + 4..];
        rest.starts_with("limit") || rest.get(1..).is_some_and(|tail| tail.starts_with("limit"))
    })
}

fn magnet_for(hash: &str, magnet: Option<&str>) -> String {
    if let Some(uri) = magnet {
        let carries = !hash.is_empty()
            && uri
                .to_ascii_lowercase()
                .contains(&hash.to_ascii_lowercase());
        if uri.starts_with("magnet:?") && carries {
            return uri.to_string();
        }
    }
    default_magnet(hash)
}

fn create_body(magnet: &str) -> Vec<u8> {
    format!(
        "magnet={}&seed=3&allow_zip=false",
        torbox_check::form_encode(magnet)
    )
    .into_bytes()
}

fn torrent_id(created: &Value) -> Option<String> {
    let data = created.get("data")?;
    match data.get("torrent_id") {
        Some(value) => scalar_id(value).or_else(|| data.get("id").and_then(scalar_id)),
        None => data.get("id").and_then(scalar_id),
    }
}

fn scalar_id(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn poll_entry(list: &Value) -> Option<Value> {
    match list.get("data")? {
        Value::Array(rows) => rows.first().cloned(),
        Value::Null => None,
        other => Some(other.clone()),
    }
}

fn is_ready(entry: &Value) -> bool {
    js_truthy(entry.get("download_finished")) || js_truthy(entry.get("download_present"))
}

fn account_rows(list: &Value) -> Vec<Value> {
    match list.get("data") {
        Some(Value::Array(rows)) => rows.clone(),
        Some(value) if js_truthy(Some(value)) => vec![value.clone()],
        _ => Vec::new(),
    }
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

#[path = "torbox_check.rs"]
mod torbox_check;

#[cfg(test)]
#[path = "torbox_tests.rs"]
mod torbox_tests;

#[cfg(test)]
#[path = "torbox_play_tests.rs"]
mod torbox_play_tests;
