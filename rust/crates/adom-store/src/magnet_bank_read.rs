//! LEITURA do banco de magnets vivo para o PAINEL do gateway: porte fiel de
//! `status()`/`stats()` (`src/utils/magnet-bank.ts`) e de `searchBank`
//! (`src/utils/magnet-bank-search.ts`) para a API administrativa.
//!
//! O JSON do status é o MESMO da ação `magnet-bank-summary` do Node (totais,
//! último visto global e quebra por indexer); o da busca é o MESMO da ação
//! `magnet-bank-search` (modos hash/título/recentes, janela `limit + 1` para
//! provar truncamento sem COUNT, resposta por allowlist de campos). O
//! kill-switch chega pronto: o parâmetro `enabled` de `bank_status` carrega
//! `MAGNET_BANK` e, desligado, devolve o formato `disabled` SEM tocar o SQLite
//! (no TS o banco nem abre). Para a busca não há parâmetro de kill: quem chama
//! não deve fazê-lo com o banco desligado (o store nem existe nesse caso).
//!
//! Query inválida NÃO é falha de sistema: devolve `Ok` com `{"ok":false,
//! "error":…}` — no TS isso vira HTTP 400; `Err` fica para erro de SQLite
//! (que lá vira 500).

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::MagnetBankStore;

/// Teto duro da busca do painel (`BANK_SEARCH_MAX` do TS).
const BANK_SEARCH_MAX: i64 = 100;
/// Default do `clampLimit` quando o pedido é `<= 0` ou inválido.
const DEFAULT_LIMIT: i64 = 50;
/// Teto de caracteres da query (`MAX_QUERY_LENGTH` do TS).
const MAX_QUERY_CHARS: usize = 120;
/// Mínimo de caracteres para buscar por título (`MIN_TITLE_LENGTH` do TS).
const MIN_TITLE_CHARS: usize = 2;
/// `queueMax` default do TS (`config.magnetBank.queueMax ?? 500`). O lado
/// nativo não tem fila (a captura é síncrona no fim da busca), então `queue`
/// é sempre 0 e este teto só repõe o campo do JSON.
const QUEUE_MAX_DEFAULT: i64 = 500;

/// Colunas do magnet na ordem dos três SELECTs das buscas.
const MAGNET_SELECT: &str = "SELECT hash, uri, title, size, is_br, dubbed, quality, seeders_max, \
     seeders_last, first_seen, last_seen, lied FROM magnet";

/// (hash, item projetado) de cada linha de magnet, na ordem do SELECT.
type MagnetRows = Vec<(String, Value)>;

