//! Integridade e paridade do golden da resolução de vídeo:
//! `parse_video_resolution`, `parse_mp4_tail`, `is_mp4` e
//! `quality_from_resolution`.
//!
//! O `input` de cada caso é um JSON tipado (`{"op":…,"hex":…}` para bytes ou
//! `{"op":"quality","width":…,"height":…}`). O hex é decodificado para `Vec<u8>`
//! — bytes de verdade, nunca string — e o `op` seleciona a função. A saída
//! canônica é `null`, `true|false`, `"<rótulo>"` ou `{"width":W,"height":H}`,
//! exatamente como o oráculo do dist mediu. O porte Rust não replica lógica do
//! Node: só reproduz a saída commitada no golden.

mod common;

use std::collections::HashSet;

use adom_core::{
    is_mp4, parse_mp4_tail, parse_video_resolution, quality_from_resolution, VideoResolution,
    MANIFEST_FORMAT,
};
use serde_json::Value;

use common::{assert_corpus_matches, manifest, parse_cases, sha256_hex};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/video-header.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/video-header.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-video-header.json");

const REGISTRY_MATCH: &str = "video-header/videoResolution";

/// Hex (par, minúsculo) → bytes.
fn hex_bytes(hex: &str) -> Vec<u8> {
    let raw = hex.as_bytes();
    let mut out = Vec::with_capacity(raw.len() / 2);
    let mut chunks = raw.chunks_exact(2);
    for pair in &mut chunks {
        let hi = (pair[0] as char).to_digit(16).expect("hex inválido") as u8;
        let lo = (pair[1] as char).to_digit(16).expect("hex inválido") as u8;
        out.push(hi * 16 + lo);
    }
    assert!(chunks.remainder().is_empty(), "hex ímpar: {hex:?}");
    out
}

fn bytes_of(req: &Value) -> Vec<u8> {
    hex_bytes(req["hex"].as_str().expect("hex precisa ser string"))
}

fn fmt_res(res: Option<VideoResolution>) -> String {
    match res {
        Some(v) => format!("{{\"width\":{},\"height\":{}}}", v.width, v.height),
        None => "null".to_string(),
    }
}

fn bit(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

/// O `input` do caso é um JSON com `op` (`head`|`tail`|`ismp4`|`quality`); a
/// saída é a string canônica REAL da função escolhida.
fn render(input: &str) -> String {
    let req: Value = serde_json::from_str(input).expect("input do caso é JSON");
    match req["op"].as_str().expect("op precisa ser string") {
        "head" => fmt_res(parse_video_resolution(&bytes_of(&req))),
        "tail" => fmt_res(parse_mp4_tail(&bytes_of(&req))),
        "ismp4" => bit(is_mp4(&bytes_of(&req))).to_string(),
        "quality" => {
            let width = req["width"].as_u64().expect("width precisa ser inteiro") as u32;
            let height = req["height"].as_u64().expect("height precisa ser inteiro") as u32;
            match quality_from_resolution(width, height) {
                Some(label) => format!("\"{label}\""),
                None => "null".to_string(),
            }
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
    assert_eq!(m.output.path, "rust/golden/video-header.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-video-header.json");
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

/// Negativos diretos: entradas vazias/curtas nunca viram resolução e um buffer
/// vazio nunca é MP4. (Contrato do TS sem depender do corpus.)
#[test]
fn entradas_vazias_nao_produzem_resolucao() {
    assert_eq!(parse_video_resolution(&[]), None);
    assert_eq!(parse_video_resolution(&[0; 11]), None);
    assert_eq!(parse_mp4_tail(&[]), None);
    assert_eq!(parse_mp4_tail(&[0x6d, 0x6f, 0x6f, 0x76]), None);
    assert!(!is_mp4(&[]));
    assert_eq!(quality_from_resolution(0, 1080), None);
    assert_eq!(quality_from_resolution(16385, 1080), None);
}

/// Regressão do limite achado em revisão: a caixa `tkhd` terminando EXATAMENTE
/// no fim do buffer (`pos + header == len`) fazia o porte ingênuo ler
/// `buf[pos + header]` fora dos limites e entrar em pânico. O TS vê `undefined`
/// ali, `undefined === 1` é falso e ele devolve `null`; o Rust tem de devolver
/// `None`, não abortar.
#[test]
fn caixa_tkhd_no_fim_do_buffer_nao_estoura() {
    // 32 bits: ftyp seguido de tkhd(size=8); a caixa termina no fim absoluto.
    let v0 = hex_bytes("000000106674797069736f6d0000020000000008746b6864");
    assert_eq!(v0.len(), 24);
    assert_eq!(parse_video_resolution(&v0), None);
    // 64 bits: ftyp seguido de tkhd(size=1, largesize=16) no fim absoluto.
    let v1 = hex_bytes("000000106674797069736f6d0000020000000001746b68640000000000000010");
    assert_eq!(v1.len(), 32);
    assert_eq!(parse_video_resolution(&v1), None);
}
