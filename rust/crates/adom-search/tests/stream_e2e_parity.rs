//! Harness de paridade do corpus `rust/golden/stream-e2e` (Fase A.5).
//!
//! O corpus guarda por caso `request.json` + `response.json` (envelope HTTP do
//! `/stream`). Casos capturados com `--with-internal` ganham também
//! `inputs/{meta,config,index,collect,debrid}.json` — as MESMAS entradas que o
//! gate congelado (`orchestrator::frozen_gate`) consome.
//!
//! Este alvo:
//!
//! 1. carrega o manifest, confere sha256 e campos obrigatórios (sanidade);
//! 2. compara o que já é determinístico via API pública (`request::*`,
//!    `contract`);
//! 3. remonta o corpo capturado com o `frozen_gate` (`run_case_with_expected`):
//!    o `response.json` é envelope (`{status,headers,body}`), então o diff usa
//!    `body` e compara só `streams`. O `request.json` do corpus tem o segmento
//!    de config mascarado (`{{config}}`) — o replay usa `e30`, que decodifica
//!    `{}` (o mesmo default usado pelo harness de `stream-frozen`).
//!
//! O `FrozenCase` lê os inputs de um diretório no layout `stream-frozen`; os
//! casos do e2e são materializados num diretório temporário com um
//! `request.json` no formato do gate (`type`/`stream_id` vêm do manifest, porque
//! o request do corpus guarda só o path mascarado).
//!
//! Relógio e ordem da lista/chaves NÃO entram no assert (contrato §9.3).

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use adom_search::{parse_stream_path, reply_deadline_ms};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "stream_e2e_parity/part2.rs"]
mod part2;

const FORMAT: &str = "adom-stream-e2e/1";
/// Contagem congelada do manifest capturado; regeneração que encolher o corpus
/// sem atualizar este assert é regressão visível.
const EXPECTED_CASES: usize = 51;
/// Segmento base64url de `{}` — troca o `{{config}}` mascarado por um path
/// que `parse_stream_path` aceita (só `[A-Za-z0-9_-]`).
const CONFIG_SEGMENT: &str = "e30";

