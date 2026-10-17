//! Fronteira napi do corte final e do cachedOnly:
//! `adom_core::stream_quotas_extra::limit_reserving_br_trace` e
//! `adom_core::br_pool_selection::picks::filter_known_cache`.
//!
//! As duas devolvem ÍNDICES (e os motivos de corte), nunca os streams; o TS
//! mapeia de volta e é quem escreve o trace (I/O). A seleção inteira decide no
//! núcleo. Entrada e saída cruzam como STRING JSON, como em `search.rs`: o
//! objeto é o mesmo que a casca TS monta e a saída é o que ela faz `JSON.parse`.

use std::collections::{HashMap, HashSet};

use adom_core as core;
use adom_core::stream_quotas_extra::{limit_reserving_br_trace, LimitBrOpts, StreamRef};
use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Helpers de fronteira
// ---------------------------------------------------------------------------

fn parse_json<T: for<'de> Deserialize<'de>>(input: &str) -> napi::Result<T> {
    serde_json::from_str(input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))
}

fn to_json<T: serde::Serialize>(value: &T) -> napi::Result<String> {
    serde_json::to_string(value)
        .map_err(|e| napi::Error::from_reason(format!("saída JSON inválida: {e}")))
}

/// `Math.max(0, Math.trunc(Number(x) || 0))` para o campo inteiro da ponte.
fn slots(value: f64) -> i64 {
    if value.is_nan() {
        0
    } else {
        value.trunc().max(0.0) as i64
    }
}

// ---------------------------------------------------------------------------
// limitReservingBr (`src/utils/stream-quotas.ts`)
// ---------------------------------------------------------------------------

/// Um `Stream` visto pelo corte final (só o que `streamQuality`/`_br` leem).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LimitBrStreamInput {
    title: String,
    quality: Option<String>,
    indexer: Option<String>,
    is_br: bool,
    is_dubbed: bool,
    is_dub_claim: bool,
    is_lied: bool,
}

/// Opções de `limitReservingBr` — mesmos defaults do TS (maxResults 40, brFirst
/// ligado); o resto é `0`/vazio como no destructuring da casca.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LimitBrOptsInput {
    max_results: f64,
    quality_limits: HashMap<String, f64>,
    br_reserved_slots: f64,
    br_reserved_per_quality: f64,
    br_first: bool,
    max_per_indexer: f64,
    indexer_limits: HashMap<String, f64>,
    br_only: bool,
    season: Option<i64>,
}

impl Default for LimitBrOptsInput {
    fn default() -> Self {
        Self {
            max_results: 40.0,
            quality_limits: HashMap::new(),
            br_reserved_slots: 0.0,
            br_reserved_per_quality: 0.0,
            br_first: true,
            max_per_indexer: 0.0,
            indexer_limits: HashMap::new(),
            br_only: false,
            season: None,
        }
    }
}

/// `{ streams, opts }` — o objeto que a casca monta.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LimitBrInput {
    streams: Vec<LimitBrStreamInput>,
    opts: LimitBrOptsInput,
}

/// `limitReservingBr`: devolve `{selected, eligible, replaced, dropped}`.
///
/// `dropped` já vem na ordem do ledger (`quality-quota`/`indexer-limit` na
/// visita à lista reordenada, depois `br-guarantee-replaced`); o `max-results`
/// NÃO vem — é o diff `eligible − selected − replaced`, calculado na casca na
/// ordem original.
#[napi(catch_unwind)]
pub fn limit_reserving_br(input: String) -> napi::Result<String> {
    let req: LimitBrInput = parse_json(&input)?;
    let streams: Vec<StreamRef> = req
        .streams
        .into_iter()
        .map(|s| StreamRef {
            title: s.title,
            quality: s.quality,
            indexer: s.indexer,
            is_br: s.is_br,
            is_dubbed: s.is_dubbed,
            is_dub_claim: s.is_dub_claim,
            is_lied: s.is_lied,
            // O corte final não lê o bônus de pack do título; quem o calcula é
            // `isSeasonPackRelease` dentro do próprio núcleo.
            is_season_pack: false,
        })
        .collect();
    let opts = LimitBrOpts {
        br_reserved_slots: req.opts.br_reserved_slots,
        br_reserved_per_quality: req.opts.br_reserved_per_quality,
        max_results: req.opts.max_results,
        br_only: req.opts.br_only,
        quality_limits: req.opts.quality_limits,
        br_first: req.opts.br_first,
        max_per_indexer: req.opts.max_per_indexer,
        indexer_limits: req.opts.indexer_limits,
        season: req.opts.season,
    };
    to_json(&limit_reserving_br_trace(&streams, &opts))
}

