//! Gravação de UM lote do import: lê o estado local dos hashes do lote, mescla
//! em memória e grava as três tabelas numa transação só.
//!
//! Uma transação por lote é a régua do TS (`flush` do `importLines`): quem cai
//! no meio desfaz o lote inteiro e nunca deixa um magnet sem as suas fontes.
//! A leitura do estado local acontece DENTRO da mesma transação, para que a
//! mescla veja exatamente o que será substituído.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, params_from_iter, Connection, Transaction};

use super::rows::{
    merge_magnet, merge_source, merge_work, work_key, BankMagnet, BankSource, BankWork, WorkKey,
};
use super::{Batch, ImportReport};

/// Tamanho do `IN (...)` por consulta. Mesmo chunk do `listMagnetsMany` do store,
/// abaixo do limite de variáveis do SQLite com folga.
const CHUNK: usize = 200;

type LocalMagnets = HashMap<String, BankMagnet>;
type LocalSources = HashMap<(String, String), BankSource>;
type LocalWorks = HashMap<WorkKey, BankWork>;

fn sql_err(err: rusqlite::Error) -> String {
    format!("gravar o import no magnets.db: {err}")
}

/// Grava o lote. Os contadores de `report` são os do TS: o magnet conta como
/// `merged` quando já existe no banco OU já apareceu antes neste mesmo lote.
pub(super) fn flush(
    conn: &mut Connection,
    batch: Batch,
    report: &mut ImportReport,
) -> Result<(), String> {
    if batch.magnets.is_empty() && batch.sources.is_empty() && batch.works.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(sql_err)?;
    let hashes = unique_hashes(&batch);
    let local_m = read_magnets(&tx, &hashes).map_err(sql_err)?;
    let local_s = read_sources(&tx, &hashes).map_err(sql_err)?;
    let local_w = read_works(&tx, &hashes).map_err(sql_err)?;

    let mut out_m: HashMap<String, BankMagnet> = HashMap::new();
    for row in batch.magnets {
        let prev = out_m
            .get(&row.hash)
            .or_else(|| local_m.get(&row.hash))
            .cloned();
        if local_m.contains_key(&row.hash) || out_m.contains_key(&row.hash) {
            report.magnets.merged += 1;
        } else {
            report.magnets.inserted += 1;
        }
        out_m.insert(row.hash.clone(), merge_magnet(prev, row));
    }

    // Fonte/obra sem o magnet (nem no arquivo, nem no banco) ficaria ÓRFÃ: o
    // banco nunca grava uma sem a outra, e o fallback leria hash sem URI.
    let known = |hash: &str| out_m.contains_key(hash) || local_m.contains_key(hash);
    let orphans = batch
        .sources
        .iter()
        .filter(|row| !known(row.hash.as_str()))
        .count()
        + batch
            .works
            .iter()
            .filter(|row| !known(row.hash.as_str()))
            .count();
    report.rejected += orphans as u64;

    let mut out_s: HashMap<(String, String), BankSource> = HashMap::new();
    for row in batch
        .sources
        .into_iter()
        .filter(|row| known(row.hash.as_str()))
    {
        let key = (row.hash.clone(), row.indexer.clone());
        let prev = out_s.get(&key).or_else(|| local_s.get(&key)).cloned();
        if prev.is_some() {
            report.sources.merged += 1;
        } else {
            report.sources.inserted += 1;
        }
        out_s.insert(key, merge_source(prev, &row));
    }

    let mut out_w: HashMap<WorkKey, BankWork> = HashMap::new();
    for row in batch
        .works
        .into_iter()
        .filter(|row| known(row.hash.as_str()))
    {
        let key = work_key(&row);
        let prev = out_w.get(&key).or_else(|| local_w.get(&key)).cloned();
        if prev.is_some() {
            report.works.merged += 1;
        } else {
            report.works.inserted += 1;
        }
        out_w.insert(key, merge_work(prev, &row));
    }

    for row in out_m.values() {
        write_magnet(&tx, row).map_err(sql_err)?;
    }
    for row in out_s.values() {
        write_source(&tx, row).map_err(sql_err)?;
    }
    for row in out_w.values() {
        write_work(&tx, row).map_err(sql_err)?;
    }
    tx.commit().map_err(sql_err)
}

