//! Integridade e paridade do golden de seleção de pool do autofetch BR:
//! `brDubbedPool`, `anyDubbedPool`, `topSeededPool` (`src/utils/autofetch-pools.ts`)
//! e `pickBrDubbedByTargetQualities` (`src/utils/autofetch-picks.ts`).
//!
//! Cada entrada é um JSON com `op`:
//! - `"br"`/`"any"`/`"top"`: `streams` + `season`/`minSeeders`/`ptFirst` →
//!   `{"ids":[…],"stable":true}` (os `id` na ordem do pool).
//! - `"target"`: `streams` + `limit` (default 3) + `cached` (default `[]`) →
//!   `{"ids":[…],"stable":true}`.
//!
//! `stable` é o eco de não-mutação: a entrada é clonada antes da chamada e
//! comparada depois. O `id` NÃO é campo do addon — serve só para mapear a
//! saída do oráculo.

mod common;

use std::collections::HashSet;

use adom_core::{
    any_dubbed_pool, br_dubbed_pool, fallback_blocked, pick_br_dubbed_by_target_qualities,
    top_seeded_pool, PoolOptions, PoolStream, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/br-pool-selection.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/br-pool-selection.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-br-pool-selection.json");

const REGISTRY_MATCH: &str = "br-pool-selection/brDubbedPool";

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

/// Recalcula a saída textual de um caso com as funções Rust.
fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let before = c.clone();
    let (streams, ids) = parse_streams(&c);
    let opts = PoolOptions {
        season: c.get("season").and_then(Value::as_i64),
        min_seeders: c.get("minSeeders").and_then(Value::as_i64).unwrap_or(0),
        pt_first: c.get("ptFirst").and_then(Value::as_bool).unwrap_or(true),
    };
    let picked = match c["op"].as_str().expect("op: string") {
        "br" => br_dubbed_pool(&streams, &opts),
        "any" => any_dubbed_pool(&streams, &opts),
        "top" => top_seeded_pool(&streams, &opts),
        "target" => {
            let limit = c.get("limit").and_then(Value::as_i64).unwrap_or(3);
            pick_br_dubbed_by_target_qualities(&streams, &cached_set(&c), limit, &opts)
        }
        other => panic!("op desconhecida: {other}"),
    };
    let out_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    // O contrato é só `&`: a chamada não pode tocar a entrada.
    let stable = c == before;
    assert!(stable, "a entrada foi modificada pela chamada");
    serde_json::to_string(&json!({ "ids": out_ids, "stable": stable })).expect("saída serializável")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/br-pool-selection.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-br-pool-selection.json"
    );
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
    assert!(cases.len() >= 80, "golden precisa de pelo menos 80 casos");
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

fn s(id: &str, f: impl FnOnce(&mut PoolStream)) -> (String, PoolStream) {
    let mut st = PoolStream {
        info_hash: Some(format!("hash-{id}")),
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
fn br_pool_corta_filtros_e_desempata_por_pack() {
    let (streams, ids) = pool(vec![
        s("avulso", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.quality = Some("1080p".into());
            st.title = Some("Serie S02E01 Dublado 1080p".into());
        }),
        s("pack", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.quality = Some("720p".into());
            st.title = Some("Serie 2ª Temporada Completa Dublado 720p".into());
        }),
    ]);
    let opts = PoolOptions {
        season: Some(2),
        ..PoolOptions::default()
    };
    let picked = br_dubbed_pool(&streams, &opts);
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(
        picked_ids,
        vec!["pack", "avulso"],
        "pack S2 vence o avulso em 720p"
    );

    // Sem season, o bônus de pack some e a resolução decide.
    let no_season = br_dubbed_pool(&streams, &PoolOptions::default());
    let no_ids: Vec<&str> = no_season.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(no_ids, vec!["avulso", "pack"]);
}

#[test]
fn br_pool_exclui_lied_cam_e_fallback_bloqueado() {
    let (streams, _) = pool(vec![
        s("ok", |st| {
            st.is_br = true;
            st.is_dubbed = true;
        }),
        s("lied", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.is_lied = true;
        }),
        s("cam", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.title = Some("Movie CAM".into());
        }),
        s("bloqueado", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.from_fallback = true;
        }),
        s("aprovado", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.from_fallback = true;
            st.fallback_fetchable = true;
        }),
    ]);
    let picked = br_dubbed_pool(&streams, &PoolOptions::default());
    assert_eq!(picked.len(), 2, "só ok e aprovado sobrevivem");
    assert!(
        fallback_blocked(&streams[3]),
        "fallback sem prova é bloqueado"
    );
    let mut seen: Vec<usize> = picked.clone();
    seen.sort_unstable();
    assert_eq!(seen, vec![0, 4]);
}