// ---------------------------------------------------------------------------
// filterKnownCache (`src/utils/autofetch-picks.ts`)
// ---------------------------------------------------------------------------

/// Um `Stream` visto pelo cachedOnly (campos que o núcleo lê).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FilterKnownStreamInput {
    info_hash: Option<String>,
    title: Option<String>,
    name: Option<String>,
    quality: Option<String>,
    // f64 na fronteira: `_seeders` do TS é `Number(...) || 0` e um valor
    // fracionário não pode derrubar a travessia (o cachedOnly não o lê).
    seeders: Option<f64>,
    is_br: bool,
    is_dubbed: bool,
    is_dub_claim: bool,
    is_bank_dub: bool,
    is_lied: bool,
    from_fallback: bool,
    fallback_fetchable: bool,
}

/// `{cachedOnly, showUncachedBr, brReservedSlots, known, missHashes}`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FilterKnownOptsInput {
    cached_only: bool,
    show_uncached_br: bool,
    br_reserved_slots: f64,
    known: bool,
    /// `null` = sem ledger do RD (o desconhecido sobrevive).
    miss_hashes: Option<Vec<String>>,
}

impl Default for FilterKnownOptsInput {
    fn default() -> Self {
        Self {
            cached_only: true,
            show_uncached_br: false,
            br_reserved_slots: 0.0,
            known: true,
            miss_hashes: None,
        }
    }
}

/// `{ streams, cached, opts }` — o objeto que a casca monta.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct FilterKnownInput {
    streams: Vec<FilterKnownStreamInput>,
    cached: Vec<String>,
    opts: FilterKnownOptsInput,
}

/// Um corte no formato do ledger (o `dropTrace` da casca copia campo a campo).
#[derive(Debug, Serialize)]
struct DropOut {
    index: usize,
    reason: &'static str,
}

/// Saída da ponte (o `visibleBr` é a lista na ordem de seleção; o TS monta o
/// `Set<string>` na caixa original).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilterKnownOutput {
    kept: Vec<usize>,
    visible_br: Vec<String>,
    dropped: Vec<DropOut>,
}

