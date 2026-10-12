//! Integridade e paridade do golden de `filterBrAliases` + `MAX_BR_ALIASES`
//! (`src/utils/tmdb-br-aliases.ts`).
//!
//! Cada entrada é um JSON `{op:"filter",candidates?:[…],canonical?:[…]}` com
//! elementos string ou null (sem coerção). A saída é o `JSON.stringify` da lista
//! de aliases aceitos, na ordem dos candidatos e no máximo `MAX_BR_ALIASES`.
//!
//! `fetchBrAliases` NÃO entra: lê config, `Date.now()` e rede — fora do núcleo.

mod common;

use std::collections::HashSet;

use adom_core::{filter_br_aliases, MANIFEST_FORMAT, MAX_BR_ALIASES};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/tmdb-br-aliases.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/tmdb-br-aliases.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-tmdb-br-aliases.json");

const REGISTRY_MATCH: &str = "tmdb-br-aliases/filterBrAliases";

/// `null` vira `None`; string vira `Some`. Campo ausente/`null` é a lista vazia.
fn opt_list(v: &Value) -> Vec<Option<&str>> {
    if v.is_null() {
        return Vec::new();
    }
    v.as_array()
        .expect("candidates/canonical: lista")
        .iter()
        .map(|x| {
            if x.is_null() {
                None
            } else {
                Some(x.as_str().expect("candidates/canonical: string ou null"))
            }
        })
        .collect()
}

fn render(input: &str) -> String {
    let c: Value = serde_json::from_str(input).expect("entrada JSON válida");
    let before = c.clone();
    let titles = filter_br_aliases(&opt_list(&c["candidates"]), &opt_list(&c["canonical"]));
    // O contrato é só `&`: a chamada não pode tocar a entrada.
    assert!(c == before, "a entrada foi modificada pela chamada");
    serde_json::to_string(&titles).expect("saída serializável")
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry, vec![REGISTRY_MATCH.to_string()]);
    assert_eq!(m.output.lines, common::jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/tmdb-br-aliases.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-tmdb-br-aliases.json");
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
fn teto_e_ordem_dos_candidatos() {
    assert_eq!(MAX_BR_ALIASES, 2);
    let got = filter_br_aliases(
        &[
            Some("Operação Lioness"),
            Some("A Leoa Lioness"),
            Some("Lioness: O Legado"),
        ],
        &[Some("Lioness")],
    );
    // O terceiro aceito nem é visitado: o teto corta em 2.
    assert_eq!(
        got,
        vec!["Operação Lioness".to_string(), "A Leoa Lioness".to_string()]
    );
}

#[test]
fn artigo_e_digitos_nao_sao_significativos() {
    // "A" é artigo; "Origem" sozinho cobre o significativo do canônico.
    assert_eq!(
        filter_br_aliases(&[Some("Origem")], &[Some("A Origem")]),
        vec!["Origem".to_string()]
    );
    // Título só-dígitos não gera conjunto significativo: nada é admitido.
    assert!(filter_br_aliases(&[Some("1917 Guerra")], &[Some("1917")]).is_empty());
    assert!(filter_br_aliases(&[Some("1917")], &[Some("1917")]).is_empty());
}

#[test]
fn trim_bom_e_preservacao_do_valor_cru() {
    // BOM inicial é espaço para o `js_trim` (o `str::trim` do Rust não remove).
    assert_eq!(
        filter_br_aliases(&[Some("\u{FEFF}Operação: Lioness")], &[Some("Lioness")]),
        vec!["Operação: Lioness".to_string()]
    );
    // O alias aceito é o valor CRU (espaço interno preservado), como no TS.
    assert_eq!(
        filter_br_aliases(&[Some("Operação\u{A0}Lioness")], &[Some("Lioness")]),
        vec!["Operação\u{A0}Lioness".to_string()]
    );
}

#[test]
fn astral_conta_duas_unidades_utf16() {
    // Um caractere astral tem `length === 2` no JS: NÃO é significativo.
    assert!(filter_br_aliases(&[Some("\u{10400}")], &[Some("\u{10428}")]).is_empty());
    // Dobrado (4 unidades) é significativo; a caixa casa na normalização.
    assert_eq!(
        filter_br_aliases(
            &[Some("\u{10400}\u{10400} Extra")],
            &[Some("\u{10428}\u{10428}")]
        ),
        vec!["\u{10400}\u{10400} Extra".to_string()]
    );
}

#[test]
fn entrada_permanece_intacta() {
    let candidates: Vec<Option<&str>> = vec![Some("Operação Lioness"), None, Some("A Leoa")];
    let canonical: Vec<Option<&str>> = vec![Some("Lioness"), None];
    let candidates_snap = candidates.clone();
    let canonical_snap = canonical.clone();
    let _ = filter_br_aliases(&candidates, &canonical);
    assert_eq!(candidates, candidates_snap, "candidates não pode mutar");
    assert_eq!(canonical, canonical_snap, "canonical não pode mutar");
}
