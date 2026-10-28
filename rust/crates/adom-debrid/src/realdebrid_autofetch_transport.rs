//! Transporte e classificação HTTP do autofetch Real-Debrid.

use std::sync::Arc;
use std::time::Duration;

use adom_core::{default_magnet, pick_file, DebridFile, PickOutcome, PlayHint};
use reqwest::Method;
use serde_json::Value;

use crate::error::DebridError;
use crate::realdebrid::{
    form_encode, id_text, js_number, truthy_id, RealDebrid, READY, WAITING, WORKING,
};

use super::{now_ms, RdAutofetchError, RdUncertainIntent, RdUncertainStore, RdWriteKind};

/// Falha LOCAL (store/intent) não é recusa do serviço: só a segunda fala do
/// HTTP. As duas fecham o caminho — nenhuma vira "segue sem intent".
#[derive(Debug)]
pub(super) enum InnerError {
    /// Intent durável pendente: escrita anterior de resultado incerto.
    Quarantined,
    /// Store local falhou ao ler/gravar/limpar o intent ou a posse.
    Store,
    Debrid(DebridError),
}

pub(super) fn validate(api_key: &str, hash: &str) -> Result<(String, String), RdAutofetchError> {
    let hash = hash.to_ascii_lowercase();
    if api_key.is_empty() || hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(RdAutofetchError::InvalidInput);
    }
    Ok((account_scope(api_key), hash))
}

