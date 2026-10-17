//! Exposição NAPI da orquestração PURA de busca: plano do Jackett, orçamento da
//! coleta e cobertura por pool (`adom_core::search_plan`,
//! `adom_core::collection_budget`, `adom_core::search_pool_coverage`).
//!
//! A decisão continua no Rust; o Node só transporta. Nada aqui lê config,
//! runtime, cache ou rede: os valores de config chegam por argumento (quem os lê
//! é a casca TS) e o resultado volta sem I/O.
//!
//! # Contrato de fronteira
//!
//! Estruturas cruzam como STRING JSON (objeto/lista): o objeto de entrada é o
//! mesmo que a casca TS monta (`selectedIndexers`, `ptBrIndexers`, …) e a saída
//! é o JSON que ela faz `JSON.parse`. Números e booleanos vão como escalares
//! napi. Entrada inválida devolve `napi::Error` — nenhuma função daqui pode
//! panicar por causa do JSON.

use adom_core as core;
use napi_derive::napi;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Entradas (JSON)
// ---------------------------------------------------------------------------

/// Argumentos de `planJackettQueries`. Todos com default: só `query` e as duas
/// listas de indexers são obrigatórias no TS.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PlanInput {
    query: String,
    pt_query: Option<String>,
    selected_indexers: Vec<String>,
    pt_br_indexers: Vec<String>,
    isolate_indexers: Vec<String>,
    sweep_query: Option<String>,
    original_query: Option<String>,
    multi_work_query: Option<String>,
}

/// Argumentos de `liveIndexers` (`ptSweepIndexers` usa o mesmo shape parcial).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct IndexersInput {
    selected_indexers: Vec<String>,
    index_only_indexers: Vec<String>,
    exempt_indexers: Vec<String>,
    pt_br_indexers: Vec<String>,
}

/// Nomes da obra que as varreduras consultam.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TitlesInput {
    pt: Option<String>,
    en: Option<String>,
    original: Option<String>,
}

/// `{ titles }` — o objeto que o TS passa para as duas funções de varredura.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SweepInput {
    titles: Option<TitlesInput>,
}

fn parse_json<T: for<'de> Deserialize<'de>>(input: &str) -> napi::Result<T> {
    serde_json::from_str(input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))
}

fn to_json<T: serde::Serialize>(value: &T) -> napi::Result<String> {
    serde_json::to_string(value)
        .map_err(|e| napi::Error::from_reason(format!("saída JSON inválida: {e}")))
}

// ---------------------------------------------------------------------------
// Plano da coleta (`src/providers/search-plan.ts`)
// ---------------------------------------------------------------------------

/// `planJackettQueries`: devolve o plano em JSON (lista de tarefas com as
/// propriedades CONDICIONAIS omitidas, como o objeto JS do TS).
#[napi(catch_unwind)]
pub fn plan_jackett_queries(input: String) -> napi::Result<String> {
    let req: PlanInput = parse_json(&input)?;
    let tasks = core::plan_jackett_queries(
        &req.query,
        req.pt_query.as_deref(),
        &req.selected_indexers,
        &req.pt_br_indexers,
        &req.isolate_indexers,
        req.sweep_query.as_deref(),
        req.original_query.as_deref(),
        req.multi_work_query.as_deref(),
    );
    to_json(&tasks)
}

/// `liveIndexers`: os selecionados que continuam no plano AO VIVO (index-only
/// fora, exceto os isentos). Devolve a lista em JSON.
#[napi(catch_unwind)]
pub fn live_indexers(input: String) -> napi::Result<String> {
    let req: IndexersInput = parse_json(&input)?;
    let out = core::live_indexers(
        &req.selected_indexers,
        &req.index_only_indexers,
        &req.exempt_indexers,
    );
    to_json(&out)
}

/// `ptSweepIndexers`: os selecionados que NÃO são BR nem index-only.
#[napi(catch_unwind)]
pub fn pt_sweep_indexers(input: String) -> napi::Result<String> {
    let req: IndexersInput = parse_json(&input)?;
    let out = core::pt_sweep_indexers(
        &req.selected_indexers,
        &req.pt_br_indexers,
        &req.index_only_indexers,
    );
    to_json(&out)
}

/// `ptSweepQueryFor`: raiz pt-BR da varredura, ou `null`.
#[napi(catch_unwind)]
pub fn pt_sweep_query_for(input: String) -> napi::Result<Option<String>> {
    let req: SweepInput = parse_json(&input)?;
    let titles = req.titles.unwrap_or_default();
    Ok(core::pt_sweep_query_for(
        titles.pt.as_deref(),
        titles.original.as_deref(),
    ))
}

/// `ptSweepQuery`: a raiz de franquia do título pt, SEM o gate de "difere do
/// original" (`ptSweepQueryFor`). String vazia quando não há título.
#[napi(catch_unwind)]
pub fn pt_sweep_query(title_pt: Option<String>) -> String {
    core::pt_sweep_query(title_pt.as_deref())
}

