//! Golden do contrato de config por usuário: segmento base64url da URL + selo
//! AES da `dk`. Oráculo: `dist/src/runtime.js` + `dist/src/utils/secret-box.js`
//! (gerador `scripts/golden/dump-config-encoding.mjs`).
//!
//! Segue o padrão dos outros testes de golden do crate: `include_str!`/
//! `include_bytes!`, sha256 conferido com o manifest, contagem de casos, e
//! paridade caso a caso por `op`. O golden exercita as duas metades do porte:
//! - `encode`/`decode`/`sealSegment`: o contrato de URL (ordem de chaves,
//!   coerção JS de `String()`/`Number()`, corte UTF-16, tabela ICU do `jl`);
//! - `seal`/`open`/`key`: o selo (scrypt + AES-256-GCM + layout `iv||tag||ct`).
//!
//! Os casos de SELO usam nonce fixo (o `seal` do Node usa `randomBytes(12)`,
//! que não é reproduzível); os casos de `open` consomem selos REAIS do Node com
//! IV aleatório, congelados no corpus — é o que prova interoperabilidade.

use std::collections::HashSet;

use adom_core::config_encoding::{
    b64url_decode, decode_config, derive_dk_key, encode_config, seal_dk, seal_segment, unseal_dk,
    IV_BYTES,
};
use adom_core::MANIFEST_FORMAT;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/config-encoding.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/config-encoding.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-config-encoding.json");

