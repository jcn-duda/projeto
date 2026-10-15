//! Lote do ranking de streams (dedupe + sortAndLimit): UMA chamada napi devolve
//! a lista final, os hashes com waiver do piso, o relaxamento do filtro de
//! qualidade e os cortes de AMBAS as etapas (`dedupe_by_hash` →
//! `sort_and_limit`, que já compõe o dedupe internamente).
//!
//! O ganho vem do lote: por chamada o napi é mais lento que o TS (travessia de
//! string na fronteira), então só compensa mandar o pool inteiro de uma vez.
//!
//! # Contrato de fronteira
//!
//! Streams e drops cruzam como `serde_json::Value` (feature `serde-json` do
//! napi). O `RankingStream` do core já tem Serialize/Deserialize com os nomes
//! TS (`infoHash`, `_quality`, …) e preserva campos desconhecidos em `extra`,
//! então o objeto do Node entra e sai SEM os campos `_*` tipados aqui — e o
//! spread `{...winner}` do dedupe continua par com o TS. Campos nulos do
//! array de entrada (`Stream | null`) são descartados, como o `if (!s)
//! continue` do dedupe TS (sem registro de trace, igual).
//!
//! O callback `instant: (hash) => bool` do TS entra materializado
//! (`instant_hashes`), e o trace mutável não existe aqui: os cortes voltam em
//! `drops` na ordem do ledger TS (`dedupe`, `lie`, `min-seeders`,
//! `quality-filter`, `cam-excluded`, `size-limit`, `pool-cut`).

use std::collections::{HashMap, HashSet};

use adom_core::{
    dedupe_by_hash, sort_and_limit, DedupeInput, RankingStream, SortInput, SortOptions, TraceDrop,
};
use napi_derive::napi;
use serde_json::Value;

/// Entrada do `sortAndLimit` (com o dedupe interno), no formato do TS.
#[napi(object)]
pub struct RankingInput {
    /// Streams do pool pré-debrid; `null` no array é descartado.
    pub streams: Vec<Value>,
    /// Ordem de preferência de indexadores (vazio = sem prioridade).
    pub indexer_priority: Vec<String>,
    /// Piso de seeders com waiver BR dublado embutido.
    pub min_seeders: f64,
    pub max_results: f64,
    /// Whitelist de qualidade; vazio não filtra.
    pub quality_filter: Vec<String>,
    pub season: Option<f64>,
    pub episode: Option<f64>,
    pub prefer_dubbed: bool,
    /// Lido e descartado (paridade do contrato TS).
    pub dubbed_only: bool,
    pub exclude_cam: bool,
    /// `0` = sem teto de tamanho.
    pub max_size_gb: f64,
    /// Cotas por qualidade (`'2160p' | '1080p' | … | 'unknown'`).
    pub quality_limits: HashMap<String, f64>,
    pub br_reserved_slots: f64,
    pub br_reserved_per_quality: f64,
    pub candidate_factor: f64,
    pub br_first: bool,
    /// Hashes com play comprovado (o callback `instant` materializado).
    pub instant_hashes: Vec<String>,
}

/// Saída do ranking. Streams e drops saem no formato TS (`extra` preserva os
/// campos que o core não tipa).
#[napi(object)]
pub struct RankingOutput {
    pub streams: Vec<Value>,
    /// Hashes com waiver do piso (`search.brDubbed.seedFloorWaived`).
    pub waived_hashes: Vec<String>,
    /// Último recurso do qualityFilter (`search.qualityFilter.relaxed`).
    pub quality_relaxed: bool,
    /// Cortes de dedupe + sort, na ordem do ledger TS.
    pub drops: Vec<Value>,
}

/// Entrada do dedupe isolado (sombra/oráculo do `dedupeByHash` TS).
#[napi(object)]
pub struct DedupeArgs {
    pub streams: Vec<Value>,
    pub indexer_priority: Vec<String>,
}

/// Saída do dedupe isolado.
#[napi(object)]
pub struct DedupeResult {
    pub streams: Vec<Value>,
    pub drops: Vec<Value>,
}

fn parse_streams(values: &[Value]) -> Vec<RankingStream> {
    values
        .iter()
        .filter_map(|v| serde_json::from_value::<RankingStream>(v.clone()).ok())
        .collect()
}

fn drops_value(drops: &[TraceDrop]) -> Vec<Value> {
    drops
        .iter()
        .map(|d| serde_json::to_value(d).unwrap_or(Value::Null))
        .collect()
}

fn streams_value(streams: Vec<RankingStream>) -> Vec<Value> {
    streams
        .into_iter()
        .map(|s| serde_json::to_value(&s).unwrap_or(Value::Null))
        .collect()
}

/// `Option<f64>` do JS (o `number` aceita fracionário; temporada/episódio não
/// chegam fracionários, mas o `Number()` do TS também trunca por aqui).
fn opt_i64(v: Option<f64>) -> Option<i64> {
    v.filter(|n| n.is_finite()).map(|n| n as i64)
}

fn sort_options_of(input: &RankingInput) -> SortOptions {
    SortOptions {
        min_seeders: input.min_seeders,
        max_results: input.max_results,
        quality_filter: input.quality_filter.clone(),
        season: opt_i64(input.season),
        episode: opt_i64(input.episode),
        prefer_dubbed: input.prefer_dubbed,
        dubbed_only: input.dubbed_only,
        exclude_cam: input.exclude_cam,
        max_size_gb: input.max_size_gb,
        quality_limits: input.quality_limits.clone(),
        br_reserved_slots: input.br_reserved_slots,
        br_reserved_per_quality: input.br_reserved_per_quality,
        candidate_factor: input.candidate_factor,
        br_first: input.br_first,
        indexer_priority: input.indexer_priority.clone(),
    }
}

