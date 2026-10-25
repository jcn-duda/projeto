//! Leitura e escrita do banco de magnets vivo (`data/magnets.db`) no formato do
//! Node (`src/utils/magnet-bank-rows.ts`).
//!
//! Três tabelas, schema IDÊNTICO ao DDL do Node: `magnet` (uma linha por
//! torrent), `magnet_source` (de onde veio) e `magnet_work` (para qual busca
//! apareceu, com `season`/`episode` = -1 para nulo). Sem cota, sem TTL e sem
//! versão de namespace: é acervo permanente.
//!
//! O que esta camada faz:
//!
//! - **lê** as linhas da obra em lote (`worksForObraMany`) e as fontes
//!   (`sourcesForMany`), com a MESMA ordem das consultas do Node
//!   (`passed_filter DESC, last_seen DESC`; fontes sem ORDER BY, como lá);
//! - **escreve** o resultado do filtro de título (`markBankFilterOutcome`):
//!   `passed_filter` 1/0 e `last_seen` das linhas que JÁ existem, por hash e por
//!   alvo (a obra do pedido + os packs que o título declara);
//! - **captura** (`captureItems`) o lote que a coleta viva viu, em UMA
//!   transação: o acervo passou a ser alimentado no fim da busca NATIVA (o
//!   efeito `magnet_capture` do Node não existe mais). As regras de qual linha
//!   gravar vivem em `magnet_bank_capture.rs`; o SQL, em `magnet_bank_write.rs`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use adom_core::{BankRow, InstantMagnet, InstantSource, InstantWork, WorkTarget};
use rusqlite::{params, Connection};

#[path = "magnet_bank_write.rs"]
mod write;
// Regras puras da captura (`inputFromItem` + merges), separadas pela catraca.
#[path = "magnet_bank_capture.rs"]
mod capture;
// SQL do upsert das três tabelas (também separado pela catraca).
#[path = "magnet_bank_upsert.rs"]
mod upsert;

pub use write::WorkCtx;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS magnet (
  hash TEXT PRIMARY KEY,
  uri TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  is_br INTEGER NOT NULL DEFAULT 0,
  dubbed INTEGER NOT NULL DEFAULT 0,
  quality TEXT NOT NULL DEFAULT '',
  seeders_max INTEGER NOT NULL DEFAULT 0,
  seeders_last INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  lied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS magnet_source (
  hash TEXT NOT NULL,
  indexer TEXT NOT NULL,
  tracker TEXT NOT NULL DEFAULT '',
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  seeders_last INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hash, indexer)
);
CREATE TABLE IF NOT EXISTS magnet_work (
  hash TEXT NOT NULL,
  imdb TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT -1,
  episode INTEGER NOT NULL DEFAULT -1,
  first_seen INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0,
  passed_filter INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hash, imdb, season, episode)
);
CREATE INDEX IF NOT EXISTS magnet_work_obra ON magnet_work (imdb, season, episode);
CREATE INDEX IF NOT EXISTS magnet_source_indexer ON magnet_source (indexer, last_seen);
CREATE INDEX IF NOT EXISTS magnet_last_seen ON magnet (last_seen);
CREATE INDEX IF NOT EXISTS magnet_source_last_seen ON magnet_source (last_seen);
";

/// Teto do `clampLimit` do Node (1..500).
fn clamp_limit(limit: usize) -> i64 {
    limit.clamp(1, 500) as i64
}

/// Tuple da PK: `null` vira -1, como no Node.
fn tuple(season: Option<i64>, episode: Option<i64>) -> (i64, i64) {
    (season.unwrap_or(-1), episode.unwrap_or(-1))
}

/// Banco do acervo (compartilhado com o `magnets.db` do Node).
pub struct MagnetBankStore {
    conn: Mutex<Connection>,
}

