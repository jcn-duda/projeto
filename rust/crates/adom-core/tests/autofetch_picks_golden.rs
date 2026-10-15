//! Integridade e paridade do golden da CASCATA DE PICKS do autofetch BR
//! (`src/utils/autofetch-picks.ts`): `pickBrDubbedCandidates`,
//! `pickAnyDubbedCandidates`, `pickTopSeededCandidates`, `hasCachedBrDubbed`,
//! `hasCachedAnyDubbed`, `cachedBrDubbedTargetQualities`, `uncachedBrHashes`,
//! `canAutoFetchBr` e `filterKnownCache`.
//!
//! Cada entrada é um JSON com `op`:
//! - `pickBr`/`pickAny`/`pickTop`: `streams` + `limit`/`cached`/`season`/… →
//!   `{"ids":[…],"stable":true}` (os `id` na ordem de seleção).
//! - `uncachedBr`: `streams` + `limit` + `cached` → `{"ids":[…],"stable":true}`
//!   (ordem de seleção; os hashes saem na casca original e voltam a `id`).
//! - `hasCachedBr`/`hasCachedAny`: → `{"value":bool,"stable":true}`.
//! - `canAutoFetch`: só os flags (sem streams) → `{"value":bool,"stable":true}`.
//! - `cachedTargets`: → `{"qualities":[…],"stable":true}` (ordem lexicográfica).
//! - `filterKnown`: → `{"ids":[…],"visibleBr":[…],"stable":true}`.
//!
//! `stable` é o eco de não-mutação: a entrada é clonada antes e comparada
//! depois. O `id` NÃO é campo do addon — serve só para mapear a saída.
//! `pickBrDubbedByTargetQualities` já é coberto pelo golden `br-pool-selection`;
//! `brListableDubPool`/`pickFromPool` não são exportados pelo TS e entram aqui
//! via `uncachedBr`/`filterKnown`/pickers + os testes unitários no fim.

mod common;

use std::collections::{HashMap, HashSet};