impl MagnetBankStore {
    /// Panorama do banco para o painel — o JSON da ação `magnet-bank-summary`:
    /// totais das três tabelas, último visto (MAX de `last_seen` de magnet e
    /// magnet_source) e a quebra por indexer numa ÚNICA consulta (GROUP BY usa
    /// o índice `magnet_source_indexer`; sem N+1, como o TS). Com `enabled`
    /// falso, responde o formato desligado sem ler o disco.
    pub fn bank_status(&self, now_ms: i64, enabled: bool) -> Result<serde_json::Value, String> {
        // O JSON do status não carrega relógio no TS; o parâmetro fica
        // reservado para a rota (contrato fixo com o painel).
        let _ = now_ms;
        if !enabled {
            // Kill-switch (`MAGNET_BANK=false`): o TS nem abre o banco.
            return Ok(json!({
                "enabled": false, "engine": "disabled",
                "magnets": 0, "sources": 0, "works": 0, "lastSeen": 0,
                "byIndexer": [], "memoryMax": null, "memoryEvictions": 0,
                "queue": 0, "queueMax": QUEUE_MAX_DEFAULT,
            }));
        }
        let conn = self.lock();
        let magnets = count_table(&conn, "magnet")?;
        let sources = count_table(&conn, "magnet_source")?;
        let works = count_table(&conn, "magnet_work")?;
        let last_seen = max_last_seen(&conn, "magnet")?.max(max_last_seen(&conn, "magnet_source")?);
        let mut stmt = conn
            .prepare(
                "SELECT indexer, COUNT(*), COUNT(*), COALESCE(MAX(last_seen), 0) \
                 FROM magnet_source GROUP BY indexer ORDER BY last_seen DESC, indexer ASC",
            )
            .map_err(err_ctx("quebra por indexer do status"))?;
        let by_indexer = stmt
            .query_map([], |row| {
                Ok(json!({
                    "indexer": row.get::<_, String>(0)?,
                    // `hashes` é COUNT(*), não COUNT(DISTINCT hash): a PK é
                    // (hash, indexer), então cada hash aparece uma vez por
                    // grupo — o DISTINCT obrigava a ler a tabela inteira.
                    "hashes": row.get::<_, i64>(1)?,
                    "sources": row.get::<_, i64>(2)?,
                    "lastSeen": row.get::<_, i64>(3)?,
                }))
            })
            .map_err(err_ctx("quebra por indexer do status"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_ctx("quebra por indexer do status"))?;
        Ok(json!({
            "enabled": true, "engine": "sql",
            "magnets": magnets, "sources": sources, "works": works, "lastSeen": last_seen,
            "byIndexer": by_indexer,
            // Teto/despejos só existem na engine de memória do TS; o SQLite é
            // acervo permanente e o painel distingue os dois.
            "memoryMax": null, "memoryEvictions": 0,
            "queue": 0, "queueMax": QUEUE_MAX_DEFAULT,
        }))
    }

    /// Busca read-only do painel — o JSON da ação `magnet-bank-search`. `q` é
    /// hash de 40 hex (case-insensitive, normalizado para a PK) OU substring de
    /// título (mín. 2 chars) OU vazio (os mais recentes); `limit <= 0` cai no
    /// default 50 e o teto é 100. Query vazia NUNCA varre o banco inteiro.
    pub fn bank_search(&self, q: &str, limit: i64) -> Result<serde_json::Value, String> {
        let query = q.trim();
        if query.chars().count() > MAX_QUERY_CHARS {
            return Ok(json!({ "ok": false, "error": "consulta acima de 120 caracteres" }));
        }
        let limit = if limit > 0 {
            limit.min(BANK_SEARCH_MAX)
        } else {
            DEFAULT_LIMIT
        };
        let mode = if query.is_empty() {
            "recent"
        } else if is_info_hash(query) {
            "hash"
        } else {
            "title"
        };
        if mode == "title" && query.chars().count() < MIN_TITLE_CHARS {
            return Ok(json!({
                "ok": false,
                "error": "informe ao menos 2 caracteres para buscar por título",
            }));
        }
        // Hash vai minúsculo (PK do banco); título segue como o operador digitou.
        let normalized = if mode == "hash" {
            query.to_lowercase()
        } else {
            query.to_string()
        };
        let (rows, truncated) = match mode {
            "hash" => (self.magnets_by_hash(&normalized)?, false),
            "title" => window(self.magnets_by_title(query, limit + 1)?, limit),
            _ => window(self.recent_magnets(limit + 1)?, limit),
        };
        // Fontes e obras em DUAS consultas em lote (sem N+1). Teto de 100
        // itens: cabe num único chunk de 200 do `many()` do TS.
        let hashes: Vec<String> = rows.iter().map(|(hash, _)| hash.clone()).collect();
        let mut sources = self.sources_for_search(&hashes)?;
        let mut works = self.works_for_search(&hashes)?;
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(hash, mut item)| {
                item["sources"] = sources.remove(&hash).unwrap_or_default().into();
                item["works"] = works.remove(&hash).unwrap_or_default().into();
                item
            })
            .collect();
        let returned = items.len() as i64;
        Ok(json!({
            "ok": true, "mode": mode, "query": normalized, "limit": limit,
            // Janela `limit + 1`: truncado, o total exato é desconhecido (null).
            "matched": if truncated { Value::Null } else { Value::from(returned) },
            "returned": returned, "truncated": truncated, "items": items,
        }))
    }

