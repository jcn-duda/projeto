//! Integridade e paridade do golden de `src/utils/release-index-media.ts`:
//! `bankRowsForMediaSource` (op `bank`, com engine semeado ou ausente) e
//! `mergeMediaSource` (op `merge`). Saída canônica: linhas `{hash,uri,title}`
//! ordenadas por hash, ou a fonte (`"CAM"` etc.) / `null`.

mod common;

use std::collections::HashMap;

use adom_core::{
    bank_rows_for_media_source, merge_media_source, BankRow, MagnetLike, MANIFEST_FORMAT,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/release-index-media.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/release-index-media.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-release-index-media.json");

const REGISTRY_MATCH: &str = "release-index-media/bankAndMerge";

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn magnet_of(v: &Value) -> MagnetLike {
    MagnetLike {
        magnet: text(&v["magnet"]),
        magnet_uri: text(&v["MagnetUri"]),
        guid: text(&v["Guid"]),
    }
}

fn row_of(v: &Value) -> BankRow {
    BankRow {
        hash: text(&v["hash"]).unwrap_or_default(),
        uri: text(&v["uri"]).unwrap_or_default(),
        title: text(&v["title"]).unwrap_or_default(),
    }
}

fn render(input: &str) -> String {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    match req["op"].as_str().expect("op presente") {
        "bank" => {
            let lote: Vec<(MagnetLike, String)> = req["lote"]
                .as_array()
                .expect("lote é array")
                .iter()
                .map(|e| (magnet_of(&e["item"]), text(&e["hash"]).unwrap_or_default()))
                .collect();
            let seeded: Vec<BankRow> = req["rows"]
                .as_array()
                .expect("rows é array")
                .iter()
                .map(row_of)
                .collect();
            let map = if req["engine"] == "seeded" {
                let lookup = move |need: &[String]| -> Vec<BankRow> {
                    seeded
                        .iter()
                        .filter(|r| need.iter().any(|h| h == &r.hash))
                        .cloned()
                        .collect()
                };
                bank_rows_for_media_source(&lote, Some(&lookup))
            } else {
                bank_rows_for_media_source(&lote, None)
            };
            let mut rows: Vec<Value> = map
                .values()
                .map(|r| json!({ "hash": r.hash, "uri": r.uri, "title": r.title }))
                .collect();
            rows.sort_by(|a, b| a["hash"].as_str().cmp(&b["hash"].as_str()));
            Value::Array(rows).to_string()
        }
        "merge" => {
            let item = magnet_of(&req["item"]);
            let title = text(&req["title"]).unwrap_or_default();
            let hash = text(&req["hash"]).unwrap_or_default();
            let prior = text(&req["prior"]);
            let bank: Option<HashMap<String, BankRow>> = req["bank"].as_array().map(|rows| {
                rows.iter()
                    .map(row_of)
                    .map(|r| (r.hash.clone(), r))
                    .collect()
            });
            let out = merge_media_source(&item, &title, &hash, prior.as_deref(), bank.as_ref());
            json!(out).to_string()
        }
        outra => panic!("op desconhecida: {outra}"),
    }
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/release-index-media.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-release-index-media.json"
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
    let mut ids = std::collections::HashSet::new();
    for case in &cases {
        assert!(ids.insert(case.id.as_str()), "id duplicado: {}", case.id);
    }
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

/// Sem engine (`readEngine()` nulo) o lote nunca produz linhas.
#[test]
fn sem_engine_nao_ha_linhas() {
    let lote = vec![(
        MagnetLike {
            magnet: Some("magnet:?xt=urn:btih:abc".into()),
            ..Default::default()
        },
        "abc".to_string(),
    )];
    assert!(bank_rows_for_media_source(&lote, None).is_empty());
}

/// Item com `dn=` não consulta o acervo: a linha do banco não entra no mapa.
#[test]
fn item_com_dn_nao_entra_na_consulta() {
    let lote = vec![(
        MagnetLike {
            magnet: Some("magnet:?xt=urn:btih:abc&dn=Movie.CAM".into()),
            ..Default::default()
        },
        "abc".to_string(),
    )];
    let lookup = |_: &[String]| -> Vec<BankRow> {
        vec![BankRow {
            hash: "abc".into(),
            uri: String::new(),
            title: "Movie".into(),
        }]
    };
    assert!(bank_rows_for_media_source(&lote, Some(&lookup)).is_empty());
}