#[test]
fn any_pool_aceita_lied_e_ignora_br() {
    let (streams, ids) = pool(vec![
        s("global", |st| {
            st.is_dubbed = true;
        }),
        s("globalLied", |st| {
            st.is_dubbed = true;
            st.is_lied = true;
        }),
        s("claim", |st| {
            st.is_dub_claim = true;
        }),
    ]);
    let picked = any_dubbed_pool(&streams, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    // `_dubbed` basta; `_lied` NÃO corta aqui; claim sem prova não entra.
    assert_eq!(picked_ids, vec!["global", "globalLied"]);
}

#[test]
fn top_pool_descarta_estrangeiro_e_prefere_pt() {
    let (streams, ids) = pool(vec![
        s("pt", |st| {
            st.seeders = Some(5);
            st.title = Some("Filme Dublado 720p".into());
        }),
        s("raw", |st| {
            st.seeders = Some(50);
            st.title = Some("Movie 1080p".into());
        }),
        s("francês", |st| {
            st.seeders = Some(99);
            st.title = Some("Movie FRENCH 1080p".into());
        }),
    ]);
    let picked = top_seeded_pool(&streams, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(
        picked_ids,
        vec!["pt", "raw"],
        "PT antes do mais semeado; FRENCH fora"
    );
}

#[test]
fn target_sem_faixa_alvo_usa_pick_classico_e_respeita_cache() {
    // Só unknown/SD: não há faixa-alvo, cai no pick clássico (ordem do pool BR).
    let (streams, ids) = pool(vec![
        s("u1", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.title = Some("Filme Dublado".into());
            st.seeders = Some(9);
        }),
        s("u2", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.title = Some("Outro Dublado".into());
            st.seeders = Some(1);
        }),
    ]);
    let picked =
        pick_br_dubbed_by_target_qualities(&streams, &HashSet::new(), 3, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(picked_ids, vec!["u1", "u2"]);

    // Cached pula o primeiro hash (case-insensitive na chave).
    let cached: HashSet<String> = ["HASH-U1".to_string()].into_iter().collect();
    let picked = pick_br_dubbed_by_target_qualities(&streams, &cached, 3, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(picked_ids, vec!["u2"]);
}

#[test]
fn target_um_por_faixa_e_dedupe_de_hash() {
    let (streams, ids) = pool(vec![
        s("a", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.quality = Some("1080p".into());
            st.seeders = Some(9);
        }),
        s("b", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.quality = Some("1080p".into());
            st.seeders = Some(8);
        }),
        s("c", |st| {
            st.is_br = true;
            st.is_dubbed = true;
            st.quality = Some("720p".into());
            st.seeders = Some(7);
        }),
    ]);
    let picked =
        pick_br_dubbed_by_target_qualities(&streams, &HashSet::new(), 3, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| ids[i].as_str()).collect();
    assert_eq!(picked_ids, vec!["a", "c"], "um primário por faixa");

    // Hashes iguais (caixa diferente) deduplicam para um só.
    let dup = PoolStream {
        info_hash: Some("HASH-A".into()),
        ..streams[0].clone()
    };
    let mut with_dup = streams.clone();
    with_dup.push(dup);
    let mut dup_ids = ids.clone();
    dup_ids.push("dup".into());
    let picked =
        pick_br_dubbed_by_target_qualities(&with_dup, &HashSet::new(), 3, &PoolOptions::default());
    let picked_ids: Vec<&str> = picked.iter().map(|&i| dup_ids[i].as_str()).collect();
    assert_eq!(picked_ids, vec!["a", "c"]);
}

#[test]
fn entrada_permanece_intacta() {
    let streams = vec![
        PoolStream {
            info_hash: Some("h1".into()),
            is_br: true,
            is_dubbed: true,
            ..Default::default()
        },
        PoolStream {
            info_hash: Some("h2".into()),
            is_br: true,
            is_dubbed: true,
            ..Default::default()
        },
    ];
    let snapshot = streams.clone();
    let _ = br_dubbed_pool(&streams, &PoolOptions::default());
    let _ = top_seeded_pool(&streams, &PoolOptions::default());
    let _ =
        pick_br_dubbed_by_target_qualities(&streams, &HashSet::new(), 3, &PoolOptions::default());
    assert_eq!(streams, snapshot, "as funções só leem a entrada");
}
