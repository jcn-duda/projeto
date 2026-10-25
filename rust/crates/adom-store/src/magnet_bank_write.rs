//! Escrita do acervo: a captura da busca (`captureItems`) e a marca do filtro
//! (`markBankFilterOutcome`).
//!
//! Separado da leitura (worksForObraMany/sourcesForMany) porque é a parte com
//! transação e CAS: `last_seen` só avança e `passed_filter` só cede para um lote
//! de carimbo igual ou mais novo — o lost update da Fase 4.0.4.
//!
//! As duas operações de `magnet_work` são também API PÚBLICA de uma linha
//! (`upsert_work` / `mark_work_filter`, fatia T2-L4): o dono da tabela é este
//! crate e o escritor TS (`src/utils/magnet-bank-rows.ts`) não tem mais paridade
//! a manter. O SQL é UM só — as versões em lote e de uma linha compartilham os
//! helpers (`upsert::upsert_work` e `mark_work_row`).
//!
//! As REGRAS de qual linha gravar (merge de `magnet`/`magnet_source`, upgrade de
//! título, guardrail do item) vivem em `magnet_bank_capture.rs`, pela catraca de
//! 400 linhas; aqui fica só o SQL.

use std::collections::{HashMap, HashSet};

use adom_core::{extract_info_hash, magnet_display_name, release_work_targets, WorkTarget};
use adom_search::RawItem;
use rusqlite::{params, Connection};
use serde_json::Value;

use super::capture::{self, CaptureRow, SourceRow};
use super::upsert::{upsert_magnet, upsert_source, upsert_work};
use super::{tuple, MagnetBankStore};

/// Contexto da escrita do filtro (`markBankFilterOutcome`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkCtx {
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// `hashOf`: primeiro campo que rende um infoHash válido.
pub fn hash_of(item: &Value) -> String {
    let candidates = [
        item.get("infoHash"),
        item.get("magnet"),
        item.get("MagnetUri"),
        item.get("Guid"),
    ];
    for candidate in candidates.into_iter().flatten() {
        let text = match candidate {
            Value::String(text) => text.clone(),
            Value::Number(number) => number.to_string(),
            _ => continue,
        };
        if let Some(hash) = extract_info_hash(&text) {
            let lower = hash.trim().to_lowercase();
            if !lower.is_empty() {
                return lower;
            }
        }
    }
    String::new()
}

/// `hashesOf`: hashes únicos, na ordem, sem item de conta nem reserva.
fn hashes_of(items: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        if truthy(item.get("fromAccount")) || truthy(item.get("fromFallback")) {
            continue;
        }
        let hash = hash_of(item);
        if !hash.is_empty() && seen.insert(hash.clone()) {
            out.push(hash);
        }
    }
    out
}

/// `targetsFor`: obras extras por hash (packs que o título declara). Só entra
/// no mapa quando há MAIS DE UM alvo (o do pedido é o default do banco).
fn targets_for(items: &[Value], ctx: &WorkCtx) -> HashMap<String, Vec<(i64, i64)>> {
    let mut out: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
    let request = WorkTarget {
        season: ctx.season,
        episode: ctx.episode,
    };
    for item in items {
        if truthy(item.get("fromAccount")) || truthy(item.get("fromFallback")) {
            continue;
        }
        let hash = hash_of(item);
        if hash.is_empty() {
            continue;
        }
        let title = string_of(item.get("title"))
            .or_else(|| string_of(item.get("Title")))
            .unwrap_or_default();
        let dn = magnet_display_name(
            string_of(item.get("magnet")).as_deref(),
            string_of(item.get("MagnetUri")).as_deref(),
            string_of(item.get("Guid")).as_deref(),
        );
        let merged = out.entry(hash).or_default();
        for target in release_work_targets(&title, request, Some(dn.as_str()), "") {
            let pair = tuple(target.season, target.episode);
            if !merged.contains(&pair) {
                merged.push(pair);
            }
        }
    }
    out
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Null) | None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn string_of(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// `UPDATE` de UMA linha de `magnet_work` — a marca do filtro. `last_seen` é
/// `MAX` e `passed_filter` só cede para uma observação igual ou mais nova que a
/// linha (CAS contra o lote atrasado).
///
/// Devolve `rows_affected`: 0 = a linha não existe (fonte sem captura não cria
/// obra órfã). Uma implementação só, usada pela marca em lote
/// (`mark_filter_outcome`) e pela API de uma linha (`mark_work_filter`).
fn mark_work_row(
    conn: &Connection,
    hash: &str,
    imdb: &str,
    season: i64,
    episode: i64,
    passed: bool,
    now_ms: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE magnet_work SET passed_filter = CASE WHEN last_seen <= ?2 THEN ?1 ELSE passed_filter END, \
         last_seen = MAX(last_seen, ?2) WHERE hash = ?3 AND imdb = ?4 AND season = ?5 AND episode = ?6",
        params![if passed { 1 } else { 0 }, now_ms, hash, imdb, season, episode],
    )
}