    /// Linha única da PK (`getMagnet` do TS).
    fn magnets_by_hash(&self, hash: &str) -> Result<MagnetRows, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!("{MAGNET_SELECT} WHERE hash = ?1"))
            .map_err(err_ctx("buscar magnet por hash"))?;
        let rows = stmt
            .query_map(params![hash], magnet_row)
            .map_err(err_ctx("buscar magnet por hash"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_ctx("buscar magnet por hash"))?;
        Ok(rows)
    }

    /// `searchMagnetsByTitle`: OR das variantes de caixa (1..3), ORDER BY
    /// `last_seen` DESC e LIMIT da janela.
    fn magnets_by_title(&self, query: &str, window_size: i64) -> Result<MagnetRows, String> {
        let patterns: Vec<String> = title_variants(query)
            .iter()
            .map(|v| like_pattern(v))
            .collect();
        let clauses = vec!["title LIKE ? ESCAPE '\\'"; patterns.len()].join(" OR ");
        let sql = format!(
            "{MAGNET_SELECT} WHERE {clauses} ORDER BY last_seen DESC LIMIT ?{}",
            patterns.len() + 1
        );
        let mut args: Vec<rusqlite::types::Value> = patterns
            .iter()
            .map(|p| rusqlite::types::Value::Text(p.clone()))
            .collect();
        args.push(rusqlite::types::Value::Integer(window_size));
        let conn = self.lock();
        let mut stmt = conn.prepare(&sql).map_err(err_ctx("busca por título"))?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args), magnet_row)
            .map_err(err_ctx("busca por título"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_ctx("busca por título"))?;
        Ok(rows)
    }

    /// `listRecentMagnets`: os mais recentes, com LIMIT — comportamento seguro
    /// da query vazia (nunca devolve o banco inteiro).
    fn recent_magnets(&self, window_size: i64) -> Result<MagnetRows, String> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(&format!("{MAGNET_SELECT} ORDER BY last_seen DESC LIMIT ?1"))
            .map_err(err_ctx("recentes do banco"))?;
        let rows = stmt
            .query_map(params![window_size], magnet_row)
            .map_err(err_ctx("recentes do banco"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err_ctx("recentes do banco"))?;
        Ok(rows)
    }

    /// Fontes projetadas por hash: sem `hash` no payload, como o `toSource`.
    fn sources_for_search(&self, hashes: &[String]) -> Result<HashMap<String, Vec<Value>>, String> {
        grouped_by_hash(
            &self.lock(),
            "SELECT hash, indexer, tracker, first_seen, last_seen, seeders_last \
             FROM magnet_source",
            hashes,
            "fontes da busca",
            |row| {
                Ok(json!({
                    "indexer": row.get::<_, String>(1)?,
                    "tracker": row.get::<_, String>(2)?,
                    "firstSeen": row.get::<_, i64>(3)?,
                    "lastSeen": row.get::<_, i64>(4)?,
                    "seedersLast": row.get::<_, i64>(5)?,
                }))
            },
        )
    }

    /// Obras projetadas por hash: `season`/`episode` saem como estão no banco
    /// (-1 = nulo, parte da PK) e `passed_filter` vira booleano.
    fn works_for_search(&self, hashes: &[String]) -> Result<HashMap<String, Vec<Value>>, String> {
        grouped_by_hash(
            &self.lock(),
            "SELECT hash, imdb, season, episode, first_seen, last_seen, passed_filter \
             FROM magnet_work",
            hashes,
            "obras da busca",
            |row| {
                Ok(json!({
                    "imdb": row.get::<_, String>(1)?,
                    "season": row.get::<_, i64>(2)?,
                    "episode": row.get::<_, i64>(3)?,
                    "firstSeen": row.get::<_, i64>(4)?,
                    "lastSeen": row.get::<_, i64>(5)?,
                    "passedFilter": row.get::<_, i64>(6)? == 1,
                }))
            },
        )
    }

    /// URI gravada do magnet por hash — porte do `lookup` (`magnet-bank-read.ts`):
    /// PK em minúsculas, `now_ms` reservado (a leitura não tem relógio) e a URI
    /// sai TAL COMO foi gravada — dn/tracker foram resolvidos no WRITE. Linha
    /// ausente é `None`; URI vazia fica `Some("")` (o TS testa truthiness).
    pub fn bank_lookup_uri(&self, hash: &str, now_ms: i64) -> Result<Option<String>, String> {
        let _ = now_ms;
        self.lock()
            .query_row(
                "SELECT uri FROM magnet WHERE hash = ?1",
                params![hash.to_lowercase()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(err_ctx("lookup do banco de magnets"))
    }
}

/// Linha do magnet com a allowlist do TS (`toItem`): flags viram booleano.
/// Junto, a PK (hash) para agrupar fontes/obras depois.
fn magnet_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, Value)> {
    Ok((
        row.get::<_, String>(0)?,
        json!({
            "hash": row.get::<_, String>(0)?,
            "uri": row.get::<_, String>(1)?,
            "title": row.get::<_, String>(2)?,
            "size": row.get::<_, i64>(3)?,
            "isBr": row.get::<_, i64>(4)? == 1,
            "dubbed": row.get::<_, i64>(5)? == 1,
            "quality": row.get::<_, String>(6)?,
            "seedersMax": row.get::<_, i64>(7)?,
            "seedersLast": row.get::<_, i64>(8)?,
            "firstSeen": row.get::<_, i64>(9)?,
            "lastSeen": row.get::<_, i64>(10)?,
            "lied": row.get::<_, i64>(11)? == 1,
        }),
    ))
}