const EXPECTED_LINES: usize = 48;
const OPS: [&str; 6] = ["encode", "decode", "sealSegment", "seal", "open", "key"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: String,
    registry: Vec<String>,
    functions: Vec<FunctionEntry>,
    corpus: CorpusRef,
    output: OutputRef,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FunctionEntry {
    #[allow(dead_code)]
    id: String,
    name: String,
    source_path: String,
    source_sha256: String,
    artifact_path: String,
    artifact_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusRef {
    path: String,
    sha256: String,
    cases: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputRef {
    path: String,
    sha256: String,
    lines: usize,
}

/// Caso do golden. Os campos são opcionais porque cada `op` traz só os seus;
/// `expected` é `Value` (string, objeto ou null conforme a operação).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    id: String,
    op: String,
    #[serde(default)]
    raw: Option<Value>,
    #[serde(default)]
    segment: Option<String>,
    #[serde(default)]
    secret: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    defaults: Option<Value>,
    #[serde(default)]
    plaintext: Option<String>,
    #[serde(default)]
    sealed: Option<String>,
    expected: Value,
}

fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest.as_slice() {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Hex minúsculo, comparável ao `scryptSync(...).toString('hex')` do Node.
fn hex_bytes(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn jsonl_lines() -> Vec<&'static str> {
    let text = std::str::from_utf8(JSONL_BYTES).expect("golden precisa ser UTF-8");
    text.trim_end_matches('\n').split('\n').collect()
}

fn parse_all_rows() -> Vec<Row> {
    jsonl_lines()
        .iter()
        .map(|line| {
            serde_json::from_str::<Row>(line).expect("linha do golden commitada precisa ser válida")
        })
        .collect()
}

fn rows_of(op: &str) -> Vec<Row> {
    parse_all_rows()
        .into_iter()
        .filter(|r| r.op == op)
        .collect()
}

fn manifest() -> Manifest {
    serde_json::from_str(MANIFEST_TEXT).expect("manifest golden precisa ser JSON válido")
}

/// `nonce` do corpus é hex de 12 bytes; vira o array que `seal_dk` exige.
fn nonce_bytes(row: &Row) -> [u8; IV_BYTES] {
    let hex = row
        .nonce
        .as_deref()
        .unwrap_or_else(|| panic!("{}: caso de selo sem nonce", row.id));
    let mut out = [0u8; IV_BYTES];
    assert_eq!(
        hex.len(),
        IV_BYTES * 2,
        "{}: nonce com tamanho errado",
        row.id
    );
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
            .unwrap_or_else(|e| panic!("{}: nonce inválido: {e}", row.id));
    }
    out
}

fn expected_str(row: &Row) -> &str {
    row.expected
        .as_str()
        .unwrap_or_else(|| panic!("{}: esperado deveria ser string", row.id))
}

// ─── integridade do corpus ──────────────────────────────────────────────────

#[test]
fn manifest_tem_formato_e_funcoes_esperados() {
    let m = manifest();
    assert_eq!(m.format, MANIFEST_FORMAT);
    assert_eq!(m.registry.len(), 7);
    assert_eq!(m.functions.len(), 7);
    for f in &m.functions {
        assert_eq!(f.source_sha256.len(), 64);
        assert_eq!(f.artifact_sha256.len(), 64);
        match f.source_path.as_str() {
            "src/runtime.ts" => assert_eq!(f.artifact_path, "dist/src/runtime.js"),
            "src/utils/secret-box.ts" => {
                assert_eq!(f.artifact_path, "dist/src/utils/secret-box.js")
            }
            outra => panic!("sourcePath inesperado: {outra}"),
        }
    }
    let nomes: Vec<&str> = m.functions.iter().map(|f| f.name.as_str()).collect();
    for esperado in [
        "encode",
        "normalize",
        "decode",
        "sealSegment",
        "seal",
        "open",
        "isSealed",
    ] {
        assert!(
            nomes.contains(&esperado),
            "função ausente no manifest: {esperado}"
        );
    }
}

#[test]
fn contagem_de_casos_bate_com_manifest_e_corpus() {
    let m = manifest();
    let linhas = jsonl_lines();
    assert!(!linhas.is_empty(), "golden não pode ser vazio");
    assert_eq!(linhas.len(), EXPECTED_LINES, "linhas do JSONL");
    assert_eq!(m.output.lines, EXPECTED_LINES);
    assert_eq!(m.corpus.cases, EXPECTED_LINES);
    assert_eq!(m.output.path, "rust/golden/config-encoding.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-config-encoding.json");
    let corpus: Value = serde_json::from_str(CORPUS_TEXT).expect("corpus JSON válido");
    assert_eq!(
        corpus["cases"].as_array().expect("cases: array").len(),
        EXPECTED_LINES,
        "corpus fonte diverge do golden"
    );
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m = manifest();
    assert_eq!(sha256_hex(JSONL_BYTES), m.output.sha256);
    assert_eq!(sha256_hex(CORPUS_TEXT.as_bytes()), m.corpus.sha256);
}

#[test]
fn ids_sao_unicos_e_ops_conhecidos() {
    let rows = parse_all_rows();
    let mut ids = HashSet::new();
    for row in &rows {
        assert!(!row.id.is_empty(), "id vazio");
        assert!(ids.insert(row.id.clone()), "id duplicado: {}", row.id);
        assert!(
            OPS.contains(&row.op.as_str()),
            "op desconhecido: {}",
            row.op
        );
    }
}

// ─── paridade com o oráculo Node ────────────────────────────────────────────

#[test]
fn encode_bate_com_o_json_stringify_do_runtime() {
    let rows = rows_of("encode");
    assert!(!rows.is_empty(), "sem casos de encode");
    for row in &rows {
        let raw = row.raw.as_ref().expect("encode sem raw");
        let obtido = encode_config(raw);
        assert_eq!(
            obtido,
            expected_str(row),
            "encode caso {} divergiu\n  raw: {:?}\n  esperado: {:?}\n  obtido:   {:?}",
            row.id,
            row.raw,
            expected_str(row),
            obtido
        );
        // Round-trip pelo decodificador tolerante do `Buffer`.
        assert_eq!(
            String::from_utf8_lossy(&b64url_decode(&obtido)),
            String::from_utf8_lossy(&b64url_decode(expected_str(row))),
            "round-trip base64url do caso {}",
            row.id
        );
    }
}

#[test]
fn decode_bate_com_o_overlay_do_runtime() {
    let rows = rows_of("decode");
    assert!(!rows.is_empty(), "sem casos de decode");
    for row in &rows {
        let segmento = row.segment.as_deref().expect("decode sem segment");
        let defaults = row.defaults.clone().expect("decode sem defaults");
        let obtido = decode_config(segmento, &defaults, &row.secret);
        let esperado = &row.expected;
        match obtido {
            None => assert!(
                esperado.is_null(),
                "decode caso {}: Rust devolveu None, golden tinha {esperado:?}",
                row.id
            ),
            Some(valor) => assert_eq!(
                valor, *esperado,
                "decode caso {} divergiu\n  segment: {:?}\n  secret:  {:?}",
                row.id, segmento, row.secret
            ),
        }
    }
}

#[test]
fn seal_bate_com_o_blob_do_secret_box() {
    let rows = rows_of("seal");
    assert!(!rows.is_empty(), "sem casos de seal");
    for row in &rows {
        let claro = row.plaintext.as_deref().unwrap_or_default();
        let obtido = seal_dk(claro, &row.secret, &nonce_bytes(row));
        assert_eq!(
            obtido,
            expected_str(row),
            "seal caso {} divergiu\n  claro:  {:?}\n  secret: {:?}\n  esperado: {:?}\n  obtido:   {:?}",
            row.id,
            claro,
            row.secret,
            expected_str(row),
            obtido
        );
        // O caminho identidade (sem segredo / sem texto / já selado) é o próprio
        // `seal` do TS; só faz sentido cobrar round-trip quando houve selo de verdade.
        if obtido == claro {
            assert!(
                row.secret.is_empty() || claro.is_empty() || claro.starts_with("enc.v1."),
                "seal caso {}: devolveu identidade sem motivo",
                row.id
            );
        } else {
            assert_eq!(
                unseal_dk(&obtido, &row.secret),
                claro,
                "seal caso {}: o próprio selo não abriu de volta",
                row.id
            );
        }
    }
}

#[test]
fn open_abre_os_selos_reais_do_node() {
    let rows = rows_of("open");
    assert!(!rows.is_empty(), "sem casos de open");
    for row in &rows {
        let selo = row.sealed.as_deref().expect("open sem sealed");
        let obtido = unseal_dk(selo, &row.secret);
        assert_eq!(
            obtido,
            expected_str(row),
            "open caso {} divergiu\n  sealed: {:?}\n  secret: {:?}\n  esperado: {:?}\n  obtido:   {:?}",
            row.id,
            selo,
            row.secret,
            expected_str(row),
            obtido
        );
    }
}

#[test]
fn derive_dk_key_bate_com_o_scryptsync_do_node() {
    let rows = rows_of("key");
    assert!(!rows.is_empty(), "sem casos de key");
    for row in &rows {
        let hex = hex_bytes(&derive_dk_key(&row.secret));
        assert_eq!(hex, expected_str(row), "chave derivada do caso {}", row.id);
    }
}

#[test]
fn seal_segment_bate_com_o_runtime_e_preserva_o_resto() {
    let rows = rows_of("sealSegment");
    assert!(!rows.is_empty(), "sem casos de sealSegment");
    for row in &rows {
        let segmento = row.segment.as_deref().expect("sealSegment sem segment");
        let obtido = seal_segment(segmento, &row.secret, &nonce_bytes(row));
        if row.expected.is_null() {
            assert_eq!(
                obtido, None,
                "sealSegment caso {}: deveria rejeitar",
                row.id
            );
            continue;
        }
        let esperado = expected_str(row);
        assert_eq!(
            obtido.as_deref(),
            Some(esperado),
            "sealSegment caso {} divergiu\n  segment:  {:?}\n  secret:   {:?}\n  esperado: {:?}\n  obtido:   {:?}",
            row.id,
            segmento,
            row.secret,
            esperado,
            obtido
        );
    }
}
