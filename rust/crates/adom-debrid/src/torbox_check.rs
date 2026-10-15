//! Checagem em lote e o HTTP que não cabe no teto de `torbox.rs`.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::PickCode;
use reqwest::Method;
use serde_json::Value;

use super::{is_ready, scalar_id, CacheFile, CacheReport, TorBox};
use crate::error::DebridError;

const CACHE_TIMEOUT: Duration = Duration::from_millis(10_000);

pub(super) async fn check_cached(
    svc: &TorBox,
    api_key: &str,
    hashes: &[String],
    file_hashes: &[String],
    timeout: Option<Duration>,
) -> Result<CacheReport, DebridError> {
    svc.usable_base()?;
    if hashes.is_empty() {
        return Ok(CacheReport {
            cached: Vec::new(),
            complete: true,
            files: Vec::new(),
        });
    }
    let timeout = timeout.unwrap_or(CACHE_TIMEOUT);
    let want: HashSet<String> = file_hashes.iter().map(|hash| hash.to_lowercase()).collect();
    let size = svc.batch_size.max(1);
    let mut handles = Vec::new();
    for batch in hashes.chunks(size) {
        let batch = batch.to_vec();
        let svc = svc.clone();
        let api_key = api_key.to_string();
        let want = want.clone();
        handles.push(tokio::spawn(async move {
            check_batch(&svc, &api_key, &batch, &want, timeout).await
        }));
    }
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        results.push(match handle.await {
            Ok(result) => result,
            Err(_) => Err(DebridError::other("lote de checagem de cache cancelado")),
        });
    }
    fold_batches(results)
}

struct BatchOut {
    hashes: Vec<String>,
    files: Vec<(String, Vec<CacheFile>)>,
}

async fn check_batch(
    svc: &TorBox,
    api_key: &str,
    batch: &[String],
    want: &HashSet<String>,
    timeout: Duration,
) -> Result<BatchOut, DebridError> {
    let list_files = if batch.iter().any(|hash| want.contains(&hash.to_lowercase())) {
        "true"
    } else {
        "false"
    };
    let mut params: Vec<(&str, &str)> = batch.iter().map(|hash| ("hash", hash.as_str())).collect();
    params.push(("format", "list"));
    params.push(("list_files", list_files));
    let data = svc
        .call(
            api_key,
            "/torrents/checkcached",
            Method::GET,
            &params,
            None,
            timeout,
        )
        .await?;
    Ok(parse_cached(&data, want, list_files == "true"))
}

fn fold_batches(results: Vec<Result<BatchOut, DebridError>>) -> Result<CacheReport, DebridError> {
    let total = results.len();
    let mut cached = Vec::new();
    let mut files = Vec::new();
    let mut failures = 0usize;
    let mut kind_n = [0usize; 3];
    let mut kind_msg = [String::new(), String::new(), String::new()];
    for result in results {
        match result {
            Ok(batch) => merge_batch(&mut cached, &mut files, batch),
            Err(err) => {
                failures += 1;
                if let Some(slot) = match err.kind() {
                    "auth" => Some(0),
                    "quota" => Some(1),
                    "rate_limit" => Some(2),
                    _ => None,
                } {
                    kind_n[slot] += 1;
                    kind_msg[slot] = err.message().to_string();
                }
            }
        }
    }
    if total > 0 && failures == total {
        if kind_n[0] == failures {
            return Err(DebridError::Auth(kind_msg[0].clone()));
        }
        if kind_n[1] == failures {
            return Err(DebridError::Quota(kind_msg[1].clone()));
        }
        if kind_n[2] == failures {
            return Err(DebridError::RateLimit {
                message: kind_msg[2].clone(),
                retry_after_ms: None,
            });
        }
        return Err(DebridError::other(
            "nenhum lote de checagem de cache respondeu",
        ));
    }
    Ok(CacheReport {
        cached,
        complete: failures == 0,
        files,
    })
}

fn merge_batch(
    cached: &mut Vec<String>,
    files: &mut Vec<(String, Vec<CacheFile>)>,
    batch: BatchOut,
) {
    for hash in batch.hashes {
        if !cached.iter().any(|have| have == &hash) {
            cached.push(hash);
        }
    }
    for (hash, list) in batch.files {
        if files.iter().any(|(have, _)| have == &hash) {
            continue;
        }
        files.push((hash, list));
    }
}

/// Lista preserva a ordem. Mapa segue o `serde_json::Map` (chaves ordenadas).
fn parse_cached(data: &Value, want: &HashSet<String>, list_files: bool) -> BatchOut {
    let mut hashes = Vec::new();
    let mut files = Vec::new();
    for item in entries_of(data) {
        let hash = hash_of(&item);
        if hash.is_empty() || hashes.iter().any(|have| have == &hash) {
            continue;
        }
        // Só o hash pedido: o lote pode misturar episódio avulso com pack.
        if list_files && want.contains(&hash) {
            if let Some(found) = files_of(&item) {
                files.push((hash.clone(), found));
            }
        }
        hashes.push(hash);
    }
    BatchOut { hashes, files }
}

