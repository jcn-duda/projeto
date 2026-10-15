//! Acervo: as releases que o raspador colhe, por obra (IMDb) e local (S/E).
//!
//! Banco próprio (`ACERVO_DB_PATH`), separado do `crawl.db` (fila do raspador).
//! Página sem IMDb não é descartada: a release fica com `imdb` vazio e o
//! título/ano da obra, para a identificação no TMDB ligar depois.

use std::path::Path;
use std::sync::Mutex;

use adom_crawl::motor::types::{CrawlRawItem, CrawlWorkResult};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

/// `season` da linha sem temporada declarada (nunca vai à raiz da série).
const UNLOCATED: i64 = -2;
/// `season`/`episode` de filme ou da raiz da série.
const ROOT: i64 = -1;

pub struct Acervo {
    conn: Mutex<Connection>,
}

impl Acervo {
    pub fn open(path: &str) -> Result<Self, String> {
        if let Some(dir) = Path::new(path).parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("acervo: pasta {dir:?}: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("acervo: abrir {path}: {e}"))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, String> {
        Self::init(Connection::open_in_memory().map_err(|e| e.to_string())?)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS release (
               info_hash  TEXT NOT NULL,
               imdb       TEXT NOT NULL DEFAULT '',
               season     INTEGER NOT NULL DEFAULT -1,
               episode    INTEGER NOT NULL DEFAULT -1,
               site       TEXT NOT NULL,
               url_key    TEXT NOT NULL,
               kind       TEXT NOT NULL,
               work_title TEXT,
               work_year  INTEGER,
               title      TEXT NOT NULL,
               magnet     TEXT NOT NULL,
               size       TEXT,
               is_br      INTEGER NOT NULL DEFAULT 0,
               first_seen INTEGER NOT NULL,
               last_seen  INTEGER NOT NULL,
               PRIMARY KEY (info_hash, imdb, season, episode)
             );
             CREATE INDEX IF NOT EXISTS release_imdb ON release(imdb, season, episode);
             CREATE INDEX IF NOT EXISTS release_site ON release(site, url_key);",
        )
        .map_err(|e| format!("acervo: schema: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Grava as releases da página. `kept` = com magnet válido; `added` = novas.
    pub fn record(&self, work: &CrawlWorkResult, now_ms: i64) -> Result<(u32, u32), String> {
        let mut rows: Vec<(i64, i64, &CrawlRawItem)> = Vec::new();
        for item in &work.releases {
            rows.push((ROOT, ROOT, item));
        }
        for group in &work.groups {
            let season = group.season.map_or(ROOT, i64::from);
            let episode = group.episode.map_or(ROOT, i64::from);
            for item in &group.releases {
                rows.push((season, episode, item));
            }
        }
        for item in &work.unlocated {
            rows.push((UNLOCATED, ROOT, item));
        }
        let imdb = work.imdb.clone().unwrap_or_default();
        let mut conn = self.conn.lock().map_err(|_| "acervo: lock envenenado")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let (mut kept, mut added) = (0u32, 0u32);
        for (season, episode, item) in rows {
            let Some(magnet) = item.magnet.as_deref() else {
                continue;
            };
            let Some(hash) = info_hash(magnet) else {
                continue;
            };
            kept += 1;
            let inserted = tx
                .execute(
                    "INSERT OR IGNORE INTO release (info_hash, imdb, season, episode, site, url_key,
                       kind, work_title, work_year, title, magnet, size, is_br, first_seen, last_seen)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
                    params![
                        hash,
                        imdb,
                        season,
                        episode,
                        work.site,
                        work.url_key,
                        work.kind,
                        work.title,
                        work.year,
                        item.title,
                        magnet,
                        item.size,
                        item.is_br,
                        now_ms
                    ],
                )
                .map_err(|e| e.to_string())?;
            if inserted == 1 {
                added += 1;
            } else {
                tx.execute(
                    "UPDATE release SET last_seen = ?5 WHERE info_hash = ?1 AND imdb = ?2
                       AND season = ?3 AND episode = ?4",
                    params![hash, imdb, season, episode, now_ms],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok((kept, added))
    }

    /// Releases de uma obra (`imdb`) ou, sem obra, a contagem por site.
    pub fn query(&self, imdb: Option<&str>, limit: u32) -> Result<Value, String> {
        let conn = self.conn.lock().map_err(|_| "acervo: lock envenenado")?;
        let Some(imdb) = imdb else {
            let mut stmt = conn
                .prepare(
                    "SELECT site, COUNT(*), SUM(imdb = ''), COUNT(DISTINCT imdb) FROM release
                     GROUP BY site ORDER BY site",
                )
                .map_err(|e| e.to_string())?;
            let sites = stmt
                .query_map([], |r| {
                    Ok(json!({
                        "site": r.get::<_, String>(0)?,
                        "releases": r.get::<_, i64>(1)?,
                        "sem_imdb": r.get::<_, i64>(2)?,
                        "obras": r.get::<_, i64>(3)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            return Ok(json!({ "sites": sites }));
        };
        let mut stmt = conn
            .prepare(
                "SELECT site, season, episode, title, magnet, size, is_br, url_key FROM release
                 WHERE imdb = ?1 ORDER BY season, episode, site LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let releases = stmt
            .query_map(params![imdb, limit], |r| {
                Ok(json!({
                    "site": r.get::<_, String>(0)?,
                    "season": r.get::<_, i64>(1)?,
                    "episode": r.get::<_, i64>(2)?,
                    "title": r.get::<_, String>(3)?,
                    "magnet": r.get::<_, String>(4)?,
                    "size": r.get::<_, Option<String>>(5)?,
                    "isBr": r.get::<_, bool>(6)?,
                    "urlKey": r.get::<_, String>(7)?,
                }))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!({ "imdb": imdb, "count": releases.len(), "releases": releases }))
    }
}

/// `btih` do magnet, minúsculo: hex de 40 ou base32 de 32.
pub fn info_hash(magnet: &str) -> Option<String> {
    let lower = magnet.to_ascii_lowercase();
    let start = lower.find("xt=urn:btih:")? + "xt=urn:btih:".len();
    let hash: String = lower[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    let hex = hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit());
    let b32 = hash.len() == 32 && hash.chars().all(|c| matches!(c, 'a'..='z' | '2'..='7'));
    (hex || b32).then_some(hash)
}
