//! Fronteira napi das cotas avulsas de `src/utils/stream-quotas.ts` e
//! `stream-quotas-candidate.ts`: `limitByQuality`, `limitByQualityAndIndexer`
//! e `selectQualityCandidates`. A regra mora em
//! `adom_core::stream_quotas_extra` (golden `stream-quotas-extra` contra o TS
//! do `esm`); aqui só se traduz a entrada. Como no `limitReservingBr`
//! (`stream_final.rs`), entram streams e opções em STRING JSON e saem ÍNDICES
//! sobre a lista original — a casca TS mapeia de volta e escreve o trace.

use std::collections::{HashMap, HashSet};

use adom_core::stream_quotas_extra::{SelectCandidatesOpts, StreamRef};
use napi_derive::napi;
use serde::Deserialize;

use crate::stream_final::{parse_json, to_json};

/// Um `Stream` visto pelas cotas (o que `streamQuality` e a reserva BR leem).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct QuotaStreamInput {
    title: String,
    quality: Option<String>,
    indexer: Option<String>,
    is_br: bool,
    is_dubbed: bool,
    is_dub_claim: bool,
    is_lied: bool,
}

fn stream_refs(streams: Vec<QuotaStreamInput>) -> Vec<StreamRef> {
    streams
        .into_iter()
        .map(|s| StreamRef {
            title: s.title,
            quality: s.quality,
            indexer: s.indexer,
            is_br: s.is_br,
            is_dubbed: s.is_dubbed,
            is_dub_claim: s.is_dub_claim,
            is_lied: s.is_lied,
            is_season_pack: false,
        })
        .collect()
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LimitByQualityInput {
    streams: Vec<QuotaStreamInput>,
    quality_limits: HashMap<String, f64>,
}

/// `limitByQuality`: índices mantidos, na ordem da lista.
#[napi(catch_unwind)]
pub fn limit_by_quality_napi(input: String) -> napi::Result<String> {
    let req: LimitByQualityInput = parse_json(&input)?;
    let refs = stream_refs(req.streams);
    let qualities: Vec<String> = refs
        .iter()
        .map(adom_core::stream_quotas_extra::stream_quality)
        .collect();
    let views: Vec<&str> = qualities.iter().map(String::as_str).collect();
    to_json(&adom_core::limit_by_quality(&views, &req.quality_limits))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LimitByQualityAndIndexerInput {
    streams: Vec<QuotaStreamInput>,
    quality_limits: HashMap<String, f64>,
    max_per_indexer: f64,
    /// Índices das vagas BR que furam a cota por indexador.
    exempt: Vec<usize>,
    indexer_limits: HashMap<String, f64>,
    /// Índices das vagas BR reservadas (não consomem o balde de qualidade).
    reserved_br: Vec<usize>,
}

/// `limitByQualityAndIndexer`: `{kept, dropped:[{index, reason}]}`, com os
/// cortes na ordem de visita (o ledger do TS depende dela).
#[napi(catch_unwind)]
pub fn limit_by_quality_and_indexer_napi(input: String) -> napi::Result<String> {
    let req: LimitByQualityAndIndexerInput = parse_json(&input)?;
    let refs = stream_refs(req.streams);
    let views: Vec<&StreamRef> = refs.iter().collect();
    let exempt: HashSet<usize> = req.exempt.into_iter().collect();
    let reserved: HashSet<usize> = req.reserved_br.into_iter().collect();
    to_json(
        &adom_core::stream_quotas_extra::limit_by_quality_and_indexer_trace(
            &views,
            &req.quality_limits,
            req.max_per_indexer,
            &exempt,
            &req.indexer_limits,
            &reserved,
        ),
    )
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SelectOptsInput {
    max_results: f64,
    quality_limits: HashMap<String, f64>,
    br_reserved_slots: f64,
    br_reserved_per_quality: f64,
    candidate_factor: f64,
    br_first: bool,
}

/// Mesmos defaults do destructuring do TS (maxResults 40, fator 1, brFirst).
impl Default for SelectOptsInput {
    fn default() -> Self {
        Self {
            max_results: 40.0,
            quality_limits: HashMap::new(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            candidate_factor: 1.0,
            br_first: true,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SelectInput {
    streams: Vec<QuotaStreamInput>,
    opts: SelectOptsInput,
}

/// `selectQualityCandidates`: índices selecionados, na ordem ORIGINAL.
#[napi(catch_unwind)]
pub fn select_quality_candidates_napi(input: String) -> napi::Result<String> {
    let req: SelectInput = parse_json(&input)?;
    let refs = stream_refs(req.streams);
    let views: Vec<&StreamRef> = refs.iter().collect();
    let opts = SelectCandidatesOpts {
        max_results: req.opts.max_results,
        quality_limits: req.opts.quality_limits,
        br_reserved_slots: req.opts.br_reserved_slots,
        br_reserved_per_quality: req.opts.br_reserved_per_quality,
        candidate_factor: req.opts.candidate_factor,
        br_first: req.opts.br_first,
    };
    to_json(&adom_core::select_quality_candidates(&views, &opts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(out: napi::Result<String>) -> serde_json::Value {
        serde_json::from_str(&out.expect("ponte responde")).expect("saída JSON")
    }

    #[test]
    fn limit_by_quality_corta_o_excedente_da_faixa() {
        let input = r#"{"streams":[
            {"title":"A 1080p"},{"title":"B 1080p"},{"title":"C 720p"},{"title":"D","quality":"1080p"}
        ],"qualityLimits":{"1080p":1}}"#;
        assert_eq!(
            parse(limit_by_quality_napi(input.into())),
            serde_json::json!([0, 2])
        );
    }

    #[test]
    fn limit_by_quality_cem_ou_mais_e_ilimitado() {
        let input = r#"{"streams":[{"title":"A 1080p"},{"title":"B 1080p"}],"qualityLimits":{"1080p":100}}"#;
        assert_eq!(
            parse(limit_by_quality_napi(input.into())),
            serde_json::json!([0, 1])
        );
    }

    #[test]
    fn quality_and_indexer_registra_o_motivo_e_respeita_a_reserva() {
        let input = r#"{"streams":[
            {"title":"A 1080p","indexer":"yts"},
            {"title":"B 1080p","indexer":"yts"},
            {"title":"C 1080p","indexer":"bludv","isBr":true},
            {"title":"D 720p","indexer":"YTS "}
        ],"qualityLimits":{"1080p":1},"maxPerIndexer":1,"exempt":[2],"indexerLimits":{},"reservedBr":[2]}"#;
        let out = parse(limit_by_quality_and_indexer_napi(input.into()));
        assert_eq!(out["kept"], serde_json::json!([0, 2]));
        assert_eq!(
            out["dropped"],
            serde_json::json!([
                {"index": 1, "reason": "quality-quota"},
                {"index": 3, "reason": "indexer-limit"}
            ])
        );
    }

    #[test]
    fn select_candidates_preserva_a_ordem_original() {
        let input = r#"{"streams":[
            {"title":"A 2160p"},{"title":"B 2160p"},{"title":"C 1080p"},{"title":"D 1080p","isBr":true}
        ],"opts":{"maxResults":3,"qualityLimits":{"2160p":1,"1080p":2},"brFirst":false}}"#;
        let out = parse(select_quality_candidates_napi(input.into()));
        let kept: Vec<usize> = serde_json::from_value(out).expect("índices");
        assert!(
            kept.windows(2).all(|w| w[0] < w[1]),
            "ordem original: {kept:?}"
        );
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn entrada_invalida_vira_erro_e_nao_panic() {
        assert!(limit_by_quality_napi("não é json".into()).is_err());
    }
}
