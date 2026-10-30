//! Tamanhos por hash no KV nativo: `fsz:v1:<hash>` (lista de arquivos de vídeo,
//! `[{"path","size"}]`) e `tsz:v1:<hash>` (total do torrent, número em bytes).
//!
//! Porte da escrita/leitura de `src/debrid/file-sizes.ts`, que o Node deixa de
//! fazer: a checagem nativa (Premiumize = total, TorBox = lista de arquivos)
//! grava aqui, e o Node continua lendo as mesmas chaves do `cache.db`.
//!
//! Por que o TTL é de 30 dias: o conteúdo de um hash não muda; o TTL só impede
//! que hash esquecido ocupe a cota para sempre. A leitura aplica o TTL, e a
//! poda periódica (`prune_due`) remove o que ninguém mais lê.
//!
//! Fail-open: gravação roda em `spawn_blocking` fora do prazo da resposta, e
//! falha só loga. Leitura com erro de KV devolve mapa vazio.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicI64, Ordering};

use adom_core::{is_sample, is_site_ad, is_video, DebridFile};
use adom_index::NativeKv;
use serde_json::{json, Value};

use crate::error::now_ms;
use crate::native_kv::production_kv;
use crate::torbox::CacheFile;

/// 30 dias, a mesma régua do TS (`FILE_SIZES_TTL_SECONDS`).
pub const FILE_SIZES_TTL_SECONDS: i64 = 30 * 86_400;

const FILES_PREFIX: &str = "fsz:v1:";
const TOTAL_PREFIX: &str = "tsz:v1:";

/// Intervalo mínimo entre duas podas do mesmo processo (1 hora).
const PRUNE_EVERY_MS: i64 = 3_600_000;

/// Instante (ms) da última poda. Zero = nunca podou neste processo.
static LAST_PRUNE_MS: AtomicI64 = AtomicI64::new(0);

/// Hash normalizado: trim + minúsculas, que é como o Node monta a chave.
fn norm(hash: &str) -> String {
    hash.trim().to_lowercase()
}

pub fn files_key(hash: &str) -> String {
    format!("{FILES_PREFIX}{}", norm(hash))
}

pub fn total_key(hash: &str) -> String {
    format!("{TOTAL_PREFIX}{}", norm(hash))
}

/// Grava a lista de vídeos do hash. Régua do TS: tamanho > 0, vídeo, não é
/// amostra e não é anúncio. Lista vazia após o filtro não grava nada (uma
/// entrada vazia faria a leitura tratar o hash como "sem arquivos" para sempre
/// dentro do TTL). `Ok(true)` quando gravou.
pub fn record_files(
    kv: &NativeKv,
    hash: &str,
    files: &[DebridFile],
    now_ms: i64,
) -> Result<bool, String> {
    let hash = norm(hash);
    if hash.is_empty() {
        return Ok(false);
    }
    let videos: Vec<&DebridFile> = files
        .iter()
        .filter(|file| {
            file.size.is_finite()
                && file.size > 0.0
                && is_video(&file.path)
                && !is_sample(&file.path)
                && !is_site_ad(&file.path)
        })
        .collect();
    if videos.is_empty() {
        return Ok(false);
    }
    let value = Value::Array(
        videos
            .iter()
            .map(|file| json!({ "path": file.path, "size": file.size }))
            .collect(),
    );
    // Regravar renova o TTL, como o `cache.set` do Node.
    kv.put_json(&files_key(&hash), &value, FILE_SIZES_TTL_SECONDS, now_ms)?;
    Ok(true)
}

/// Grava o total do torrent. Bytes zero, negativos ou não finitos não gravam
/// (o Node tratava `<= 0` como ausente).
pub fn record_total(kv: &NativeKv, hash: &str, bytes: f64, now_ms: i64) -> Result<bool, String> {
    let hash = norm(hash);
    if hash.is_empty() || !bytes.is_finite() || bytes <= 0.0 {
        return Ok(false);
    }
    kv.put_json(
        &total_key(&hash),
        &json!(bytes),
        FILE_SIZES_TTL_SECONDS,
        now_ms,
    )?;
    Ok(true)
}

/// Hashes normalizados e únicos (ordem estável), sem vazios.
fn unique_hashes(hashes: &[String]) -> BTreeSet<String> {
    hashes
        .iter()
        .map(|hash| norm(hash))
        .filter(|hash| !hash.is_empty())
        .collect()
}

