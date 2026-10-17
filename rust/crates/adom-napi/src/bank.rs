//! Fronteira napi da via do banco de magnets (`adom_core::search_bank`):
//! janela instantânea, lançamento recente e escolha de fonte.
//!
//! O TS lê `config.magnetBank.*` e as linhas do SQLite e passa os valores; o
//! núcleo não conhece config, banco nem relógio. Entradas e saídas cruzam como
//! JSON, no formato que as cascas TS de `magnet-bank-instant.ts` e
//! `magnet-bank-fallback.ts` montam.
//!
//! # Contrato de fronteira
//!
//! - `instantWindow`: `{works, meta, now, minMs, maxMs, freshMaxMs}` →
//!   `{windowMs, lastCollection, newest, stability, fresh}`.
//! - `isRecentRelease`: `{meta, now}` → booleano escalar.
//! - `pickSource`: `{sources, failed, allFailed}` → ÍNDICE da fonte (o TS mapeia
//!   de volta para a linha) ou `null`.
//!
//! O conjunto `failed` NÃO é normalizado — só o `indexer` da fonte; é o
//! comportamento do TS e o golden prende isso.
//!
//! O oráculo do golden é o TypeScript do worktree `../adom-esm`
//! (`npm run golden:magnet-bank-{instant,source}:check`).

use std::collections::HashSet;

use adom_core as core;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::json;

// ---------------------------------------------------------------------------
// Entradas (JSON)
// ---------------------------------------------------------------------------

/// Sinais de catálogo da obra, já na forma `String(...)` do TS.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct MetaInput {
    year: Option<String>,
    released: Option<String>,
    first_aired: Option<String>,
}

/// Linha de obra do banco (`null` na lista = linha ausente, como no laço do TS).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct WorkInput {
    passed_filter: i64,
    last_seen: i64,
    first_seen: i64,
}

/// Argumentos de `instantWindow`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct InstantWindowInput {
    works: Vec<Option<WorkInput>>,
    meta: Option<MetaInput>,
    now: i64,
    min_ms: i64,
    max_ms: i64,
    fresh_max_ms: i64,
}

/// Argumentos de `isRecentRelease`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RecentInput {
    meta: Option<MetaInput>,
    now: i64,
}

/// Linha de fonte do acervo, na forma que o `pickSource` consome.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SourceInput {
    indexer: String,
    last_seen: i64,
}

/// Argumentos de `pickSource`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PickSourceInput {
    sources: Vec<SourceInput>,
    failed: Vec<String>,
    all_failed: bool,
}

fn parse_json<T: for<'de> Deserialize<'de>>(input: &str) -> napi::Result<T> {
    serde_json::from_str(input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))
}

/// `String(meta.year ?? '')` etc. — a coerção fica na casca TS, que conhece os
/// tipos frouxos do metadado; aqui o contrato já é string.
fn meta_of(meta: Option<&MetaInput>) -> core::InstantMeta<'_> {
    match meta {
        Some(meta) => core::InstantMeta {
            year: meta.year.as_deref().unwrap_or_default(),
            released: meta.released.as_deref().unwrap_or_default(),
            first_aired: meta.first_aired.as_deref().unwrap_or_default(),
        },
        None => core::InstantMeta::default(),
    }
}

// ---------------------------------------------------------------------------
// Decisões
// ---------------------------------------------------------------------------

/// `instantWindow`: janela adaptativa em JSON.
#[napi(catch_unwind)]
pub fn instant_window(input: String) -> napi::Result<String> {
    let req: InstantWindowInput = parse_json(&input)?;
    let works: Vec<Option<core::WorkRow>> = req
        .works
        .iter()
        .map(|work| {
            work.as_ref().map(|work| core::WorkRow {
                passed_filter: work.passed_filter,
                last_seen: work.last_seen,
                first_seen: work.first_seen,
            })
        })
        .collect();
    let window = core::instant_window(
        &works,
        &meta_of(req.meta.as_ref()),
        req.now,
        req.min_ms,
        req.max_ms,
        req.fresh_max_ms,
    );
    serde_json::to_string(&json!({
        "windowMs": window.window_ms,
        "lastCollection": window.last_collection,
        "newest": window.newest,
        "stability": window.stability,
        "fresh": window.fresh,
    }))
    .map_err(|e| napi::Error::from_reason(format!("saída JSON inválida: {e}")))
}