fn account_scope(api_key: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(api_key.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn validated_magnet(hash: &str, magnet: Option<&str>) -> String {
    magnet
        .filter(|uri| uri.starts_with("magnet:?") && uri.to_ascii_lowercase().contains(hash))
        .map(str::to_string)
        .unwrap_or_else(|| default_magnet(hash))
}

pub(super) async fn enqueue_inner(
    rd: Arc<RealDebrid>,
    store: Arc<dyn RdUncertainStore>,
    key: String,
    api_key: String,
    magnet: String,
    hint: PlayHint,
    poll_wait: Duration,
) -> Result<Option<String>, InnerError> {
    if store.has_intent(&key).map_err(|_| InnerError::Store)? {
        return Err(InnerError::Quarantined);
    }
    let intent = RdUncertainIntent {
        kind: RdWriteKind::Enqueue,
        created_at_ms: now_ms(),
    };
    if !store
        .put_intent_if_absent(&key, &intent)
        .map_err(|_| InnerError::Store)?
    {
        return Err(InnerError::Quarantined);
    }

    let body = format!("magnet={}", form_encode(&magnet)).into_bytes();
    let added = match rd
        .call(&api_key, Method::POST, "/torrents/addMagnet", Some(body))
        .await
    {
        Ok(value) => value,
        Err(err) if definitive_rejection(&err) => {
            let _ = store.clear_intent(&key);
            return Err(InnerError::Debrid(err));
        }
        Err(err) => return Err(InnerError::Debrid(err)),
    };
    let Some(id) = added.as_ref().and_then(truthy_id) else {
        return Ok(None);
    };

    match poll_torrent(&rd, &api_key, &id, &hint, poll_wait).await {
        Ok((info, selected)) => {
            let has_selected = rd_files(&info).iter().any(|file| file.selected);
            if status_of(&info) == READY || selected || has_selected {
                Ok(Some(id))
            } else {
                Ok(None)
            }
        }
        Err(err) if err.kind() == "no_video" => {
            if !delete_once(&rd, &api_key, &id).await {
                return Err(InnerError::Debrid(err));
            }
            store.clear_intent(&key).map_err(|_| InnerError::Store)?;
            Ok(None)
        }
        Err(err) => Err(InnerError::Debrid(err)),
    }
}

pub(super) async fn remove_inner(
    rd: Arc<RealDebrid>,
    store: Arc<dyn RdUncertainStore>,
    account: String,
    hash: String,
    key: String,
    api_key: String,
    id: String,
) -> Result<bool, InnerError> {
    if store.has_intent(&key).map_err(|_| InnerError::Store)? {
        return Err(InnerError::Quarantined);
    }
    if !store
        .owns_transfer(&account, &hash, &id)
        .map_err(|_| InnerError::Store)?
    {
        return Ok(false);
    }
    let intent = RdUncertainIntent {
        kind: RdWriteKind::Remove,
        created_at_ms: now_ms(),
    };
    if !store
        .put_intent_if_absent(&key, &intent)
        .map_err(|_| InnerError::Store)?
    {
        return Err(InnerError::Quarantined);
    }

    let path = format!("/torrents/delete/{id}");
    match rd.call(&api_key, Method::DELETE, &path, None).await {
        Ok(_) => {
            store.clear_intent(&key).map_err(|_| InnerError::Store)?;
            Ok(true)
        }
        Err(err)
            if matches!(
                err,
                DebridError::Auth(_)
                    | DebridError::Quota(_)
                    | DebridError::RateLimit { .. }
                    | DebridError::Blocked(_)
            ) =>
        {
            let _ = store.clear_intent(&key);
            Err(InnerError::Debrid(err))
        }
        Err(err)
            if definite_http_status(&err).is_some_and(|status| status < 500 && status != 408) =>
        {
            let _ = store.clear_intent(&key);
            if definite_http_status(&err) == Some(404) {
                Ok(true)
            } else {
                Err(InnerError::Debrid(err))
            }
        }
        Err(err) => Err(InnerError::Debrid(err)),
    }
}

async fn poll_torrent(
    rd: &RealDebrid,
    api_key: &str,
    id: &str,
    hint: &PlayHint,
    poll_wait: Duration,
) -> Result<(Value, bool), DebridError> {
    let mut info = torrent_info(rd, api_key, id).await?;
    let mut selected = false;
    for attempt in 0..4 {
        if status_of(&info) == WAITING && !selected && !rd_files(&info).is_empty() {
            select_waiting(rd, api_key, id, &info, hint).await?;
            selected = true;
        }
        let status = status_of(&info);
        if status == READY || (!WORKING.contains(&status) && status != WAITING) || attempt == 3 {
            return Ok((info, selected));
        }
        tokio::time::sleep(poll_wait).await;
        info = torrent_info(rd, api_key, id).await?;
    }
    Ok((info, selected))
}

async fn torrent_info(rd: &RealDebrid, api_key: &str, id: &str) -> Result<Value, DebridError> {
    let path = format!("/torrents/info/{id}");
    Ok(rd
        .call(api_key, Method::GET, &path, None)
        .await?
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(serde_json::Map::new())))
}

async fn select_waiting(
    rd: &RealDebrid,
    api_key: &str,
    id: &str,
    info: &Value,
    hint: &PlayHint,
) -> Result<(), DebridError> {
    let files = rd_files(info);
    let view = files
        .iter()
        .map(|file| DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect::<Vec<_>>();
    let files_param = match pick_file(&view, hint) {
        PickOutcome::File { path, size } => files
            .iter()
            .find(|file| file.path == path && (file.size - size).abs() < 0.5)
            .and_then(|file| file.id.clone())
            .unwrap_or_else(|| "all".into()),
        PickOutcome::Empty => "all".into(),
        PickOutcome::Error {
            code,
            evidence,
            context,
        } => {
            return Err(DebridError::from_pick(code, evidence, context));
        }
    };
    let body = format!("files={}", form_encode(&files_param)).into_bytes();
    rd.call(
        api_key,
        Method::POST,
        &format!("/torrents/selectFiles/{id}"),
        Some(body),
    )
    .await?;
    Ok(())
}

struct RdFile {
    id: Option<String>,
    path: String,
    size: f64,
    selected: bool,
}

fn rd_files(info: &Value) -> Vec<RdFile> {
    info.get("files")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| RdFile {
                    id: id_text(row),
                    path: row
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    size: js_number(row.get("bytes")).unwrap_or(0.0),
                    selected: row.get("selected").is_some_and(js_truthy),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn status_of(info: &Value) -> &str {
    info.get("status").and_then(Value::as_str).unwrap_or("")
}

async fn delete_once(rd: &RealDebrid, api_key: &str, id: &str) -> bool {
    rd.call(
        api_key,
        Method::DELETE,
        &format!("/torrents/delete/{id}"),
        None,
    )
    .await
    .is_ok()
}

fn definitive_rejection(error: &DebridError) -> bool {
    matches!(
        error,
        DebridError::Auth(_)
            | DebridError::Quota(_)
            | DebridError::RateLimit { .. }
            | DebridError::Blocked(_)
    ) || definite_http_status(error)
        .is_some_and(|status| (400..500).contains(&status) && status != 408 && status != 429)
}

fn definite_http_status(error: &DebridError) -> Option<u16> {
    let DebridError::Other(message) = error else {
        return None;
    };
    message.strip_prefix("HTTP ")?.get(..3)?.parse().ok()
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}