/// `dubbedSweepQueryFor`: variante "<raiz> dublado" (só quando pt e original
/// comparam iguais), ou `null`.
#[napi(catch_unwind)]
pub fn dubbed_sweep_query_for(input: String) -> napi::Result<Option<String>> {
    let req: SweepInput = parse_json(&input)?;
    let titles = req.titles.unwrap_or_default();
    Ok(core::dubbed_sweep_query_for(
        titles.pt.as_deref(),
        titles.en.as_deref(),
        titles.original.as_deref(),
    ))
}

// ---------------------------------------------------------------------------
// Orçamento da coleta (`src/providers/collection-budget.ts`)
// ---------------------------------------------------------------------------

/// `computeCollectionBudget` com os valores de config por parâmetro.
#[napi(catch_unwind)]
pub fn compute_collection_budget(
    deadline_at: Option<i64>,
    now: i64,
    reply_deadline: i64,
    debrid_reserve: i64,
) -> i64 {
    core::compute_collection_budget(deadline_at, now, reply_deadline, debrid_reserve)
}

/// `computePriorityGrace` com os valores de config por parâmetro.
#[napi(catch_unwind)]
pub fn compute_priority_grace(
    br_partial_grace: i64,
    debrid_reserve: i64,
    debrid_check_floor: i64,
) -> i64 {
    core::compute_priority_grace(br_partial_grace, debrid_reserve, debrid_check_floor)
}

// ---------------------------------------------------------------------------
// Cobertura por pool (`src/providers/search-pool-coverage.ts`)
// ---------------------------------------------------------------------------

/// `poolCovered`: a lista de releases cruza como JSON (`[{title, …}]`).
///
/// `minSeeders` é o piso do melhor-swarm — a casca TS o lê da config viva e o
/// passa; o núcleo não conhece config.
#[napi(catch_unwind)]
pub fn pool_covered(
    items: String,
    season: Option<i64>,
    require_dubbed: bool,
    min_seeders: f64,
) -> napi::Result<bool> {
    let releases: Vec<core::PoolCoverageItem> = parse_json(&items)?;
    Ok(core::pool_covered(
        &releases,
        season,
        require_dubbed,
        min_seeders,
    ))
}

/// `idxPoolCovered`: devolve `{ covered, packOnly }` em JSON. O `packOnly` é o
/// que o TS conta em `search.idx.packOnly` — a contagem fica no chamador.
#[napi(catch_unwind)]
pub fn idx_pool_covered(
    releases: String,
    season: Option<i64>,
    episode: Option<i64>,
    min_seeders: f64,
) -> napi::Result<String> {
    let items: Vec<core::PoolCoverageItem> = parse_json(&releases)?;
    let out = core::idx_pool_covered(&items, season, episode, min_seeders);
    to_json(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plano_omite_propriedades_ausentes() {
        let out = plan_jackett_queries(
            json!({
                "query": "Joker 2019",
                "ptQuery": "Coringa 2019",
                "selectedIndexers": ["thepiratebay", "bludv-cardigann"],
                "ptBrIndexers": ["bludv-cardigann"],
            })
            .to_string(),
        )
        .expect("entrada válida");
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("saída JSON");
        assert_eq!(parsed.as_array().expect("lista").len(), 2);
        assert_eq!(parsed[0]["query"], json!("Joker 2019"));
        assert!(parsed[1].get("variant").is_none());
        assert_eq!(parsed[1]["fallback"], json!("Joker 2019"));
    }

    #[test]
    fn entrada_invalida_devolve_erro_sem_panico() {
        assert!(plan_jackett_queries("{".into()).is_err());
        assert!(live_indexers("\"nao-e-objeto\"".into()).is_err());
        assert!(pt_sweep_query_for("42".into()).is_err());
        assert!(pool_covered("{}".into(), None, false, 0.0).is_err());
        assert!(idx_pool_covered("null".into(), None, None, 0.0).is_err());
    }

    #[test]
    fn varreduras_devolvem_null_quando_nao_ha_pt() {
        let out = pt_sweep_query_for(json!({"titles": {"pt": null}}).to_string()).expect("ok");
        assert_eq!(out, None);
        let dubbed = dubbed_sweep_query_for(
            json!({"titles": {"pt": "Joker", "original": "Joker"}}).to_string(),
        )
        .expect("ok");
        assert_eq!(dubbed.as_deref(), Some("Joker dublado"));
    }

    #[test]
    fn orcamento_usa_o_piso_de_500() {
        assert_eq!(compute_collection_budget(None, 0, 9_200, 4_500), 4_700);
        assert_eq!(
            compute_collection_budget(Some(1_000), 2_000, 9_200, 4_500),
            500
        );
        assert_eq!(compute_priority_grace(1_500, 4_500, 1_500), 1_500);
    }

    #[test]
    fn cobertura_por_pool_devolve_json() {
        let releases = json!([{
            "hash": "A".repeat(40),
            "title": "Filme BR 1080p Dublado",
            "seeders": 0,
            "isBr": true,
        }])
        .to_string();
        let out = idx_pool_covered(releases, None, None, 3.0).expect("ok");
        let parsed: serde_json::Value = serde_json::from_str(&out).expect("JSON");
        assert_eq!(parsed["covered"], json!(true));
        assert_eq!(parsed["packOnly"], json!(false));
    }
}
