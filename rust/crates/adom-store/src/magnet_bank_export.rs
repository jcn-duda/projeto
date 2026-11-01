//! EXPORT do NDJSON do acervo: porte byte-fiel do `exportLines` de
//! `src/utils/magnet-bank-transfer.ts` (cópia de segurança da aba Magnets).
//! Uma linha JSON por registro: `t` = `meta` (cabeçalho), `m` (magnet), `s`
//! (fonte) e `w` (obra), cada magnet seguido das SUAS fontes e obras.
//!
//! A ordem de chaves é a do `JSON.stringify` do TS (ordem de inserção): `t`
//! primeiro e depois as colunas na ordem do schema. Por isso a linha é montada
//! à mão com `format!` — o `json!` do serde ordenaria alfabeticamente e o
//! arquivo deixaria de ser idêntico ao do TS. O escape de strings é o próprio
//! `serde_json::to_string`, compatível com o `JSON.stringify` nos textos do
//! acervo. O reimport é o `import_ndjson` DESTE store: o teste do roundtrip
//! prova que export → import → export é estável byte a byte.

use std::collections::HashMap;
use std::io::Write;

use rusqlite::params;

use super::count_table;
use super::err_ctx;
use crate::MagnetBankStore;

/// Formato do arquivo (TRANSFER_FORMAT do TS), congelado no oráculo do import.
const TRANSFER_FORMAT: &str = "adom-magnet-bank";
/// Magnets por página (PAGE do TS): keyset pela PK, sem OFFSET (que relê tudo).
const PAGE: i64 = 500;
/// Fontes/obras por consulta em lote (chunk do `many()` do TS).
const MANY_CHUNK: usize = 200;

/// Texto JSON no escape exato do `JSON.stringify` (régua do TS).
fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

fn io_err(err: std::io::Error) -> String {
    format!("escrever o export: {err}")
}

/// Linha do magnet, na ordem de chaves do `{ t: 'm', ...m }` do TS (as flags
/// saem como número 0/1, como o `parseMagnet` do TS produz).
struct ExMagnet {
    hash: String,
    uri: String,
    title: String,
    size: i64,
    is_br: i64,
    dubbed: i64,
    quality: String,
    seeders_max: i64,
    seeders_last: i64,
    first_seen: i64,
    last_seen: i64,
    lied: i64,
}

fn magnet_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExMagnet> {
    Ok(ExMagnet {
        hash: row.get(0)?,
        uri: row.get(1)?,
        title: row.get(2)?,
        size: row.get(3)?,
        is_br: row.get(4)?,
        dubbed: row.get(5)?,
        quality: row.get(6)?,
        seeders_max: row.get(7)?,
        seeders_last: row.get(8)?,
        first_seen: row.get(9)?,
        last_seen: row.get(10)?,
        lied: row.get(11)?,
    })
}

impl ExMagnet {
    fn line(&self) -> String {
        format!(
            "{{\"t\":\"m\",\"hash\":{},\"uri\":{},\"title\":{},\"size\":{},\"isBr\":{},\
             \"dubbed\":{},\"quality\":{},\"seedersMax\":{},\"seedersLast\":{},\
             \"firstSeen\":{},\"lastSeen\":{},\"lied\":{}}}\n",
            js(&self.hash),
            js(&self.uri),
            js(&self.title),
            self.size,
            self.is_br,
            self.dubbed,
            js(&self.quality),
            self.seeders_max,
            self.seeders_last,
            self.first_seen,
            self.last_seen,
            self.lied,
        )
    }
}

/// Página do acervo em ordem de hash, depois de `after` (keyset: cada página é
/// um range scan pela PK; `after` vazio abre no início, como o `''` do TS).
fn page_magnets(conn: &rusqlite::Connection, after: &str) -> Result<Vec<ExMagnet>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT hash, uri, title, size, is_br, dubbed, quality, seeders_max, \
             seeders_last, first_seen, last_seen, lied \
             FROM magnet WHERE hash > ?1 ORDER BY hash LIMIT ?2",
        )
        .map_err(err_ctx("página do export"))?;
    let rows = stmt
        .query_map(params![after, PAGE], magnet_row)
        .map_err(err_ctx("página do export"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err_ctx("página do export"))?;
    Ok(rows)
}

