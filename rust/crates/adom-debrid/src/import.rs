//! Cópia única dos namespaces que o Rust passa a possuir. A segunda subida
//! vê o marcador e não relê o `cache.db`. Sem o arquivo de origem, o marcador
//! não é gravado: a próxima subida tenta de novo.

use std::path::Path;

use rusqlite::{params, Connection};

use crate::error::now_ms;
use crate::store::{open_readonly, prefix_of, Store};

pub const IMPORT_MARKER: &str = "__debrid:import:v1";

/// Prefixos com a versão de `src/utils/cache-keys.ts`. `mag_meta` viaja com
/// `mag`: são os contadores do mesmo banco.
pub const OWNED_PREFIXES: &[&str] = &[
    "davail:v1:",
    "mag:v1:",
    "mag_meta:v1:",
    "rdc:v2:",
    "rdt:v1:",
    "rdq:v1:",
    "adsub:v1:",
    "adrm:v1:",
    "adprot:v1:",
    "autofetch:v3:",
];

pub struct ImportReport {
    pub copied: u64,
    pub already: bool,
}

pub fn import_once(debrid_db: &Path, cache_db: &Path) -> Result<ImportReport, String> {
    let store = Store::open(debrid_db)?;
    if store.contains(IMPORT_MARKER)? {
        return Ok(ImportReport {
            copied: 0,
            already: true,
        });
    }
    if !cache_db.exists() {
        return Ok(ImportReport {
            copied: 0,
            already: false,
        });
    }
    let source = open_readonly(cache_db)?;
    let now = now_ms() as i64;
    let mut copied = 0u64;
    for prefix in OWNED_PREFIXES {
        for (key, value, expires_at) in read_prefix(&source, prefix)? {
            if expires_at <= now {
                continue;
            }
            if prefix_of(&key).is_none() {
                continue;
            }
            store.put(&key, &value, expires_at, now)?;
            copied += 1;
        }
    }
    store.put_internal(IMPORT_MARKER, "1", i64::MAX / 4)?;
    Ok(ImportReport {
        copied,
        already: false,
    })
}

/// Devolve os namespaces deste banco ao `cache.db`. Apaga no destino só as
/// chaves desses prefixos e regrava o que o Rust tem. O container do addon
/// tem que estar parado: o Node também escreve esse arquivo.
pub fn export_owned(from: &Path, into: &Path) -> Result<u64, String> {
    if from == into {
        return Err("origem e destino são o mesmo arquivo".into());
    }
    let source = open_readonly(from)?;
    let mut dest = Connection::open(into).map_err(|err| format!("abrir cache.db: {err}"))?;
    dest.execute_batch(
        "CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );",
    )
    .map_err(|err| err.to_string())?;
    let tx = dest.transaction().map_err(|err| err.to_string())?;
    let mut copied = 0u64;
    for prefix in OWNED_PREFIXES {
        tx.execute(
            "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            params![prefix],
        )
        .map_err(|err| err.to_string())?;
        for (key, value, expires_at) in read_prefix(&source, prefix)? {
            tx.execute(
                "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
                params![key, value, expires_at],
            )
            .map_err(|err| err.to_string())?;
            copied += 1;
        }
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(copied)
}

fn read_prefix(conn: &Connection, prefix: &str) -> Result<Vec<(String, String, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key, value, expires_at FROM cache
             WHERE substr(key, 1, length(?1)) = ?1",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![prefix], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

#[cfg(test)]
#[path = "import_tests.rs"]
mod import_tests;