/// Hashes únicos do lote, na ordem de aparição (só alimentam os `IN`).
fn unique_hashes(batch: &Batch) -> Vec<String> {
    let all = batch
        .magnets
        .iter()
        .map(|row| row.hash.as_str())
        .chain(batch.sources.iter().map(|row| row.hash.as_str()))
        .chain(batch.works.iter().map(|row| row.hash.as_str()));
    let mut seen: HashSet<&str> = HashSet::new();
    all.filter(|hash| seen.insert(*hash))
        .map(str::to_string)
        .collect()
}

fn placeholders(len: usize) -> String {
    vec!["?"; len].join(",")
}

fn read_magnets(tx: &Transaction<'_>, hashes: &[String]) -> rusqlite::Result<LocalMagnets> {
    let mut out = HashMap::new();
    for chunk in hashes.chunks(CHUNK) {
        let sql = format!(
            "SELECT hash, uri, title, size, is_br, dubbed, quality, seeders_max, seeders_last, \
             first_seen, last_seen, lied FROM magnet WHERE hash IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter().map(String::as_str)), |r| {
            Ok(BankMagnet {
                hash: r.get(0)?,
                uri: r.get(1)?,
                title: r.get(2)?,
                size: r.get(3)?,
                is_br: r.get(4)?,
                dubbed: r.get(5)?,
                quality: r.get(6)?,
                seeders_max: r.get(7)?,
                seeders_last: r.get(8)?,
                first_seen: r.get(9)?,
                last_seen: r.get(10)?,
                lied: r.get(11)?,
            })
        })?;
        for row in rows {
            let row = row?;
            out.insert(row.hash.clone(), row);
        }
    }
    Ok(out)
}

fn read_sources(tx: &Transaction<'_>, hashes: &[String]) -> rusqlite::Result<LocalSources> {
    let mut out = HashMap::new();
    for chunk in hashes.chunks(CHUNK) {
        let sql = format!(
            "SELECT hash, indexer, tracker, first_seen, last_seen, seeders_last \
             FROM magnet_source WHERE hash IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter().map(String::as_str)), |r| {
            Ok(BankSource {
                hash: r.get(0)?,
                indexer: r.get(1)?,
                tracker: r.get(2)?,
                first_seen: r.get(3)?,
                last_seen: r.get(4)?,
                seeders_last: r.get(5)?,
            })
        })?;
        for row in rows {
            let row = row?;
            out.insert((row.hash.clone(), row.indexer.clone()), row);
        }
    }
    Ok(out)
}

fn read_works(tx: &Transaction<'_>, hashes: &[String]) -> rusqlite::Result<LocalWorks> {
    let mut out = HashMap::new();
    for chunk in hashes.chunks(CHUNK) {
        let sql = format!(
            "SELECT hash, imdb, season, episode, first_seen, last_seen, passed_filter \
             FROM magnet_work WHERE hash IN ({})",
            placeholders(chunk.len())
        );
        let mut stmt = tx.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter().map(String::as_str)), |r| {
            Ok(BankWork {
                hash: r.get(0)?,
                imdb: r.get(1)?,
                season: r.get(2)?,
                episode: r.get(3)?,
                first_seen: r.get(4)?,
                last_seen: r.get(5)?,
                passed_filter: r.get(6)?,
            })
        })?;
        for row in rows {
            let row = row?;
            out.insert(work_key(&row), row);
        }
    }
    Ok(out)
}

/// `INSERT OR REPLACE` com a linha já mesclada: o SQL não decide nada aqui.
/// A regra de qual valor sobrevive é toda da mescla em `magnet_bank_import_rows.rs`.
fn write_magnet(tx: &Transaction<'_>, row: &BankMagnet) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT OR REPLACE INTO magnet (hash, uri, title, size, is_br, dubbed, quality, \
         seeders_max, seeders_last, first_seen, last_seen, lied) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.hash,
            row.uri,
            row.title,
            row.size,
            row.is_br,
            row.dubbed,
            row.quality,
            row.seeders_max,
            row.seeders_last,
            row.first_seen,
            row.last_seen,
            row.lied
        ],
    )
}

fn write_source(tx: &Transaction<'_>, row: &BankSource) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT OR REPLACE INTO magnet_source (hash, indexer, tracker, first_seen, last_seen, \
         seeders_last) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            row.hash,
            row.indexer,
            row.tracker,
            row.first_seen,
            row.last_seen,
            row.seeders_last
        ],
    )
}

fn write_work(tx: &Transaction<'_>, row: &BankWork) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT OR REPLACE INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, \
         passed_filter) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            row.hash,
            row.imdb,
            row.season,
            row.episode,
            row.first_seen,
            row.last_seen,
            row.passed_filter
        ],
    )
}
