//! SQL do upsert das três tabelas do acervo (`magnet`, `magnet_source`,
//! `magnet_work`), um helper por tabela.
//!
//! Separado de `magnet_bank_write.rs` pela catraca de 400 linhas: lá ficam o
//! laço da captura e a transação (o `writeBatch`); aqui, o `INSERT` de cada
//! linha. As REGRAS de merge vivem em `magnet_bank_capture.rs` — este módulo só
//! persiste a linha já resolvida e aplica o CAS de `magnet_work`.
//!
//! Regras que o SQL garante e não podem se perder:
//! `first_seen` é fixo; `last_seen` é `MAX` (leva atrasada não reduz); e
//! `passed_filter` só cede para uma observação cujo `last_seen` seja >= o lido
//! (`readLastSeen` do Node, o lost update da Fase 4.0.4).

use rusqlite::{params, OptionalExtension, Transaction};

use super::capture::{self, CaptureRow, SourceRow};

/// Linha de `magnet` já gravada + os carimbos que o `CaptureRow` não guarda.
struct StoredMagnet {
    row: CaptureRow,
    first_seen: i64,
    last_seen: i64,
}

/// `getMagnet` do `applyOps`: lê a linha atual DENTRO da transação (o merge é
/// feito em memória com as mesmas regras do `mergeMagnet`).
fn stored_magnet(tx: &Transaction<'_>, hash: &str) -> rusqlite::Result<Option<StoredMagnet>> {
    tx.query_row(
        "SELECT uri, title, size, is_br, dubbed, lied, quality, seeders_max, seeders_last, \
         first_seen, last_seen FROM magnet WHERE hash = ?1",
        params![hash],
        |row| {
            Ok(StoredMagnet {
                row: CaptureRow {
                    hash: hash.to_string(),
                    uri: row.get(0)?,
                    title: row.get(1)?,
                    size: row.get(2)?,
                    is_br: row.get(3)?,
                    dubbed: row.get(4)?,
                    lied: row.get(5)?,
                    quality: row.get(6)?,
                    seeders_max: row.get(7)?,
                    seeders_last: row.get(8)?,
                    ..CaptureRow::default()
                },
                first_seen: row.get(9)?,
                last_seen: row.get(10)?,
            })
        },
    )
    .optional()
}

/// Upsert de `magnet`: `INSERT OR REPLACE` com a linha JÁ mesclada (uri mais
/// rica, título com upgrade de episódio, flags OR, `seeders_max` máximo e
/// `seeders_last` preservado quando o item não trouxe número).
///
/// `first_seen` é fixo e `last_seen` é `MAX`: uma leva atrasada (relógio para
/// trás) não rejuvenece nem rejuvenesce a linha.
pub(super) fn upsert_magnet(
    tx: &Transaction<'_>,
    row: &CaptureRow,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let (merged, first_seen, last_seen) = match stored_magnet(tx, &row.hash)? {
        Some(prev) => (
            capture::merge_stored(prev.row, row.clone()),
            prev.first_seen,
            prev.last_seen.max(now_ms),
        ),
        None => (row.clone(), now_ms, now_ms),
    };
    tx.execute(
        "INSERT OR REPLACE INTO magnet (hash, uri, title, size, is_br, dubbed, quality, \
         seeders_max, seeders_last, first_seen, last_seen, lied) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            merged.hash,
            merged.uri,
            merged.title,
            merged.size,
            merged.is_br,
            merged.dubbed,
            merged.quality,
            merged.seeders_max,
            merged.seeders_last.unwrap_or(0),
            first_seen,
            last_seen,
            merged.lied
        ],
    )?;
    Ok(())
}

/// Upsert de `magnet_source`: `first_seen` fixo, `last_seen` `MAX`, tracker do
/// primeiro que soube e `seeders_last` preservado quando não veio número.
pub(super) fn upsert_source(
    tx: &Transaction<'_>,
    row: &SourceRow,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let prev = tx
        .query_row(
            "SELECT tracker, seeders_last, first_seen, last_seen FROM magnet_source \
             WHERE hash = ?1 AND indexer = ?2",
            params![row.hash, row.indexer],
            |r| {
                Ok((
                    SourceRow {
                        hash: row.hash.clone(),
                        indexer: row.indexer.clone(),
                        tracker: r.get(0)?,
                        seeders_last: r.get(1)?,
                    },
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    let (merged, first_seen, last_seen) = match prev {
        Some((prev, first, last)) => (capture::merge_source(prev, row), first, last.max(now_ms)),
        None => (row.clone(), now_ms, now_ms),
    };
    tx.execute(
        "INSERT OR REPLACE INTO magnet_source (hash, indexer, tracker, first_seen, last_seen, \
         seeders_last) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            merged.hash,
            merged.indexer,
            merged.tracker,
            first_seen,
            last_seen,
            merged.seeders_last.unwrap_or(0)
        ],
    )?;
    Ok(())
}

/// Upsert de `magnet_work` com o CAS do `workStmt` do Node (`readLastSeen`):
/// `last_seen` é `MAX` e `passed_filter` só é sobrescrito quando a linha não
/// andou desde a leitura — o veredito do gateway nunca é atropelado.
///
/// Captura NÃO reseta (`resetPassedFilter: false`): a obra nova nasce 0 e a
/// existente PRESERVA o valor. Quem escreve 0/1 é a marca do filtro.
pub(super) fn upsert_work(
    tx: &Transaction<'_>,
    hash: &str,
    imdb: &str,
    season: i64,
    episode: i64,
    now_ms: i64,
) -> rusqlite::Result<()> {
    let prev = tx
        .query_row(
            "SELECT passed_filter, last_seen, first_seen FROM magnet_work \
             WHERE hash = ?1 AND imdb = ?2 AND season = ?3 AND episode = ?4",
            params![hash, imdb, season, episode],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let (passed, first_seen, read_last_seen) = match prev {
        Some((passed, last, first)) => (passed, first, Some(last)),
        None => (0, now_ms, None),
    };
    tx.execute(
        "INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT (hash, imdb, season, episode) DO UPDATE SET \
         first_seen = MIN(magnet_work.first_seen, excluded.first_seen), \
         last_seen = MAX(magnet_work.last_seen, excluded.last_seen), \
         passed_filter = CASE WHEN ?8 IS NULL OR magnet_work.last_seen <= ?8 \
         THEN excluded.passed_filter ELSE magnet_work.passed_filter END",
        params![
            hash,
            imdb,
            season,
            episode,
            first_seen,
            now_ms,
            passed,
            read_last_seen
        ],
    )?;
    Ok(())
}