fn entries_of(data: &Value) -> Vec<Value> {
    match data.get("data") {
        Some(Value::Array(rows)) => rows.clone(),
        Some(Value::Object(map)) => map
            .iter()
            .map(|(hash, info)| {
                let mut obj = match info {
                    Value::Object(fields) => fields.clone(),
                    _ => serde_json::Map::new(),
                };
                obj.insert("hash".to_string(), Value::String(hash.clone()));
                Value::Object(obj)
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn hash_of(item: &Value) -> String {
    match item.get("hash") {
        Some(Value::String(text)) => text.to_lowercase(),
        Some(Value::Number(number)) => number.to_string().to_lowercase(),
        _ => String::new(),
    }
}

fn files_of(item: &Value) -> Option<Vec<CacheFile>> {
    let list = item.get("files")?.as_array()?;
    if list.is_empty() {
        return None;
    }
    Some(
        list.iter()
            .map(|file| CacheFile {
                path: file_path(file),
                size: file_size(file),
            })
            .collect(),
    )
}

/// Morto não segura vaga. Sem prova de morte (`unknown`, `stalled`) ocupa slot.
pub(super) fn slot_of(row: &Value) -> Slot {
    let state = download_state(row).to_ascii_lowercase();
    if ["error", "failed", "broken", "dead"]
        .iter()
        .any(|word| state.contains(word))
    {
        return Slot::Dead;
    }
    if is_ready(row) {
        Slot::Ready
    } else {
        Slot::Active
    }
}

fn download_state(row: &Value) -> String {
    match row.get("download_state") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(true)) => "true".to_string(),
        Some(Value::Number(number)) if number.as_f64().unwrap_or(0.0) != 0.0 => number.to_string(),
        _ => String::new(),
    }
}

pub(super) enum Slot {
    Ready,
    Active,
    Dead,
}

pub(super) struct RemoteFile {
    pub(super) path: String,
    pub(super) size: f64,
    pub(super) id: String,
}

pub(super) fn remote_files(entry: &Value) -> Vec<RemoteFile> {
    let Some(list) = entry.get("files").and_then(Value::as_array) else {
        return Vec::new();
    };
    list.iter()
        .map(|file| RemoteFile {
            path: file_path(file),
            size: file_size(file),
            id: file.get("id").and_then(scalar_id).unwrap_or_default(),
        })
        .collect()
}

pub(super) fn file_path(file: &Value) -> String {
    for key in ["short_name", "name"] {
        if let Some(Value::String(text)) = file.get(key) {
            if !text.is_empty() {
                return text.clone();
            }
        }
    }
    String::new()
}

pub(super) fn file_size(file: &Value) -> f64 {
    match file.get("size") {
        Some(Value::Number(number)) => number.as_f64().filter(|n| n.is_finite()).unwrap_or(0.0),
        _ => 0.0,
    }
}

pub(super) fn chosen_id(files: &[RemoteFile], path: &str, size: f64) -> String {
    let mut fallback = None;
    for file in files {
        if file.path != path {
            continue;
        }
        if (file.size - size).abs() < 0.5 {
            return file.id.clone();
        }
        if fallback.is_none() {
            fallback = Some(file.id.clone());
        }
    }
    fallback.unwrap_or_default()
}

pub(super) fn download_url(data: &Value) -> Option<String> {
    match data.get("data")? {
        Value::String(url) => Some(url.clone()),
        other => {
            let url = other.get("url")?.as_str()?;
            (!url.is_empty()).then(|| url.to_string())
        }
    }
}

pub(super) fn with_query(url: &str, params: &[(&str, &str)]) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let mut out = String::from(url);
    out.push('?');
    for (index, (key, value)) in params.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        out.push_str(&form_encode(key));
        out.push('=');
        out.push_str(&form_encode(value));
    }
    out
}

/// `application/x-www-form-urlencoded` do `URLSearchParams`: espaço vira `+`.
pub(super) fn form_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                const HEX: &[u8; 16] = b"0123456789ABCDEF";
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0f) as usize] as char);
            }
        }
    }
    out
}

pub(super) fn accepted_base(raw: &str) -> Result<String, DebridError> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty()
        || trimmed
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '@' | '\\' | '#' | '?'))
    {
        return Err(base_rejected());
    }
    let Some((scheme_raw, rest)) = trimmed.split_once("://") else {
        return Err(base_rejected());
    };
    if rest.is_empty() {
        return Err(base_rejected());
    }
    let scheme = scheme_raw.to_ascii_lowercase();
    let authority = rest.split('/').next().unwrap_or("");
    let Some(host) = host_of(authority) else {
        return Err(base_rejected());
    };
    let allowed = match scheme.as_str() {
        "https" => true,
        "http" => host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"),
        _ => false,
    };
    if !allowed {
        return Err(base_rejected());
    }
    Ok(format!("{scheme}://{rest}"))
}

fn host_of(authority: &str) -> Option<&str> {
    if authority.is_empty() {
        return None;
    }
    // Sem porta, o "1" fictício só libera o host. Porta vazia ou com letra recusa.
    let (host, port) = authority.split_once(':').unwrap_or((authority, "1"));
    let port_ok = !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit());
    (port_ok && !host.is_empty()).then_some(host)
}

pub(super) fn base_rejected() -> DebridError {
    DebridError::other("TORBOX_API_BASE só aceita https ou http em 127.0.0.1/localhost")
}

pub(super) fn pick_error(code: PickCode) -> DebridError {
    match code {
        PickCode::NoVideo => DebridError::NoVideo(NO_VIDEO.into()),
        PickCode::EpisodePick => DebridError::EpisodePick(EPISODE.into()),
        PickCode::WorkPick => DebridError::WorkPick(WORK.into()),
        PickCode::DubLie => DebridError::DubLie(DUB.into()),
    }
}
const NO_VIDEO: &str = "o torrent não contém nenhum arquivo de vídeo";
const EPISODE: &str = "não foi possível identificar o episódio dentro do pack";
const WORK: &str = "não foi possível identificar a obra dentro do pack";
const DUB: &str = "o torrent anunciado como dublado contém release em inglês";