/// `WHERE hash IN (chunk)` agrupado por hash, SEM ORDER BY (a ordem é a do
/// SQLite, como o `many()` do TS). O `render` devolve (hash, linha pronta).
fn grouped_lines(
    conn: &rusqlite::Connection,
    select: &str,
    hashes: &[String],
    ctx: &'static str,
    render: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<(String, String)>,
) -> Result<HashMap<String, Vec<String>>, String> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for chunk in hashes.chunks(MANY_CHUNK) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("{select} WHERE hash IN ({placeholders})");
        let mut stmt = conn.prepare(&sql).map_err(err_ctx(ctx))?;
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(chunk.iter().map(String::as_str)),
                &render,
            )
            .map_err(err_ctx(ctx))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_ctx(ctx))?;
        for (hash, line) in rows {
            out.entry(hash).or_default().push(line);
        }
    }
    Ok(out)
}

fn source_line(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String)> {
    let (hash, indexer, tracker): (String, String, String) =
        (row.get(0)?, row.get(1)?, row.get(2)?);
    let line = format!(
        "{{\"t\":\"s\",\"hash\":{},\"indexer\":{},\"tracker\":{},\"firstSeen\":{},\
         \"lastSeen\":{},\"seedersLast\":{}}}\n",
        js(&hash),
        js(&indexer),
        js(&tracker),
        row.get::<_, i64>(3)?,
        row.get::<_, i64>(4)?,
        row.get::<_, i64>(5)?,
    );
    Ok((hash, line))
}

fn work_line(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String)> {
    let (hash, imdb): (String, String) = (row.get(0)?, row.get(1)?);
    let line = format!(
        "{{\"t\":\"w\",\"hash\":{},\"imdb\":{},\"season\":{},\"episode\":{},\
         \"firstSeen\":{},\"lastSeen\":{},\"passedFilter\":{}}}\n",
        js(&hash),
        js(&imdb),
        row.get::<_, i64>(2)?,
        row.get::<_, i64>(3)?,
        row.get::<_, i64>(4)?,
        row.get::<_, i64>(5)?,
        row.get::<_, i64>(6)?,
    );
    Ok((hash, line))
}

impl MagnetBankStore {
    /// Escreve o acervo inteiro como NDJSON em `out` e devolve o número de
    /// linhas escritas. Assinatura FIXA (a fatia de transporte do painel
    /// consome). `now_ms` vira `exportedAt` do cabeçalho. Leitura sem
    /// transação, como o TS: o import do mesmo arquivo recria o acervo.
    pub fn export_ndjson_into<W: Write>(&self, out: &mut W, now_ms: i64) -> Result<u64, String> {
        let conn = self.lock();
        let header = format!(
            "{{\"t\":\"meta\",\"format\":{},\"v\":1,\"exportedAt\":{},\
             \"engine\":\"sql\",\"counts\":{{\"magnets\":{},\"sources\":{},\"works\":{}}}}}\n",
            js(TRANSFER_FORMAT),
            now_ms,
            count_table(&conn, "magnet")?,
            count_table(&conn, "magnet_source")?,
            count_table(&conn, "magnet_work")?,
        );
        out.write_all(header.as_bytes()).map_err(io_err)?;
        let mut lines: u64 = 1;
        let mut after = String::new();
        loop {
            let page = page_magnets(&conn, &after)?;
            if page.is_empty() {
                break;
            }
            let hashes: Vec<String> = page.iter().map(|m| m.hash.clone()).collect();
            let mut sources = grouped_lines(
                &conn,
                "SELECT hash, indexer, tracker, first_seen, last_seen, seeders_last \
                 FROM magnet_source",
                &hashes,
                "fontes do export",
                source_line,
            )?;
            let mut works = grouped_lines(
                &conn,
                "SELECT hash, imdb, season, episode, first_seen, last_seen, passed_filter \
                 FROM magnet_work",
                &hashes,
                "obras do export",
                work_line,
            )?;
            let mut chunk = String::new();
            for magnet in &page {
                chunk.push_str(&magnet.line());
                for line in sources.remove(&magnet.hash).unwrap_or_default() {
                    chunk.push_str(&line);
                }
                for line in works.remove(&magnet.hash).unwrap_or_default() {
                    chunk.push_str(&line);
                }
            }
            out.write_all(chunk.as_bytes()).map_err(io_err)?;
            lines += chunk.lines().count() as u64;
            after = page[page.len() - 1].hash.clone();
        }
        Ok(lines)
    }
}

#[cfg(test)]
#[path = "magnet_bank_export_tests.rs"]
mod tests;