/// `filterKnownCache`: devolve `{kept, visibleBr, dropped}`.
#[napi(catch_unwind)]
pub fn filter_known_cache(input: String) -> napi::Result<String> {
    let req: FilterKnownInput = parse_json(&input)?;
    let streams: Vec<core::PoolStream> = req
        .streams
        .into_iter()
        .map(|s| core::PoolStream {
            info_hash: s.info_hash,
            title: s.title,
            name: s.name,
            quality: s.quality,
            seeders: s.seeders.map(|v| v.trunc() as i64),
            is_br: s.is_br,
            is_dubbed: s.is_dubbed,
            is_dub_claim: s.is_dub_claim,
            is_bank_dub: s.is_bank_dub,
            is_lied: s.is_lied,
            from_fallback: s.from_fallback,
            fallback_fetchable: s.fallback_fetchable,
        })
        .collect();
    let cached: HashSet<String> = req.cached.into_iter().collect();
    let opts = core::FilterKnownOptions {
        cached_only: req.opts.cached_only,
        show_uncached_br: req.opts.show_uncached_br,
        br_reserved_slots: slots(req.opts.br_reserved_slots),
        known: req.opts.known,
        miss_hashes: req
            .opts
            .miss_hashes
            .map(|hashes| hashes.into_iter().collect()),
    };
    let result = core::filter_known_cache(&streams, &cached, &opts);
    let out = FilterKnownOutput {
        kept: result.kept,
        visible_br: result.visible_br,
        dropped: result
            .dropped
            .iter()
            .map(|drop| DropOut {
                index: drop.index,
                reason: drop.reason,
            })
            .collect(),
    };
    to_json(&out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn parse(out: &str) -> Value {
        serde_json::from_str(out).expect("saída JSON")
    }

    #[test]
    fn corte_final_devolve_indices_originais_e_ordem_do_ledger() {
        // Quatro globais iguais com cota 1080p=2: os dois últimos caem por
        // quality-quota ANTES do maxResults (que fica para a casca).
        let input = json!({
            "streams": [
                {"title": "Filme 1080p A", "quality": "1080p", "isBr": false},
                {"title": "Filme 1080p B", "quality": "1080p", "isBr": false},
                {"title": "Filme 1080p C", "quality": "1080p", "isBr": false},
                {"title": "Filme 1080p D", "quality": "1080p", "isBr": false},
            ],
            "opts": {"maxResults": 4, "qualityLimits": {"1080p": 2}, "brFirst": true},
        })
        .to_string();
        let out = parse(&limit_reserving_br(input).expect("ok"));
        assert_eq!(out["selected"], json!([0, 1]));
        assert_eq!(out["eligible"], json!([0, 1]));
        assert_eq!(out["replaced"], json!([]));
        assert_eq!(
            out["dropped"],
            json!([
                {"index": 2, "reason": "quality-quota"},
                {"index": 3, "reason": "quality-quota"},
            ])
        );
    }

    #[test]
    fn reserva_br_troca_o_ultimo_global_na_ordem_do_encaixa() {
        // maxResults=2: entra global, global; a garantia BR por faixa troca o
        // último global (posição 1) uma única vez.
        let input = json!({
            "streams": [
                {"title": "Global 1080p", "quality": "1080p"},
                {"title": "Global 720p", "quality": "720p"},
                {"title": "Filme Dublado 1080p", "quality": "1080p", "isBr": true, "isDubbed": true},
            ],
            "opts": {"maxResults": 2, "brReservedPerQuality": 1, "brFirst": true},
        })
        .to_string();
        let out = parse(&limit_reserving_br(input).expect("ok"));
        // brStreams primeiro; a garantia já está dentro de selected.
        assert_eq!(out["selected"], json!([2, 0]));
        assert!(out["dropped"].as_array().expect("lista").is_empty());
    }

    #[test]
    fn cached_only_devolve_kept_visiveis_e_motivos() {
        let input = json!({
            "streams": [
                {"infoHash": "aaa", "title": "Filme 1080p"},
                {"infoHash": "bbb", "title": "Outro 1080p"},
                {"infoHash": "ccc", "title": "Dublado 1080p", "isBr": true, "isDubbed": true},
            ],
            "cached": ["AAA"],
            "opts": {"cachedOnly": true, "showUncachedBr": true, "brReservedSlots": 1},
        })
        .to_string();
        let out = parse(&filter_known_cache(input).expect("ok"));
        // aaa cacheado; ccc ocupa a vaga P2P visível; bbb cai.
        assert_eq!(out["kept"], json!([0, 2]));
        assert_eq!(out["visibleBr"], json!(["ccc"]));
        assert_eq!(
            out["dropped"],
            json!([{"index": 1, "reason": "cached-only"}])
        );
    }

    #[test]
    fn entrada_invalida_devolve_erro_sem_panico() {
        assert!(limit_reserving_br("{".into()).is_err());
        assert!(filter_known_cache("\"nao-e-objeto\"".into()).is_err());
    }
}