use adom_core::{
    br_listable_dub_pool, cached_br_dubbed_target_qualities, can_auto_fetch_br, filter_known_cache,
    has_cached_any_dubbed, has_cached_br_dubbed, pick_any_dubbed_candidates,
    pick_br_dubbed_candidates, pick_from_pool, pick_top_seeded_candidates, uncached_br_hashes,
    FilterKnownOptions, PoolOptions, PoolStream, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/autofetch-picks.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/autofetch-picks.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-autofetch-picks.json");

const REGISTRY_MATCH: &str = "autofetch-picks/pickBrDubbedCandidates";

/// `None` para chave ausente OU `null`; senão a string (vazia é string).
fn opt_str(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// Cada stream do corpus → `PoolStream`, mantendo os `id` na ordem da lista.
fn parse_streams(v: &Value) -> (Vec<PoolStream>, Vec<String>) {
    let rows = v["streams"].as_array().expect("streams: lista");
    let mut streams = Vec::with_capacity(rows.len());
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let id = row["id"].as_str().expect("stream: id string").to_string();
        streams.push(PoolStream {
            info_hash: opt_str(row, "infoHash"),
            title: opt_str(row, "title"),
            name: opt_str(row, "name"),
            quality: opt_str(row, "quality"),
            seeders: row.get("seeders").and_then(Value::as_i64),
            is_br: flag(row, "br"),
            is_dubbed: flag(row, "dubbed"),
            is_dub_claim: flag(row, "dubClaim"),
            is_bank_dub: flag(row, "bankDub"),
            is_lied: flag(row, "lied"),
            from_fallback: flag(row, "fromFallback"),
            fallback_fetchable: flag(row, "fallbackFetchable"),
        });
        ids.push(id);
    }
    (streams, ids)
}

fn cached_set(v: &Value) -> HashSet<String> {
    v.get("cached")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn opt_set(v: &Value, key: &str) -> Option<HashSet<String>> {
    v.get(key).and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// `infoHash` cru (casca original) → `id`, na ordem da lista (último vence),
/// espelhando o `byHash` do oráculo.
fn hash_to_id(streams: &[PoolStream], ids: &[String]) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for (i, s) in streams.iter().enumerate() {
        if let Some(h) = &s.info_hash {
            m.insert(h.clone(), ids[i].clone());
        }
    }
    m
}

fn pool_opts(c: &Value) -> PoolOptions {
    PoolOptions {
        season: c.get("season").and_then(Value::as_i64),
        min_seeders: c.get("minSeeders").and_then(Value::as_i64).unwrap_or(0),
        pt_first: c.get("ptFirst").and_then(Value::as_bool).unwrap_or(true),
    }
}

/// Recalcula a saída textual de um caso com as funções Rust. A ORDEM das chaves
/// no `json!` reproduz byte a byte a do oráculo (serde `preserve_order`).
fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let before = c.clone();
    let op = c["op"].as_str().expect("op: string");

    // canAutoFetchBr não usa streams: só os flags do toggle e do adapter.
    if op == "canAutoFetch" {
        let value = can_auto_fetch_br(
            flag(&c, "autoFetchBr"),
            flag(&c, "cacheCheck"),
            flag(&c, "autofetchSource"),
        );
        let stable = c == before;
        assert!(stable, "a entrada foi modificada pela chamada");
        return serde_json::to_string(&json!({ "value": value, "stable": stable })).expect("saída");
    }

    let (streams, ids) = parse_streams(&c);
    let cached = cached_set(&c);
    let opts = pool_opts(&c);
    let by_hash = hash_to_id(&streams, &ids);
    let ids_of =
        |picked: &[usize]| -> Vec<String> { picked.iter().map(|&i| ids[i].clone()).collect() };

    let out = match op {
        "pickBr" => {
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(1);
            json!({ "ids": ids_of(&pick_br_dubbed_candidates(&streams, &cached, limit, &opts)), "stable": true })
        }
        "pickAny" => {
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(1);
            json!({ "ids": ids_of(&pick_any_dubbed_candidates(&streams, &cached, limit, &opts)), "stable": true })
        }
        "pickTop" => {
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(1);
            json!({ "ids": ids_of(&pick_top_seeded_candidates(&streams, &cached, limit, &opts)), "stable": true })
        }
        "uncachedBr" => {
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(0);
            let ids: Vec<String> = uncached_br_hashes(&streams, &cached, limit)
                .iter()
                .map(|h| by_hash.get(h).expect("hash do pool").clone())
                .collect();
            json!({ "ids": ids, "stable": true })
        }
        "hasCachedBr" => {
            json!({ "value": has_cached_br_dubbed(&streams, &cached), "stable": true })
        }
        "hasCachedAny" => {
            json!({ "value": has_cached_any_dubbed(&streams, &cached), "stable": true })
        }
        "cachedTargets" => {
            let mut qualities: Vec<String> =
                cached_br_dubbed_target_qualities(&streams, &cached, &opts)
                    .into_iter()
                    .collect();
            qualities.sort();
            json!({ "qualities": qualities, "stable": true })
        }
        "filterKnown" => {
            let fopts = FilterKnownOptions {
                cached_only: c.get("cachedOnly").and_then(Value::as_bool).unwrap_or(true),
                show_uncached_br: c
                    .get("showUncachedBr")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                br_reserved_slots: c
                    .get("brReservedSlots")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                known: c.get("known").and_then(Value::as_bool).unwrap_or(true),
                miss_hashes: opt_set(&c, "missHashes"),
            };
            let res = filter_known_cache(&streams, &cached, &fopts);
            let mut visible: Vec<String> = res
                .visible_br
                .iter()
                .map(|h| by_hash.get(h).expect("hash do pool").clone())
                .collect();
            visible.sort();
            json!({ "ids": ids_of(&res.kept), "visibleBr": visible, "stable": true })
        }
        other => panic!("op desconhecida: {other}"),
    };

    // O contrato é só `&`: a chamada não pode tocar a entrada.
    assert!(c == before, "a entrada foi modificada pela chamada");
    serde_json::to_string(&out).expect("saída serializável")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/autofetch-picks.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-autofetch-picks.json");
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = parse_cases(JSONL_BYTES);
    let mut ids = HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
    assert!(cases.len() >= 60, "golden precisa de pelo menos 60 casos");
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

#[test]
fn saidas_batem_com_o_golden_caso_a_caso() {
    for case in parse_cases(JSONL_BYTES) {
        let obtido = render(&case.input);
        assert_eq!(
            obtido, case.expected,
            "caso {} divergiu: {}",
            case.id, case.input
        );
    }
}

// ── Unitários: cobre o que o golden só toca de raspão ───────────────────

fn s(id: &str, hash: &str, f: impl FnOnce(&mut PoolStream)) -> (String, PoolStream) {
    let mut st = PoolStream {
        info_hash: Some(hash.to_string()),
        ..PoolStream::default()
    };
    f(&mut st);
    (id.to_string(), st)
}

fn pool(items: Vec<(String, PoolStream)>) -> (Vec<PoolStream>, Vec<String>) {
    let ids = items.iter().map(|(id, _)| id.clone()).collect();
    let streams = items.into_iter().map(|(_, st)| st).collect();
    (streams, ids)
}

#[test]
fn pick_from_pool_deduplica_pula_cache_e_respeita_limite() {
    let (streams, ids) = pool(vec![
        s("a", "hash", |_| {}),
        s("dup", "HASH", |_| {}), // mesmo hash, caixa diferente → dedupe
        s("cached", "cache", |_| {}),
        s("b", "outro", |_| {}),
    ]);
    let pool_idx = vec![0, 1, 2, 3];
    let cached: HashSet<String> = ["cache".to_string()].into_iter().collect();
    let picked = pick_from_pool(&streams, &pool_idx, &cached, 5);
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(picked_ids, vec!["a", "b"], "dedupe + pula cacheado");

    // limit 0 nunca devolve nada; o pool JÁ vem ordenado (a ordem é a prioridade).
    assert!(pick_from_pool(&streams, &pool_idx, &cached, 0).is_empty());
}

#[test]
fn br_listable_dub_pool_mantem_claim_e_corta_cam_lied_e_legendado() {
    let (streams, ids) = pool(vec![
        s("prova", "h1", |st| {
            st.is_br = true;
            st.is_dubbed = true;
        }),
        s("claim", "h2", |st| {
            st.is_br = true;
            st.is_dub_claim = true;
        }),
        s("lied", "h3", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.is_lied = true;
        }),
        s("cam", "h4", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.title = Some("Filme CAM Dublado".into());
        }),
        s("legendado", "h5", |st| {
            st.is_br = true;
            st.title = Some("Prometheus LEGENDADO".into());
        }),
    ]);
    let picked = br_listable_dub_pool(&streams);
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    // claim conta (vaga P2P); lied/CAM/legendado ficam fora; ordem de entrada.
    assert_eq!(picked_ids, vec!["prova", "claim"]);
}