/// Dedupe por hash + sort/corte do pool, numa travessia. O `sort_and_limit` do
/// core já abre com o `dedupe_by_hash` (mesmo trace), então uma chamada cobre
/// as duas etapas.
#[napi(catch_unwind)]
pub fn evaluate_stream_ranking(input: RankingInput) -> RankingOutput {
    let instant: HashSet<String> = input.instant_hashes.iter().cloned().collect();
    let out = sort_and_limit(&SortInput {
        streams: parse_streams(&input.streams),
        options: sort_options_of(&input),
        instant_hashes: instant,
    });
    RankingOutput {
        streams: streams_value(out.streams),
        waived_hashes: out.waived_hashes,
        quality_relaxed: out.quality_relaxed,
        drops: drops_value(&out.drops),
    }
}

/// Dedupe isolado, para a sombra/oráculo medir a etapa solta.
#[napi(catch_unwind)]
pub fn dedupe_by_hash_napi(input: DedupeArgs) -> DedupeResult {
    let out = dedupe_by_hash(&DedupeInput {
        streams: parse_streams(&input.streams),
        indexer_priority: input.indexer_priority,
    });
    DedupeResult {
        streams: streams_value(out.streams),
        drops: drops_value(&out.drops),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(streams: Vec<Value>) -> RankingInput {
        RankingInput {
            streams,
            indexer_priority: Vec::new(),
            min_seeders: 0.0,
            max_results: 40.0,
            quality_filter: Vec::new(),
            season: None,
            episode: None,
            prefer_dubbed: false,
            dubbed_only: false,
            exclude_cam: false,
            max_size_gb: 0.0,
            quality_limits: HashMap::new(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            candidate_factor: 1.0,
            br_first: true,
            instant_hashes: Vec::new(),
        }
    }

    #[test]
    fn pool_vazio_devolve_vazio() {
        let out = evaluate_stream_ranking(input(Vec::new()));
        assert!(out.streams.is_empty());
        assert!(out.drops.is_empty());
        assert!(!out.quality_relaxed);
        assert!(out.waived_hashes.is_empty());
    }

    #[test]
    fn nulos_no_array_sao_descartados_sem_trace() {
        let out = evaluate_stream_ranking(input(vec![
            Value::Null,
            json!({
                "infoHash": "a".repeat(40), "name": "Filme", "_seeders": 5.0,
            }),
        ]));
        assert_eq!(out.streams.len(), 1);
        assert!(out.drops.is_empty());
    }

    #[test]
    fn waives_marcam_hash_e_sobrevivem_ao_piso() {
        let mut inp = input(vec![json!({
            "infoHash": "b".repeat(40), "name": "Filme DUBLADO",
            "_seeders": 0.0, "_br": true, "_dubbed": true,
        })]);
        inp.min_seeders = 5.0;
        let out = evaluate_stream_ranking(inp);
        assert_eq!(out.waived_hashes, vec!["b".repeat(40)]);
        // `_seedFloorWaived` sai como campo do objeto (o `extra` vira topo).
        assert_eq!(out.streams[0]["_seedFloorWaived"], json!(true));
        // `_seeders`/`_size` morrem na saída, como o destruturing do TS.
        assert!(out.streams[0].get("_seeders").is_none());
    }

    #[test]
    fn campos_desconhecidos_preservados() {
        let out = evaluate_stream_ranking(input(vec![json!({
            "infoHash": "c".repeat(40), "name": "Filme", "_seeders": 9.0,
            "url": "magnet:?x=1", "customMark": "xyz",
        })]));
        assert_eq!(out.streams[0]["customMark"], json!("xyz"));
        assert_eq!(out.streams[0]["url"], json!("magnet:?x=1"));
    }

    #[test]
    fn drops_de_dedupe_e_sort_na_ordem_do_ledger() {
        let hash = "d".repeat(40);
        let mut inp = input(vec![
            json!({"infoHash": hash, "name": "A", "_seeders": 1.0}),
            json!({"infoHash": hash, "name": "B", "_seeders": 7.0}),
            json!({"infoHash": "e".repeat(40), "name": "C", "_seeders": 0.0}),
        ]);
        inp.min_seeders = 5.0;
        let out = evaluate_stream_ranking(inp);
        let reasons: Vec<&str> = out
            .drops
            .iter()
            .filter_map(|d| d["reason"].as_str())
            .collect();
        assert_eq!(reasons, vec!["dedupe", "min-seeders"]);
        assert_eq!(out.drops[1]["label"], json!("C"));
    }

    #[test]
    fn dedupe_isolado_preserva_ordem_de_vitoria() {
        let hash = "f".repeat(40);
        let out = dedupe_by_hash_napi(DedupeArgs {
            streams: vec![
                json!({"infoHash": hash, "name": "A", "_seeders": 1.0}),
                json!({"infoHash": hash, "name": "B", "_seeders": 7.0}),
            ],
            indexer_priority: Vec::new(),
        });
        assert_eq!(out.streams.len(), 1);
        assert_eq!(out.streams[0]["name"], json!("B"));
        assert_eq!(out.drops.len(), 1);
    }
}