/// `isRecentRelease`: lançamento recente (data ou ano de catálogo).
#[napi(catch_unwind)]
pub fn is_recent_release(input: String) -> napi::Result<bool> {
    let req: RecentInput = parse_json(&input)?;
    Ok(core::is_recent_release(
        &meta_of(req.meta.as_ref()),
        req.now,
    ))
}

/// `pickSource`: o ÍNDICE da fonte mais recente entre as elegíveis, ou `null`.
///
/// O TS mapeia o índice de volta para a linha (`sources[index]`); devolver o
/// índice é o que prova o empate do `reduce` ficando com a PRIMEIRA.
#[napi(catch_unwind)]
pub fn pick_source(input: String) -> napi::Result<Option<u32>> {
    let req: PickSourceInput = parse_json(&input)?;
    let sources: Vec<core::SourceRow<'_>> = req
        .sources
        .iter()
        .map(|source| core::SourceRow {
            indexer: &source.indexer,
            last_seen: source.last_seen,
        })
        .collect();
    let failed: HashSet<String> = req.failed.into_iter().collect();
    Ok(core::pick_source(&sources, &failed, req.all_failed).map(|index| index as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn janela_instantanea_devolve_json() {
        let out = instant_window(
            json!({
                "works": [{
                    "passedFilter": 1,
                    "lastSeen": 1_000_000_000_000_i64,
                    "firstSeen": 0,
                }],
                "meta": { "year": "2027", "released": null, "firstAired": null },
                "now": 1_799_971_200_000_i64,
                "minMs": 3_600_000,
                "maxMs": 86_400_000,
                "freshMaxMs": 7_200_000,
            })
            .to_string(),
        )
        .expect("entrada válida");
        let parsed: Value = serde_json::from_str(&out).expect("saída JSON");
        assert_eq!(parsed["windowMs"], json!(7_200_000));
        assert_eq!(parsed["fresh"], json!(true));
    }

    #[test]
    fn recente_usa_data_e_ano() {
        assert!(is_recent_release(
            json!({"meta": {"released": "2027-01-01"}, "now": 1_799_971_200_000_i64}).to_string()
        )
        .expect("ok"));
        assert!(!is_recent_release(
            json!({"meta": {"year": "2019"}, "now": 1_799_971_200_000_i64}).to_string()
        )
        .expect("ok"));
        assert!(!is_recent_release(json!({"meta": null, "now": 0}).to_string()).expect("ok"));
    }

    #[test]
    fn pick_source_devolve_o_indice_e_nao_normaliza_failed() {
        let sources = json!([
            { "indexer": "  BLUDV ", "lastSeen": 100 },
            { "indexer": "nerd", "lastSeen": 300 },
        ]);
        let out = pick_source(
            json!({ "sources": sources, "failed": ["bludv"], "allFailed": false }).to_string(),
        )
        .expect("ok");
        assert_eq!(out, Some(0));
        // O conjunto do TS não é normalizado: "NERD" não casa com "nerd".
        let out = pick_source(
            json!({ "sources": sources, "failed": ["NERD"], "allFailed": false }).to_string(),
        )
        .expect("ok");
        assert_eq!(out, None);
        let out =
            pick_source(json!({ "sources": sources, "failed": [], "allFailed": true }).to_string())
                .expect("ok");
        assert_eq!(out, Some(1));
    }

    #[test]
    fn entrada_invalida_devolve_erro_sem_panico() {
        assert!(instant_window("{".into()).is_err());
        assert!(is_recent_release("null".into()).is_err());
        assert!(pick_source("\"nao-e-objeto\"".into()).is_err());
    }
}