fn corpus_root() -> PathBuf {
    // `adom-search` → `crates/` → `rust/` → `golden/stream-e2e`
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../golden/stream-e2e")
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

#[derive(Debug, Deserialize)]
struct Manifest {
    format: String,
    cases: Vec<ManifestCase>,
}

#[derive(Debug, Deserialize)]
struct ManifestCase {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    stream_id: String,
    dir: String,
    status: u16,
    #[serde(rename = "cacheMaxAge")]
    cache_max_age: u32,
    files: ManifestFiles,
}

#[derive(Debug, Deserialize)]
struct ManifestFiles {
    #[serde(rename = "request.json")]
    request: String,
    #[serde(rename = "response.json")]
    response: String,
}

struct LoadedCase {
    meta: ManifestCase,
    request: Value,
    response: Value,
}

fn load_corpus() -> (PathBuf, Manifest, Vec<LoadedCase>) {
    let root = corpus_root();
    assert!(
        root.join("manifest.json").is_file(),
        "corpus não encontrado em {} (CARGO_MANIFEST_DIR={})",
        root.display(),
        env!("CARGO_MANIFEST_DIR")
    );
    let manifest: Manifest = serde_json::from_str(
        &fs::read_to_string(root.join("manifest.json")).expect("manifest legível"),
    )
    .expect("manifest JSON válido");

    let mut loaded = Vec::with_capacity(manifest.cases.len());
    for meta in &manifest.cases {
        let dir = root.join(&meta.dir);
        let req_path = dir.join("request.json");
        let res_path = dir.join("response.json");
        let req_bytes =
            fs::read(&req_path).unwrap_or_else(|e| panic!("{}: {e}", req_path.display()));
        let res_bytes =
            fs::read(&res_path).unwrap_or_else(|e| panic!("{}: {e}", res_path.display()));
        assert_eq!(
            sha256_hex(&req_bytes),
            meta.files.request,
            "sha256 request diverge no caso {}",
            meta.id
        );
        assert_eq!(
            sha256_hex(&res_bytes),
            meta.files.response,
            "sha256 response diverge no caso {}",
            meta.id
        );
        loaded.push(LoadedCase {
            meta: ManifestCase {
                id: meta.id.clone(),
                kind: meta.kind.clone(),
                stream_id: meta.stream_id.clone(),
                dir: meta.dir.clone(),
                status: meta.status,
                cache_max_age: meta.cache_max_age,
                files: ManifestFiles {
                    request: meta.files.request.clone(),
                    response: meta.files.response.clone(),
                },
            },
            request: serde_json::from_slice(&req_bytes).expect("request.json"),
            response: serde_json::from_slice(&res_bytes).expect("response.json"),
        });
    }
    (root, manifest, loaded)
}

/// Path capturado → path concreto que o parser aceita.
fn concrete_path(masked: &str) -> String {
    masked.replace("{{config}}", CONFIG_SEGMENT)
}

#[test]
fn corpus_carrega_campos_obrigatorios_e_sha256() {
    let (_root, manifest, cases) = load_corpus();
    assert_eq!(manifest.format, FORMAT);
    assert_eq!(
        cases.len(),
        EXPECTED_CASES,
        "contagem do corpus mudou — atualize EXPECTED_CASES se a captura for intencional"
    );
    assert_eq!(manifest.cases.len(), cases.len());

    let mut ids = BTreeSet::new();
    for case in &cases {
        assert!(
            ids.insert(case.meta.id.as_str()),
            "id duplicado: {}",
            case.meta.id
        );
        assert!(
            matches!(case.meta.kind.as_str(), "movie" | "series"),
            "type inválido no caso {}",
            case.meta.id
        );
        assert!(
            !case.meta.stream_id.is_empty(),
            "stream_id vazio em {}",
            case.meta.id
        );

        // request: method + path
        assert_eq!(
            case.request["method"].as_str(),
            Some("GET"),
            "method no caso {}",
            case.meta.id
        );
        assert!(
            case.request["path"]
                .as_str()
                .is_some_and(|p| p.contains("/stream/")),
            "path sem /stream/ no caso {}",
            case.meta.id
        );

        // response: status + corpo JSON (ou body_raw)
        assert_eq!(
            case.response["status"].as_u64(),
            Some(u64::from(case.meta.status)),
            "status envelope × manifest no caso {}",
            case.meta.id
        );
        let has_body = case.response.get("body").is_some();
        let has_raw = case.response.get("body_raw").is_some();
        assert!(
            has_body || has_raw,
            "response sem body/body_raw no caso {}",
            case.meta.id
        );
        if has_body {
            assert!(
                case.response["body"].get("streams").is_some(),
                "body.streams ausente no caso {}",
                case.meta.id
            );
            assert!(
                case.response["body"].get("cacheMaxAge").is_some(),
                "body.cacheMaxAge ausente no caso {}",
                case.meta.id
            );
        }
    }
}

#[test]
fn request_parse_bate_com_type_e_stream_id() {
    let (_root, _manifest, cases) = load_corpus();
    for case in &cases {
        let masked = case.request["path"]
            .as_str()
            .unwrap_or_else(|| panic!("path string no caso {}", case.meta.id));
        let path = concrete_path(masked);
        let target = parse_stream_path(&path).unwrap_or_else(|| {
            panic!(
                "parse_stream_path falhou no caso {} path={path}",
                case.meta.id
            )
        });
        assert_eq!(
            target.kind, case.meta.kind,
            "kind diverge no caso {}",
            case.meta.id
        );
        assert_eq!(
            target.id, case.meta.stream_id,
            "id diverge no caso {}",
            case.meta.id
        );
        assert_eq!(
            target.encoded.as_deref(),
            Some(CONFIG_SEGMENT),
            "encoded esperado no caso {}",
            case.meta.id
        );
    }
    // UA do corpus é sempre o capturador (não Dart/) — um assert basta.
    // Ramo app: UA sintético fora do corpus.
    assert_eq!(
        reply_deadline_ms(Some("adom-stream-e2e/1"), 9200, 15000),
        9200
    );
    assert_eq!(
        reply_deadline_ms(Some("Dart/3.0 (powermovie)"), 9200, 15000),
        15000
    );
}