/// Lê as listas de arquivos em lote. Chave do mapa = hash normalizado. Lista
/// vazia ou item sem caminho/tamanho válido sai fora.
pub fn read_files(
    kv: &NativeKv,
    hashes: &[String],
    now_ms: i64,
) -> BTreeMap<String, Vec<DebridFile>> {
    let keys: Vec<String> = unique_hashes(hashes).iter().map(|h| files_key(h)).collect();
    let rows = match kv.get_many_json(&keys, now_ms) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("[debrid] leitura de fsz nativa falhou: {err}");
            return BTreeMap::new();
        }
    };
    rows.into_iter()
        .filter_map(|(key, value)| {
            let hash = key.strip_prefix(FILES_PREFIX)?.to_string();
            let files: Vec<DebridFile> = value
                .as_array()?
                .iter()
                .filter_map(|item| {
                    let path = item.get("path")?.as_str()?.to_string();
                    let size = item.get("size")?.as_f64()?;
                    (size.is_finite() && size > 0.0).then_some(DebridFile { path, size })
                })
                .collect();
            (!files.is_empty()).then_some((hash, files))
        })
        .collect()
}

/// Lê os totais em lote (mesma chave normalizada de `read_files`). Total `<= 0`
/// ou não finito sai fora.
pub fn read_totals(kv: &NativeKv, hashes: &[String], now_ms: i64) -> BTreeMap<String, f64> {
    let keys: Vec<String> = unique_hashes(hashes).iter().map(|h| total_key(h)).collect();
    let rows = match kv.get_many_json(&keys, now_ms) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("[debrid] leitura de tsz nativa falhou: {err}");
            return BTreeMap::new();
        }
    };
    rows.into_iter()
        .filter_map(|(key, value)| {
            let hash = key.strip_prefix(TOTAL_PREFIX)?.to_string();
            let bytes = value.as_f64()?;
            (bytes.is_finite() && bytes > 0.0).then_some((hash, bytes))
        })
        .collect()
}

/// Converte o relatório do TorBox (`CacheFile`) para o formato da gravação.
pub(crate) fn torbox_files(files: &[(String, Vec<CacheFile>)]) -> Vec<(String, Vec<DebridFile>)> {
    files
        .iter()
        .map(|(hash, list)| {
            let converted = list
                .iter()
                .map(|file| DebridFile {
                    path: file.path.clone(),
                    size: file.size,
                })
                .collect();
            (hash.clone(), converted)
        })
        .collect()
}

/// Dispara a gravação em fundo (fire-and-forget). Com runtime tokio usa
/// `spawn_blocking` (o SQLite é síncrono); sem runtime grava no thread atual.
/// Sem KV de produção, não faz nada.
pub fn spawn_record(files: Vec<(String, Vec<DebridFile>)>, totals: Vec<(String, f64)>) {
    if files.is_empty() && totals.is_empty() {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(move || grava(&files, &totals));
        }
        Err(_) => grava(&files, &totals),
    }
}

fn grava(files: &[(String, Vec<DebridFile>)], totals: &[(String, f64)]) {
    let Some(kv) = production_kv() else {
        return;
    };
    let now = now_ms() as i64;
    for (hash, list) in files {
        if let Err(err) = record_files(kv, hash, list, now) {
            eprintln!("[debrid] fsz nativo não gravado: {err}");
        }
    }
    for (hash, bytes) in totals {
        if let Err(err) = record_total(kv, hash, *bytes, now) {
            eprintln!("[debrid] tsz nativo não gravado: {err}");
        }
    }
    prune_due(kv, now);
}

/// Poda os vencidos de `fsz:v1:` e `tsz:v1:` no máximo uma vez por
/// `PRUNE_EVERY_MS` por processo. O `compare_exchange` faz só um dos lotes
/// concorrentes podar.
fn prune_due(kv: &NativeKv, now: i64) {
    let last = LAST_PRUNE_MS.load(Ordering::Relaxed);
    if now - last < PRUNE_EVERY_MS {
        return;
    }
    if LAST_PRUNE_MS
        .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    for prefix in [FILES_PREFIX, TOTAL_PREFIX] {
        if let Err(err) = kv.prune_expired(prefix, now) {
            eprintln!("[debrid] poda de {prefix} falhou: {err}");
        }
    }
}

#[cfg(test)]
#[path = "file_sizes_tests.rs"]
mod file_sizes_tests;
