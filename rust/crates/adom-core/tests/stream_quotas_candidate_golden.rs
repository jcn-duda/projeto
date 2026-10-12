//! Integridade e paridade do golden de `src/utils/stream-quotas-candidate.ts`:
//! `QUALITY_KEYS`, `streamQuality` (op `quality`) e `selectQualityCandidates`
//! (op `select`). Saída canônica: JSON da função, como o oráculo do dist.

mod common;

use adom_core::stream_quotas_extra::{QualityLimits, SelectCandidatesOpts};
use adom_core::{
    candidate_stream_quality, select_candidate_streams, CandidateStream, MANIFEST_FORMAT,
    QUALITY_KEYS,
};
use serde_json::{json, Value};

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/stream-quotas-candidate.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/stream-quotas-candidate.manifest.json");
const CORPUS_TEXT: &str =
    include_str!("../../../../scripts/golden/corpus-stream-quotas-candidate.json");

const REGISTRY_MATCH: &str = "stream-quotas-candidate/selectQualityCandidates";

fn text(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn stream_of(v: &Value) -> CandidateStream {
    CandidateStream {
        title: text(&v["title"]),
        name: text(&v["name"]),
        quality: v["_quality"].as_str().map(str::to_string),
        is_br: v["_br"].as_bool() == Some(true),
        is_lied: v["_lied"].as_bool() == Some(true),
    }
}

/// Opções parciais: chave ausente vale o default do TS (`maxResults` 40,
/// `brFirst` true, `candidateFactor` 1, reservas 0, sem limites por qualidade).
fn opts_of(o: &Value) -> SelectCandidatesOpts {
    let mut opts = SelectCandidatesOpts::default();
    if let Some(v) = o["maxResults"].as_f64() {
        opts.max_results = v;
    }
    if let Some(v) = o["brReservedSlots"].as_f64() {
        opts.br_reserved_slots = v;
    }
    if let Some(v) = o["brReservedPerQuality"].as_f64() {
        opts.br_reserved_per_quality = v;
    }
    if let Some(v) = o["candidateFactor"].as_f64() {
        opts.candidate_factor = v;
    }
    if let Some(v) = o["brFirst"].as_bool() {
        opts.br_first = v;
    }
    let mut limits: QualityLimits = QualityLimits::new();
    if let Some(map) = o["qualityLimits"].as_object() {
        for (k, v) in map {
            limits.insert(k.clone(), v.as_f64().unwrap_or(0.0));
        }
    }
    opts.quality_limits = limits;
    opts
}

fn render(input: &str) -> String {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    match req["op"].as_str().expect("op presente") {
        "keys" => json!(QUALITY_KEYS).to_string(),
        "quality" => {
            let s = &req["stream"];
            let quality = s["_quality"].as_str();
            json!(candidate_stream_quality(
                quality,
                &text(&s["title"]),
                &text(&s["name"])
            ))
            .to_string()
        }
        "select" => {
            let streams: Vec<CandidateStream> = req["streams"]
                .as_array()
                .expect("streams é array")
                .iter()
                .map(stream_of)
                .collect();
            let opts = opts_of(&req["opts"]);
            json!(select_candidate_streams(&streams, &opts)).to_string()
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
    assert_eq!(m.output.path, "rust/golden/stream-quotas-candidate.jsonl");
    assert_eq!(
        m.corpus.path,
        "scripts/golden/corpus-stream-quotas-candidate.json"
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

/// Título e nome vazios caem na classificação de "sem resolução".
#[test]
fn qualidade_sem_titulo_e_sem_nome_vira_sem_resolucao() {
    assert_eq!(candidate_stream_quality(None, "", ""), "sem resolução");
    assert_eq!(candidate_stream_quality(Some(""), "", ""), "sem resolução");
}
