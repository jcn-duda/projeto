//! Play do Real-Debrid, sem o gate AIMD: a sequência é uma vez só.
//! Torrent já `downloaded` não passa por addMagnet. 451 encerra. NoVideo
//! depois do add apaga o torrent uma vez e devolve o erro original.

use std::time::Duration;

use adom_core::{default_magnet, pick_file, DebridFile, PickCode, PickOutcome, PlayHint};
use reqwest::Method;
use serde_json::Value;

use super::{
    find_ready, form_encode, id_text, js_number, truthy_id, RealDebrid, READY, WAITING, WORKING,
};
use crate::error::DebridError;

impl RealDebrid {
    /// Sem gate. `poll_wait` ocupa o lugar dos 700 ms do `pollTorrent`.
    pub async fn resolve_link(
        &self,
        api_key: &str,
        hash: &str,
        hint: &PlayHint,
        magnet: Option<&str>,
        poll_wait: Duration,
    ) -> Result<Option<String>, DebridError> {
        self.usable_base()?;
        let ready = match self.list_torrents(api_key).await {
            Ok(rows) => find_ready(&rows, hash),
            Err(err) if err.kind() == "blocked" => return Err(err),
            Err(_) => None,
        };
        if let Some(id) = ready {
            let info = self.torrent_info(api_key, &id).await?;
            return finish_resolve(self, api_key, &info, hint).await;
        }
        let body = format!("magnet={}", form_encode(&magnet_for(hash, magnet))).into_bytes();
        let added = self
            .call(api_key, Method::POST, "/torrents/addMagnet", Some(body))
            .await?;
        let Some(id) = added.as_ref().and_then(truthy_id) else {
            return Ok(None);
        };
        let info = match poll_torrent(self, api_key, &id, hint, poll_wait).await {
            Ok(info) => info,
            Err(err) if err.kind() == "no_video" => {
                self.cleanup_once(api_key, &id).await;
                return Err(err);
            }
            Err(err) => return Err(err),
        };
        match finish_resolve(self, api_key, &info, hint).await {
            Ok(url) => Ok(url),
            Err(err) if err.kind() == "no_video" => {
                self.cleanup_once(api_key, &id).await;
                Err(err)
            }
            Err(err) => Err(err),
        }
    }

    async fn torrent_info(&self, api_key: &str, id: &str) -> Result<Value, DebridError> {
        let path = format!("/torrents/info/{id}");
        Ok(as_info(self.call(api_key, Method::GET, &path, None).await?))
    }

    /// Uma tentativa. Falha do DELETE não substitui o NoVideo nem se repete.
    async fn cleanup_once(&self, api_key: &str, id: &str) {
        let path = format!("/torrents/delete/{id}");
        let _ = self.call(api_key, Method::DELETE, &path, None).await;
    }
}

/// Até quatro leituras e no máximo três esperas, como o laço `attempt <= 3`.
async fn poll_torrent(
    rd: &RealDebrid,
    api_key: &str,
    id: &str,
    hint: &PlayHint,
    poll_wait: Duration,
) -> Result<Value, DebridError> {
    let mut info = rd.torrent_info(api_key, id).await?;
    let mut selected = false;
    let mut attempt = 0u32;
    loop {
        let select_now = !selected && status_of(&info) == WAITING && !rd_files(&info).is_empty();
        if select_now {
            select_waiting(rd, api_key, id, &info, hint).await?;
            selected = true;
        }
        let status = status_of(&info).to_string();
        let working = WORKING.contains(&status.as_str());
        if status == READY || (!working && status != WAITING) || attempt == 3 {
            return Ok(info);
        }
        attempt += 1;
        tokio::time::sleep(poll_wait).await;
        info = rd.torrent_info(api_key, id).await?;
    }
}

async fn select_waiting(
    rd: &RealDebrid,
    api_key: &str,
    id: &str,
    info: &Value,
    hint: &PlayHint,
) -> Result<(), DebridError> {
    let files = rd_files(info);
    let view = as_debrid(&files);
    let files_param = match pick_file(&view, hint) {
        PickOutcome::File { path, size } => files
            .iter()
            .find(|file| file.path == path && (file.size - size).abs() < 0.5)
            .and_then(|file| file.id.clone())
            .unwrap_or_else(|| "all".to_string()),
        PickOutcome::Empty => "all".to_string(),
        PickOutcome::Error { code, .. } => return Err(pick_error(code)),
    };
    let body = format!("files={}", form_encode(&files_param)).into_bytes();
    let path = format!("/torrents/selectFiles/{id}");
    // 204 chega como None: sucesso vazio, sem segunda escrita.
    rd.call(api_key, Method::POST, &path, Some(body)).await?;
    Ok(())
}

async fn finish_resolve(
    rd: &RealDebrid,
    api_key: &str,
    info: &Value,
    hint: &PlayHint,
) -> Result<Option<String>, DebridError> {
    if status_of(info) != READY {
        return Ok(None);
    }
    let Some(link) = chosen_link(info, hint)? else {
        return Ok(None);
    };
    let body = format!("link={}", form_encode(&link)).into_bytes();
    let data = rd
        .call(api_key, Method::POST, "/unrestrict/link", Some(body))
        .await?;
    Ok(download_of(data.as_ref()))
}

fn chosen_link(info: &Value, hint: &PlayHint) -> Result<Option<String>, DebridError> {
    let files = rd_files(info);
    let selected: Vec<&RdFile> = files.iter().filter(|file| file.selected).collect();
    let idx = if selected.len() > 1 {
        pick_index(&selected, hint)?
    } else {
        0
    };
    Ok(link_at(info, idx))
}

