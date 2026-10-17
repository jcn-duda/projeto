//! Integridade e paridade do golden do filtro de episódio
//! (`filterSeriesEpisodeRaw` de `src/providers/stream-builder-episode-filter.ts`).
//!
//! O `input` de cada caso é exatamente o que a ponte
//! `filterSeriesEpisodeNapi` recebe: `items` (só os campos de `RawItem` que o
//! laço lê), `season`, `episode`, `universe`, `names`, `unaired`,
//! `preAirHashes` (o pre-air é corte do lado Node — o corpus traz a lista já
//! excluída; nada de I/O) — mais `airDate`/`now`, que só o oráculo TS usa para
//! DERIVAR `unaired`/`preAirHashes` na geração. O oráculo (`esm`) não rotula o
//! laço: a saída canônica é `{"kept":[…],"dropped":[…]}` e AQUI os dois
//! conjuntos são comparados (os motivos do porte ficam só para log).

mod common;

use std::collections::HashSet;

use adom_core::{filter_series_episode, EpisodeFilterItem, MANIFEST_FORMAT};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/series-episode-filter.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/series-episode-filter.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-series-episode-filter.json");

const REGISTRY_MATCH: &str = "series-episode-filter/filterSeriesEpisodeRaw";

/// Campos de string opcionais do JSON; qualquer outra coisa vira ausente.
/// O vazamento é deliberado: os casos vivem até o fim do processo de teste.
fn opt_str(v: &Value) -> Option<&'static str> {
    v.as_str().map(|s| -> &'static str {
        let b: &'static str = Box::leak(s.to_string().into_boxed_str());
        b
    })
}

fn item_of(v: &Value) -> EpisodeFilterItem<'static> {
    EpisodeFilterItem {
        title: opt_str(&v["title"]),
        title_pascal: opt_str(&v["Title"]),
        magnet: opt_str(&v["magnet"]),
        magnet_uri: opt_str(&v["MagnetUri"]),
        guid: opt_str(&v["Guid"]),
        info_hash: opt_str(&v["infoHash"]),
        from_account: v["fromAccount"].as_bool().unwrap_or(false),
        is_br: v["isBr"].as_bool().unwrap_or(false),
    }
}

/// Dono dos dados de um caso; a chamada empresta diste struct.
struct Owned {
    items: Vec<EpisodeFilterItem<'static>>,
    universe: Vec<String>,
    names: Vec<String>,
    season: i64,
    episode: i64,
    unaired: bool,
    pre_air_hashes: Vec<String>,
}

fn owned_of(input: &str) -> Owned {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    let strings = |k: &str| -> Vec<String> {
        req[k]
            .as_array()
            .unwrap_or_else(|| panic!("{k}: array"))
            .iter()
            .map(|s| s.as_str().expect("nome é string").to_string())
            .collect()
    };
    Owned {
        items: req["items"]
            .as_array()
            .expect("items: array")
            .iter()
            .map(item_of)
            .collect(),
        universe: strings("universe"),
        names: strings("names"),
        season: req["season"].as_i64().expect("season: inteiro"),
        episode: req["episode"].as_i64().expect("episode: inteiro"),
        unaired: req["unaired"].as_bool().expect("unaired: bool"),
        pre_air_hashes: strings("preAirHashes"),
    }
}

/// Saída canônica, idêntica ao `JSON.stringify` do oráculo: kept e dropped
/// (ordem de disparo do laço). O motivo do porte não entra na comparação.
fn canonical(outcome: &adom_core::SeriesEpisodeOutcome) -> String {
    let dropped: Vec<u32> = outcome.rejected.iter().map(|(i, _)| *i).collect();
    json!({ "kept": outcome.kept, "dropped": dropped }).to_string()
}

/// Roda o porte e devolve a saída canônica. `titlePrecisionTailCut` fica no
/// default (`true`), igual ao staging do oráculo (sem env).
fn render(input: &str) -> String {
    let o = owned_of(input);
    let universe: Vec<String> = o.universe.clone();
    let names: Vec<String> = o.names.clone();
    let pre_air: Vec<String> = o.pre_air_hashes.clone();
    canonical(&filter_series_episode(
        &o.items, o.season, o.episode, &universe, &names, o.unaired, &pre_air, true,
    ))
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/series-episode-filter.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-series-episode-filter.json"
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
    assert!(cases.len() >= 10, "golden precisa ter pelo menos 10 casos");
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

/// kept E dropped, caso a caso, contra o que o oráculo do `esm` mediu.
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

/// Os rótulos do porte são contrato desta build (o TS atual não rotula o
/// laço); a ordem tem de continuar a do `continue` do TS.
#[test]
fn motivos_tem_a_ordem_do_laco() {
    use adom_core::SeriesEpisodeRejectReason as R;
    let hash: &'static str = Box::leak("ab".repeat(20).into_boxed_str());
    let universe = vec!["lanterns".to_string()];
    let names = vec!["Lanterns".to_string()];
    let pre_air = vec![hash.to_string()];
    let base = |info_hash: Option<&'static str>| EpisodeFilterItem {
        title: Some("Lanterns S01E08 1080p"),
        title_pascal: None,
        magnet: Some(
            "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Lanterns+S01E05",
        ),
        magnet_uri: None,
        guid: None,
        info_hash,
        from_account: false,
        is_br: false,
    };
    let items = vec![base(Some(hash))];
    let out = filter_series_episode(&items, 1, 8, &universe, &names, true, &pre_air, true);
    // O hash na lista de pre-air corta ANTES de tudo: é o 1º motivo.
    assert_eq!(out.rejected[0], (0, R::PreAir));
    // Sem pre-air, o dn contraditório vira `episode`.
    let items = vec![base(None)];
    let out = filter_series_episode(&items, 1, 8, &universe, &names, true, &[], true);
    assert_eq!(out.rejected[0], (0, R::Episode));
}
