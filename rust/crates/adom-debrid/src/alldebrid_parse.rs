//! JSON da conta, do upload e da árvore de arquivos.
//! Fora da fundação HTTP para caber na catraca de linhas.

use adom_core::{DebridFile, PickCode};
use serde_json::Value;

use super::{AccountStatus, Leaf};
use crate::error::{classify_message, DebridError};

pub(super) fn summarize(data: &Value) -> AccountStatus {
    let rows: &[Value] = data
        .get("magnets")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut ready = 0usize;
    let mut active = 0usize;
    let mut error = 0usize;
    let mut oldest_at: Option<i64> = None;
    let magnets = rows.len();
    for magnet in rows {
        let status = magnet.get("status").and_then(Value::as_str).unwrap_or("");
        if magnet.get("ready").and_then(Value::as_bool) == Some(true)
            || status.eq_ignore_ascii_case("ready")
        {
            ready += 1;
        } else if is_active(status) {
            active += 1;
        } else if !status.is_empty() {
            error += 1;
        }
        if let Some(at) = upload_secs(magnet) {
            oldest_at = Some(oldest_at.map(|min| min.min(at)).unwrap_or(at));
        }
    }
    AccountStatus {
        magnets,
        ready,
        active,
        error,
        oldest_at,
    }
}

fn is_active(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "queued" | "downloading" | "processing" | "compressing" | "moving" | "uploading"
    )
}

/// `uploadDate` 0 é falso no JS e não entra no mínimo.
fn upload_secs(magnet: &Value) -> Option<i64> {
    let n = magnet.get("uploadDate")?.as_f64()?;
    (n.is_finite() && n != 0.0).then_some(n as i64)
}

/// HTTP 200 com `status:"error"`. Auth/Quota levam `mensagem (code)`; o resto só a mensagem.
pub(super) fn unwrap_payload(value: Value) -> Result<Value, DebridError> {
    if value.get("status").and_then(Value::as_str) == Some("error") {
        return Err(payload_error(&value));
    }
    Ok(value.get("data").cloned().unwrap_or(Value::Null))
}

fn payload_error(value: &Value) -> DebridError {
    let err = value.get("error");
    let code = err
        .and_then(|item| item.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let raw = err
        .and_then(|item| item.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let message = if !raw.is_empty() {
        raw
    } else if !code.is_empty() {
        code
    } else {
        "alldebrid retornou erro"
    };
    let full = if code.is_empty() {
        message.to_string()
    } else {
        format!("{message} ({code})")
    };
    let code_up = code.to_ascii_uppercase();
    let probe = format!("{code} {message}");
    let kind = if code_up.starts_with("AUTH_") || classify_message(&probe).kind() == "auth" {
        "auth"
    } else if code_up.contains("MAGNET_TOO_MANY_ACTIVE")
        || classify_message(&probe).kind() == "quota"
    {
        "quota"
    } else {
        "other"
    };
    match kind {
        "auth" => DebridError::Auth(full),
        "quota" => DebridError::Quota(full),
        _ => DebridError::Other(message.to_string()),
    }
}

pub(super) fn magnet_id(magnet: &Value) -> Option<String> {
    match magnet.get("id")? {
        Value::String(text) if !text.is_empty() && text != "0" => Some(text.clone()),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                (int != 0).then(|| int.to_string())
            } else {
                let n = number.as_f64()?;
                (n.is_finite() && n != 0.0).then(|| number.to_string())
            }
        }
        _ => None,
    }
}

pub(super) fn first_magnet(data: &Value) -> Option<&Value> {
    match data.get("magnets")? {
        Value::Array(list) => list.first(),
        other if other.is_object() => Some(other),
        _ => None,
    }
}

pub(super) fn status_ready(magnet: &Value) -> bool {
    magnet.get("status").and_then(Value::as_str) == Some("Ready")
}

pub(super) fn status_pending(info: &Option<Value>) -> bool {
    info.as_ref().is_some_and(|magnet| !status_ready(magnet))
}

/// Árvore v4.1: `e` é pasta, folha com `l` vira arquivo.
pub(super) fn flatten(nodes: &[Value], prefix: &str, out: &mut Vec<Leaf>) {
    for node in nodes {
        let name = node.get("n").and_then(Value::as_str).unwrap_or("");
        let path = if prefix.is_empty() {
            name.to_string()
        } else {
            format!("{prefix}/{name}")
        };
        if let Some(children) = node.get("e").and_then(Value::as_array) {
            flatten(children, &path, out);
        } else if let Some(link) = nonempty(node.get("l")) {
            out.push(Leaf {
                path,
                size: node
                    .get("s")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .unwrap_or(0.0),
                link,
            });
        }
    }
}

pub(super) fn as_debrid(leaves: &[Leaf]) -> Vec<DebridFile> {
    leaves
        .iter()
        .map(|leaf| DebridFile {
            path: leaf.path.clone(),
            size: leaf.size,
        })
        .collect()
}

pub(super) fn leaf_link(leaves: &[Leaf], path: &str, size: f64) -> Option<String> {
    let mut fallback = None;
    for leaf in leaves {
        if leaf.path != path {
            continue;
        }
        if (leaf.size - size).abs() < 0.5 {
            return Some(leaf.link.clone());
        }
        if fallback.is_none() {
            fallback = Some(leaf.link.clone());
        }
    }
    fallback
}

pub(super) fn nonempty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

pub(super) fn pick_error(code: PickCode) -> DebridError {
    match code {
        PickCode::NoVideo => {
            DebridError::NoVideo("o torrent não contém nenhum arquivo de vídeo".into())
        }
        PickCode::EpisodePick => DebridError::EpisodePick(
            "não foi possível identificar o episódio dentro do pack".into(),
        ),
        PickCode::WorkPick => {
            DebridError::WorkPick("não foi possível identificar a obra dentro do pack".into())
        }
        PickCode::DubLie => {
            DebridError::DubLie("o torrent anunciado como dublado contém release em inglês".into())
        }
    }
}