#[test]
fn filter_known_cache_devolve_os_cortes_com_o_motivo() {
    let (streams, ids) = pool(vec![s("cached", "a", |_| {}), s("unknown", "b", |_| {})]);
    let cached: HashSet<String> = ["a".to_string()].into_iter().collect();

    // known=true: o não-cacheado cai como "cached-only".
    let res = filter_known_cache(
        &streams,
        &cached,
        &FilterKnownOptions {
            cached_only: true,
            known: true,
            ..Default::default()
        },
    );
    let kept: Vec<&str> = res.kept.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(kept, vec!["cached"]);
    assert_eq!(res.dropped.len(), 1);
    assert_eq!(res.dropped[0].reason, "cached-only");
    assert_eq!(ids[res.dropped[0].index], "unknown");

    // known=false + miss confirmado: cai como "rd-miss".
    let miss: HashSet<String> = ["b".to_string()].into_iter().collect();
    let res = filter_known_cache(
        &streams,
        &cached,
        &FilterKnownOptions {
            cached_only: true,
            known: false,
            miss_hashes: Some(miss),
            ..Default::default()
        },
    );
    let kept: Vec<&str> = res.kept.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(kept, vec!["cached"]);
    assert_eq!(res.dropped[0].reason, "rd-miss");

    // cachedOnly=false: nada cai, nada é rastreado.
    let res = filter_known_cache(
        &streams,
        &cached,
        &FilterKnownOptions {
            cached_only: false,
            ..Default::default()
        },
    );
    assert_eq!(res.kept.len(), 2);
    assert!(res.dropped.is_empty());
}

#[test]
fn can_auto_fetch_br_exige_toggle_e_uma_trava_confiavel() {
    assert!(can_auto_fetch_br(true, true, false));
    assert!(can_auto_fetch_br(true, false, true));
    assert!(!can_auto_fetch_br(true, false, false));
    assert!(!can_auto_fetch_br(false, true, true));
}

#[test]
fn entrada_permanece_intacta() {
    let streams = vec![PoolStream {
        info_hash: Some("h1".into()),
        is_br: true,
        is_dubbed: true,
        quality: Some("1080p".into()),
        ..Default::default()
    }];
    let snapshot = streams.clone();
    let cached: HashSet<String> = ["h1".to_string()].into_iter().collect();
    let _ = pick_br_dubbed_candidates(&streams, &HashSet::new(), 3, &PoolOptions::default());
    let _ = has_cached_br_dubbed(&streams, &cached);
    let _ = cached_br_dubbed_target_qualities(&streams, &cached, &PoolOptions::default());
    let _ = uncached_br_hashes(&streams, &HashSet::new(), 2);
    let _ = filter_known_cache(&streams, &cached, &FilterKnownOptions::default());
    assert_eq!(streams, snapshot, "as funções só leem a entrada");
}