impl MagnetBankStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do magnets.db: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir magnets.db: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema magnets.db: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// `MAGNET_BANK_DB_PATH` (default `data/magnets.db`), o mesmo caminho do
    /// Node. O caller só abre quando o banco está ligado (`MAGNET_BANK`).
    pub fn from_env() -> Result<Self, String> {
        Self::open(&magnet_db_path())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// `worksForObraMany`: para cada alvo, linhas ordenadas por
    /// `passed_filter DESC, last_seen DESC` (o `LIMIT` é POR alvo, como no Node)
    /// e o magnet de cada hash numa única consulta em lote.
    ///
    /// `indexers` não vazio restringe às obras cujo hash tem fonte num deles
    /// (antes do LIMIT, senão a janela enche de globais e o BR nunca é lido).
    pub fn works_for_obra_many(
        &self,
        imdb: &str,
        targets: &[WorkTarget],
        limit_per_target: usize,
        max_total: usize,
        indexers: Option<&[String]>,
    ) -> Result<Vec<InstantWork>, String> {
        if imdb.is_empty() || targets.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock();
        let limit = clamp_limit(limit_per_target);
        let mut works: Vec<InstantWork> = Vec::new();
        for target in targets {
            if works.len() >= max_total {
                break;
            }
            let (season, episode) = tuple(target.season, target.episode);
            let rows = match indexers {
                Some(indexers) if !indexers.is_empty() => {
                    let placeholders = vec!["?"; indexers.len()].join(",");
                    let sql = format!(
                        "SELECT w.hash, w.passed_filter, w.last_seen, w.first_seen FROM magnet_work w \
                         WHERE w.imdb = ?1 AND w.season = ?2 AND w.episode = ?3 AND EXISTS ( \
                           SELECT 1 FROM magnet_source s WHERE s.hash = w.hash AND s.indexer IN ({placeholders}) \
                         ) ORDER BY w.passed_filter DESC, w.last_seen DESC LIMIT ?{}",
                        indexers.len() + 4
                    );
                    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
                    let mut args: Vec<rusqlite::types::Value> = vec![
                        rusqlite::types::Value::Text(imdb.to_string()),
                        rusqlite::types::Value::Integer(season),
                        rusqlite::types::Value::Integer(episode),
                    ];
                    for indexer in indexers {
                        args.push(rusqlite::types::Value::Text(indexer.clone()));
                    }
                    args.push(rusqlite::types::Value::Integer(limit));
                    let rows = stmt
                        .query_map(rusqlite::params_from_iter(args), |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        })
                        .map_err(|err| err.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|err| err.to_string())?;
                    rows
                }
                _ => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT hash, passed_filter, last_seen, first_seen FROM magnet_work \
                             WHERE imdb = ?1 AND season = ?2 AND episode = ?3 \
                             ORDER BY passed_filter DESC, last_seen DESC LIMIT ?4",
                        )
                        .map_err(|err| err.to_string())?;
                    let rows = stmt
                        .query_map(params![imdb, season, episode, limit], |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, i64>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        })
                        .map_err(|err| err.to_string())?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(|err| err.to_string())?;
                    rows
                }
            };
            works.extend(
                rows.into_iter()
                    .map(|(hash, passed_filter, last_seen, first_seen)| InstantWork {
                        hash,
                        passed_filter,
                        last_seen,
                        first_seen,
                        magnet: None,
                    }),
            );
        }
        drop(conn);
        let hashes: Vec<String> = works.iter().map(|work| work.hash.clone()).collect();
        let mut magnets = self.list_magnets_many(&hashes)?;
        for work in &mut works {
            work.magnet = magnets.remove(&work.hash);
        }
        Ok(works)
    }

    /// `listMagnetsMany` em chunks de 200 (o fallback lê N magnets sem N+1).
    pub fn list_magnets_many(
        &self,
        hashes: &[String],
    ) -> Result<HashMap<String, InstantMagnet>, String> {
        let list = unique_lower(hashes);
        let mut out = HashMap::new();
        if list.is_empty() {
            return Ok(out);
        }
        let conn = self.lock();
        for chunk in list.chunks(200) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT hash, uri, title, size, is_br, dubbed, quality, seeders_max, seeders_last, last_seen, lied \
                 FROM magnet WHERE hash IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(chunk.iter().map(|s| s.as_str())),
                    |row| {
                        Ok(InstantMagnet {
                            hash: row.get(0)?,
                            uri: row.get(1)?,
                            title: row.get(2)?,
                            size: row.get(3)?,
                            is_br: row.get::<_, i64>(4)? == 1,
                            dubbed: row.get::<_, i64>(5)? == 1,
                            quality: row.get(6)?,
                            seeders_max: row.get(7)?,
                            seeders_last: row.get(8)?,
                            last_seen: row.get(9)?,
                            lied: row.get::<_, i64>(10)? == 1,
                        })
                    },
                )
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            for row in rows {
                out.insert(row.hash.clone(), row);
            }
        }
        Ok(out)
    }

    /// Linhas de acervo no formato do núcleo (`BankRow`) para a fonte de mídia
    /// do índice (`bankRowsForMediaSource`).
    pub fn bank_rows_many(&self, hashes: &[String]) -> Result<Vec<BankRow>, String> {
        Ok(self
            .list_magnets_many(hashes)?
            .into_values()
            .map(|magnet| BankRow {
                hash: magnet.hash,
                uri: magnet.uri,
                title: magnet.title,
            })
            .collect())
    }

    /// `sourcesForMany`: fontes de MUITOS hashes em uma consulta, agrupadas por
    /// hash. Mesma consulta sem ORDER BY do Node (a ordem é a do SQLite; o
    /// `pickSource` desempata por `last_seen`).
    pub fn sources_for_many(
        &self,
        hashes: &[String],
    ) -> Result<BTreeMap<String, Vec<InstantSource>>, String> {
        let list = unique_lower(hashes);
        let mut out: BTreeMap<String, Vec<InstantSource>> = BTreeMap::new();
        if list.is_empty() {
            return Ok(out);
        }
        let conn = self.lock();
        for chunk in list.chunks(200) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let sql = format!(
                "SELECT hash, indexer, tracker, last_seen FROM magnet_source WHERE hash IN ({placeholders})"
            );
            let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(
                    rusqlite::params_from_iter(chunk.iter().map(|s| s.as_str())),
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            for (hash, indexer, tracker, last_seen) in rows {
                out.entry(hash).or_default().push(InstantSource {
                    indexer,
                    tracker,
                    // O veredito é do pedido (`allowedSourceIndexer`), que o
                    // chamador aplica; o store não lê `opts()`.
                    last_seen,
                    allowed: true,
                });
            }
        }
        Ok(out)
    }

    /// `bankHasBrRow`: o acervo tem linha `is_br=1` de QUALQUER alvo da obra?
    /// Leitura pura; erro devolve `false` (fail-open, como o TS).
    pub fn has_br_row(&self, imdb: &str, targets: &[WorkTarget]) -> bool {
        self.works_for_obra_many(imdb, targets, 200, 300, None)
            .map(|works| {
                works
                    .iter()
                    .any(|work| work.magnet.as_ref().is_some_and(|magnet| magnet.is_br))
            })
            .unwrap_or(false)
    }

    /// Só para teste: injeta linhas no schema real (as fixtures do Node são
    /// gravações SQL diretas; o store de produção não tem `captureItems`).
    #[cfg(test)]
    pub(crate) fn exec_fixture(&self, sql: &str) {
        self.lock().execute_batch(sql).expect("fixture SQL");
    }
}

fn unique_lower(hashes: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for hash in hashes {
        let lower = hash.trim().to_lowercase();
        if !lower.is_empty() && seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    out
}

/// `MAGNET_BANK_DB_PATH` (default `data/magnets.db`).
pub fn magnet_db_path() -> PathBuf {
    std::env::var("MAGNET_BANK_DB_PATH")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("data/magnets.db"))
}

#[cfg(test)]
#[path = "magnet_bank_tests.rs"]
mod tests;