fn pick_index(selected: &[&RdFile], hint: &PlayHint) -> Result<usize, DebridError> {
    match pick_file(&as_debrid_ref(selected), hint) {
        PickOutcome::Empty => Ok(0),
        PickOutcome::Error { code, .. } => Err(pick_error(code)),
        PickOutcome::File { path, size } => Ok(selected
            .iter()
            .position(|file| file.path == path && (file.size - size).abs() < 0.5)
            .unwrap_or(0)),
    }
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

struct RdFile {
    id: Option<String>,
    path: String,
    size: f64,
    selected: bool,
}

fn rd_files(info: &Value) -> Vec<RdFile> {
    info.get("files")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(rd_file).collect())
        .unwrap_or_default()
}

fn rd_file(file: &Value) -> RdFile {
    RdFile {
        id: id_text(file),
        path: file
            .get("path")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        size: js_number(file.get("bytes")).unwrap_or(0.0),
        selected: js_truthy(file.get("selected")),
    }
}

fn as_debrid(files: &[RdFile]) -> Vec<DebridFile> {
    files
        .iter()
        .map(|file| DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect()
}

fn as_debrid_ref(files: &[&RdFile]) -> Vec<DebridFile> {
    files
        .iter()
        .map(|file| DebridFile {
            path: file.path.clone(),
            size: file.size,
        })
        .collect()
}

fn as_info(value: Option<Value>) -> Value {
    match value {
        Some(value) if value.is_object() => value,
        _ => Value::Object(serde_json::Map::new()),
    }
}

fn status_of(info: &Value) -> &str {
    info.get("status").and_then(Value::as_str).unwrap_or("")
}

fn link_at(info: &Value, idx: usize) -> Option<String> {
    info.get("links")
        .and_then(Value::as_array)
        .and_then(|links| links.get(idx))
        .and_then(Value::as_str)
        .filter(|link| !link.is_empty())
        .map(str::to_string)
}

fn download_of(value: Option<&Value>) -> Option<String> {
    value?
        .get("download")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn pick_error(code: PickCode) -> DebridError {
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

/// `new Date(expiration).getTime()`. Sem fuso, UTC: a data do RD vem com `Z`.
pub(super) fn parse_iso_ms(text: &str) -> Option<i64> {
    if text.len() < 10 {
        return None;
    }
    let year: i32 = text.get(0..4)?.parse().ok()?;
    let bytes = text.as_bytes();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let month: u64 = text.get(5..7)?.parse().ok()?;
    let day: u64 = text.get(8..10)?.parse().ok()?;
    let rest = text.get(10..).unwrap_or("");
    let (hour, min, sec, frac, rest) = if rest.is_empty() {
        (0u64, 0u64, 0u64, 0i64, "")
    } else if let Some(rest) = rest.strip_prefix('T') {
        let clock = parse_clock(rest)?;
        clock
    } else {
        return None;
    };
    Some(unix_ms(year, month, day, hour, min, sec)? + frac - parse_offset(rest)?)
}

fn parse_clock(rest: &str) -> Option<(u64, u64, u64, i64, &str)> {
    if rest.len() < 8 {
        return None;
    }
    let bytes = rest.as_bytes();
    if bytes.get(2) != Some(&b':') || bytes.get(5) != Some(&b':') {
        return None;
    }
    let hour: u64 = rest.get(0..2)?.parse().ok()?;
    let min: u64 = rest.get(3..5)?.parse().ok()?;
    let sec: u64 = rest.get(6..8)?.parse().ok()?;
    let (frac, tail) = split_frac(&rest[8..])?;
    Some((hour, min, sec, frac, tail))
}

fn split_frac(rest: &str) -> Option<(i64, &str)> {
    let Some(rest) = rest.strip_prefix('.') else {
        return Some((0, rest));
    };
    let digits = rest
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if digits == 0 {
        return None;
    }
    let (raw, tail) = rest.split_at(digits);
    let ms = if raw.len() <= 3 {
        format!("{raw:0<3}").parse().ok()?
    } else {
        raw[..3].parse().ok()?
    };
    Some((ms, tail))
}

fn parse_offset(rest: &str) -> Option<i64> {
    if rest.is_empty() || rest.eq_ignore_ascii_case("Z") {
        return Some(0);
    }
    let (sign, rest) = if let Some(rest) = rest.strip_prefix('+') {
        (1i64, rest)
    } else if let Some(rest) = rest.strip_prefix('-') {
        (-1, rest)
    } else {
        return None;
    };
    let (hh, mm) = if rest.len() == 5 && rest.as_bytes().get(2) == Some(&b':') {
        (rest.get(0..2)?, rest.get(3..5)?)
    } else if rest.len() == 4 {
        (rest.get(0..2)?, rest.get(2..4)?)
    } else if rest.len() == 2 {
        (rest, "00")
    } else {
        return None;
    };
    let hh: i64 = hh.parse().ok()?;
    let mm: i64 = mm.parse().ok()?;
    if hh > 23 || mm > 59 {
        return None;
    }
    Some(sign * (hh * 3_600_000 + mm * 60_000))
}

fn unix_ms(year: i32, month: u64, day: u64, hour: u64, min: u64, sec: u64) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || min > 59 || sec > 59 {
        return None;
    }
    let mut y = year as i64;
    let mut m = month as i64;
    if m <= 2 {
        y -= 1;
        m += 12;
    }
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let doy = (153 * (m as u64 - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe as i64 - 719468;
    let secs = days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
    secs.checked_mul(1000)
}