impl MagnetBankStore {
    /// Upsert de UMA linha de `magnet_work` (dono único: `adom-store`).
    ///
    /// `first_seen` é fixo, `last_seen` é `MAX` e `passed_filter` NÃO é tocado —
    /// captura não reabre o filtro; quem escreve 0/1 é `mark_work_filter`. O SQL
    /// é o MESMO da captura em lote (`magnet_bank_upsert::upsert_work`), sem
    /// cópia.
    pub fn upsert_work(
        &self,
        hash: &str,
        imdb: &str,
        season: i64,
        episode: i64,
        last_seen_ms: i64,
    ) -> Result<(), String> {
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|err| format!("transação do magnet_work: {err}"))?;
        upsert_work(&tx, hash, imdb, season, episode, last_seen_ms)
            .map_err(|err| format!("magnet_work {hash}: {err}"))?;
        tx.commit()
            .map_err(|err| format!("commit do magnet_work: {err}"))
    }

    /// `markBankFilterOutcome` de UMA linha: grava `passed_filter` 1/0 e
    /// `last_seen` (`MAX`) numa linha que JÁ existe. `false` = nada atualizado
    /// (linha ausente: fonte sem captura não cria órfão).
    pub fn mark_work_filter(
        &self,
        hash: &str,
        imdb: &str,
        season: i64,
        episode: i64,
        passed: bool,
        now_ms: i64,
    ) -> Result<bool, String> {
        let conn = self.lock();
        let rows = mark_work_row(&conn, hash, imdb, season, episode, passed, now_ms)
            .map_err(|err| format!("magnet_work {hash}: {err}"))?;
        Ok(rows == 1)
    }

    /// `captureItems` + `applyOps`/`writeBatch`: grava a leva da busca NATIVA —
    /// `magnet`, `magnet_source` e `magnet_work` — em UMA transação (ou entra
    /// tudo, ou nada).
    ///
    /// Devolve quantos itens passaram pelo guardrail da captura (item de conta,
    /// de reserva, foto do índice e item sem hash ficam de fora), não quantas
    /// linhas mudaram.
    ///
    /// É I/O síncrono de SQLite: chame no FIM da busca, DEPOIS de montar a
    /// resposta, e trate o `Err` como log — o usuário não espera o disco.
    pub fn capture_items(
        &self,
        items: &[RawItem],
        source: &str,
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> Result<usize, String> {
        let mut magnets: Vec<CaptureRow> = Vec::new();
        let mut magnet_at: HashMap<String, usize> = HashMap::new();
        let mut sources: Vec<SourceRow> = Vec::new();
        let mut source_at: HashMap<(String, String), usize> = HashMap::new();
        let mut works: Vec<(String, i64, i64)> = Vec::new();
        let mut work_at: HashSet<(String, i64, i64)> = HashSet::new();
        let request = WorkTarget {
            season: ctx.season,
            episode: ctx.episode,
        };
        let mut accepted = 0usize;
        for item in items {
            let Some(row) = capture::capture_row(item, source) else {
                continue;
            };
            accepted += 1;
            let hash = row.hash.clone();
            let src = capture::source_row(&row);
            let key = (src.hash.clone(), src.indexer.clone());
            match source_at.get(&key).copied() {
                Some(at) => {
                    let prev = sources[at].clone();
                    sources[at] = capture::merge_source(prev, &src);
                }
                None => {
                    source_at.insert(key, sources.len());
                    sources.push(src);
                }
            }
            match magnet_at.get(&hash).copied() {
                Some(at) => {
                    let prev = magnets[at].clone();
                    magnets[at] = capture::merge_inputs(prev, row);
                }
                None => {
                    magnet_at.insert(hash.clone(), magnets.len());
                    magnets.push(row);
                }
            }
            if ctx.imdb_id.is_empty() {
                continue;
            }
            // A obra do PEDIDO nunca se perde; pack de temporada/série completa
            // acrescenta a obra declarada (mesma régua do release-index).
            let dn = item.dn();
            let dn = (!dn.is_empty()).then_some(dn.as_str());
            for target in release_work_targets(item.title_text(), request, dn, "") {
                let (season, episode) = tuple(target.season, target.episode);
                let pair = (hash.clone(), season, episode);
                if work_at.insert(pair.clone()) {
                    works.push(pair);
                }
            }
        }
        let mut conn = self.lock();
        let tx = conn
            .transaction()
            .map_err(|err| format!("transação da captura: {err}"))?;
        for row in &magnets {
            upsert_magnet(&tx, row, now_ms).map_err(|err| format!("magnet {}: {err}", row.hash))?;
        }
        for row in &sources {
            upsert_source(&tx, row, now_ms)
                .map_err(|err| format!("magnet_source {}: {err}", row.hash))?;
        }
        for (hash, season, episode) in &works {
            upsert_work(&tx, hash, &ctx.imdb_id, *season, *episode, now_ms)
                .map_err(|err| format!("magnet_work {hash}: {err}"))?;
        }
        tx.commit()
            .map_err(|err| format!("commit da captura: {err}"))?;
        Ok(accepted)
    }

    /// `markBankFilterOutcome`: grava `passed_filter` 1/0 e `last_seen` nas
    /// linhas que JÁ existem (fonte sem captura não cria órfão), por hash e por
    /// alvo, e devolve o boolean de `markFilterResult`. MONOTÔNICA (CAS contra o
    /// lote atrasado do Node): `last_seen` só avança, `passed_filter` só cede.
    pub fn mark_filter_outcome(
        &self,
        entered: &[Value],
        survivors: &[Value],
        ctx: &WorkCtx,
        now_ms: i64,
    ) -> bool {
        let all = hashes_of(entered);
        if all.is_empty() {
            return true;
        }
        let surviving: HashSet<String> = hashes_of(survivors).into_iter().collect();
        let targets = targets_for(entered, ctx);
        let request = tuple(ctx.season, ctx.episode);
        let mut conn = self.lock();
        let Ok(tx) = conn.transaction() else {
            return false;
        };
        for hash in &all {
            let list = targets
                .get(hash)
                .cloned()
                .filter(|list| list.len() > 1)
                .unwrap_or_else(|| vec![request]);
            for (season, episode) in list {
                let passed = surviving.contains(hash);
                // Mesmo SQL da API de uma linha: linha ausente é no-op (0 linhas).
                if mark_work_row(&tx, hash, &ctx.imdb_id, season, episode, passed, now_ms).is_err()
                {
                    return false;
                }
            }
        }
        tx.commit().is_ok()
    }
}
