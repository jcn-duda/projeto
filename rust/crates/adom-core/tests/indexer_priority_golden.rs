//! Integridade e paridade do golden de `priorityMap` + `compareIndexerPriority`
//! (`src/utils/indexer-priority.ts`).
//!
//! Cada entrada é um JSON com `op`:
//! - `"map"`: `ids` (lista de string/null, ausente = `[]`) →
//!   `{"map":[[chave,posição],…],"stable":true}`.
//! - `"compare"`: `ranks` (lista de ids, `null`/ausente = sem ranking) +
//!   `a`/`b` (`_indexer`; ausente/`null` = None) →
//!   `{"diff":n,"stable":true}`.
//!
//! `stable` é o eco de não-mutação: a entrada é clonada antes da chamada e
//! comparada depois. O `Map` do TS vira o vetor ordenado de pares do porte.

mod common;

use std::collections::HashSet;

use adom_core::{compare_indexer_priority, priority_map, MANIFEST_FORMAT};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/indexer-priority.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/indexer-priority.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-indexer-priority.json");

const REGISTRY_MATCH: &str = "indexer-priority/priorityMap";
/// Espelho local do `MAX_SAFE_INTEGER` para os asserts de borda.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// `null` do JSON vira `None` (null/undefined no JS); string vira `Some`.
fn opt_arg(v: &Value) -> Option<&str> {
    if v.is_null() {
        None
    } else {
        Some(v.as_str().expect("id/_indexer é string ou null"))
    }
}

/// Lista de ids: ausente/`null` é a lista vazia (default `[]` do TS).
fn opt_list(v: &Value) -> Vec<Option<&str>> {
    if v.is_null() {
        return Vec::new();
    }
    v.as_array()
        .expect("ids/ranks: lista")
        .iter()
        .map(opt_arg)
        .collect()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let before = c.clone();
    let payload = match c["op"].as_str().expect("op: string") {
        "map" => json!({ "map": priority_map(&opt_list(&c["ids"])) }),
        "compare" => {
            // `ranks` null/ausente é o `null` do TS (o `!ranks` do desempate);
            // lista vazia é um Map de tamanho 0. Os dois devolvem 0.
            let ranks = if c["ranks"].is_null() {
                None
            } else {
                Some(priority_map(&opt_list(&c["ranks"])))
            };
            let diff = match &ranks {
                Some(r) => compare_indexer_priority(opt_arg(&c["a"]), opt_arg(&c["b"]), r),
                None => 0,
            };
            json!({ "diff": diff })
        }
        other => panic!("op desconhecida: {other}"),
    };
    // O contrato é só `&`: a chamada não pode tocar a entrada. O eco `stable`
    // do oracle só é `true` enquanto isto valer.
    let stable = c == before;
    assert!(stable, "a entrada foi modificada pela chamada");
    let mut out = payload.as_object().expect("payload: objeto").clone();
    out.insert("stable".to_string(), Value::Bool(stable));
    serde_json::to_string(&Value::Object(out)).expect("saída serializável")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/indexer-priority.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-indexer-priority.json");
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

#[test]
fn mapa_preserva_posicao_original_e_primeira_ocorrencia() {
    // Posição 4 (a de " B "), não 2: os ids vazios das posições 1 e 2 não
    // recomprimem o índice guardado.
    let map = priority_map(&[Some("A"), None, Some(""), Some("a"), Some(" B ")]);
    assert_eq!(
        map,
        vec![("a".to_string(), 0), ("b".to_string(), 4)],
        "posição original e primeira ocorrência"
    );
    // Caso do TS: o mesmo id em caixas diferentes conta uma vez.
    let map = priority_map(&[
        Some("NerdFilmes"),
        Some("comandotorrents"),
        Some("nerdfilmes"),
    ]);
    assert_eq!(
        map,
        vec![
            ("nerdfilmes".to_string(), 0),
            ("comandotorrents".to_string(), 1)
        ]
    );
}

#[test]
fn desempate_vazio_ou_desconhecido_e_o_esperado() {
    let ranks = priority_map(&[Some("NerdFilmes"), None, Some("comandotorrents")]);
    assert_eq!(
        ranks,
        vec![
            ("nerdfilmes".to_string(), 0),
            ("comandotorrents".to_string(), 2),
        ]
    );
    // Sem ranking, não desempata (o `ranks.size === 0` do TS).
    assert_eq!(compare_indexer_priority(Some("a"), Some("b"), &[]), 0);
    assert_eq!(
        compare_indexer_priority(Some("nerdfilmes"), Some("comandotorrents"), &ranks),
        -2
    );
    // Fonte fora do ranking vai para o fim, nas duas ordens.
    assert_eq!(
        compare_indexer_priority(Some("desconhecido"), Some("nerdfilmes"), &ranks),
        MAX_SAFE
    );
    assert_eq!(
        compare_indexer_priority(Some("nerdfilmes"), Some("desconhecido"), &ranks),
        -MAX_SAFE
    );
    // Duas fontes fora do ranking empatam.
    assert_eq!(compare_indexer_priority(Some("x"), Some("y"), &ranks), 0);
    // `None` é a chave vazia: também fica fora do ranking.
    assert_eq!(
        compare_indexer_priority(None, Some("nerdfilmes"), &ranks),
        MAX_SAFE
    );
}

#[test]
fn trim_bom_e_caixa_unicode_17() {
    // BOM e espaços nas pontas saem (js_trim inclui U+FEFF, que str::trim não).
    assert_eq!(
        priority_map(&[Some("\u{FEFF}Nerd\u{3000}")]),
        vec![("nerd".to_string(), 0)]
    );
    // Letra nova da Unicode 17 (U+A7CE -> U+A7CF).
    assert_eq!(
        priority_map(&[Some("\u{A7CE}")]),
        vec![("\u{A7CF}".to_string(), 0)]
    );
    // Astral com mapeamento de caixa (Deseret U+10400 -> U+10428).
    assert_eq!(
        priority_map(&[Some("\u{10400}")]),
        vec![("\u{10428}".to_string(), 0)]
    );
}

#[test]
fn entrada_permanece_intacta() {
    let ids: Vec<Option<&str>> = vec![Some("A"), None, Some("a"), Some(" B ")];
    let snapshot = ids.clone();
    let _ = priority_map(&ids);
    assert_eq!(ids, snapshot, "priority_map não pode mutar a entrada");

    let ranks = priority_map(&[Some("A"), Some("b")]);
    let ranks_snapshot = ranks.clone();
    let _ = compare_indexer_priority(Some("a"), Some("z"), &ranks);
    assert_eq!(ranks, ranks_snapshot, "compare não pode mutar o ranking");
}