/// Corta a janela `limit + 1` no teto: `truncated` prova o corte SEM pagar um
/// COUNT exato em cima da varredura (mesmo truque do TS).
fn window(rows: MagnetRows, limit: i64) -> (MagnetRows, bool) {
    let truncated = rows.len() as i64 > limit;
    if truncated {
        (rows.into_iter().take(limit as usize).collect(), true)
    } else {
        (rows, false)
    }
}

/// `^[a-f0-9]{40}$` case-insensitive (o `HASH_RE` do TS).
fn is_info_hash(query: &str) -> bool {
    query.len() == 40 && query.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Variantes ÚNICAS de caixa (original + lower/upper Unicode, máx. 3): o LIKE
/// do SQLite só casefolda ASCII, então quem fecha o acento (`Épico` ×
/// `épico`/`ÉPICO`) é a VARIANTE da query, não um operador novo.
fn title_variants(query: &str) -> Vec<String> {
    let mut out = vec![query.to_string()];
    for variant in [query.to_lowercase(), query.to_uppercase()] {
        if !out.contains(&variant) {
            out.push(variant);
        }
    }
    out
}

/// `%texto%` com escape dos curingas (`%`/`_`) e do próprio `\`: sem ESCAPE,
/// um `%` digitado pelo operador varreria a tabela inteira.
fn like_pattern(substring: &str) -> String {
    let escaped = substring
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// `… WHERE hash IN (…)` agrupado por hash (o `many()` do TS: sem ORDER BY, a
/// ordem é a do SQLite). O nome da tabela é literal interno, nunca input.
fn grouped_by_hash(
    conn: &Connection,
    select: &str,
    hashes: &[String],
    ctx: &'static str,
    project: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<Value>,
) -> Result<HashMap<String, Vec<Value>>, String> {
    let mut out: HashMap<String, Vec<Value>> = HashMap::new();
    if hashes.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; hashes.len()].join(",");
    let sql = format!("{select} WHERE hash IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(err_ctx(ctx))?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(hashes.iter().map(|s| s.as_str())),
            |row| Ok((row.get::<_, String>(0)?, project(row)?)),
        )
        .map_err(err_ctx(ctx))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err_ctx(ctx))?;
    for (hash, item) in rows {
        out.entry(hash).or_default().push(item);
    }
    Ok(out)
}

fn count_table(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .map_err(err_ctx("contagem do status"))
}

/// `COALESCE(MAX(last_seen), 0)`: banco vazio é 0, como o TS.
fn max_last_seen(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COALESCE(MAX(last_seen), 0) FROM {table}"),
        [],
        |row| row.get(0),
    )
    .map_err(err_ctx("último visto do status"))
}

/// Mensagem de erro do SQLite com contexto fixo (o texto vai ao log da rota).
fn err_ctx(ctx: &'static str) -> impl Fn(rusqlite::Error) -> String {
    move |e| format!("{ctx}: {e}")
}

// Export NDJSON do acervo (régua byte-fiel do `exportLines` do TS) — catraca.
#[path = "magnet_bank_export.rs"]
pub(crate) mod export;

// Testes embutidos aqui (e não no `magnet_bank.rs`) porque o arquivo-pai
// estava a 5 linhas do teto de 400.
#[cfg(test)]
#[path = "magnet_bank_read_tests.rs"]
mod read_tests;
