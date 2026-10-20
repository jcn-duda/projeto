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

use adom_search::orchestrator::frozen_gate;
use adom_search::{parse_stream_path, reply_deadline_ms, StreamItem, StreamResponse};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const FORMAT: &str = "adom-stream-e2e/1";
/// Contagem congelada do manifest capturado; regeneração que encolher o corpus
/// sem atualizar este assert é regressão visível.
const EXPECTED_CASES: usize = 51;
/// Segmento base64url de `{}` — troca o `{{config}}` mascarado por um path
/// que `parse_stream_path` aceita (só `[A-Za-z0-9_-]`).
const CONFIG_SEGMENT: &str = "e30";
/// O mesmo `--base` da captura: o gate mascara origem nos DOIS lados do diff.
const E2E_ORIGIN: &str = "http://127.0.0.1:7100";
/// Piloto da Fase 1: único caso com as fixtures internas até o batch.
const PILOT_CASE: &str = "movie-cidade-de-deus";
/// Arquivos internos mínimos para o replay (`meta` e `config` são obrigatórios
/// no `FrozenCase`; `collect`/`index`/`debrid` são opcionais lá).
const REQUIRED_INPUTS: [&str; 3] = [
    "inputs/meta.json",
    "inputs/config.json",
    "inputs/collect.json",
];

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

/// Identidade estável de um item (ordem da lista fica de fora).
fn stream_identity(item: &StreamItem) -> String {
    if let Some(h) = &item.info_hash {
        return format!("ih:{h}");
    }
    if let Some(url) = &item.url {
        // Hash do path `/resolve/<infoHash>` quando presente; senão URL mascarada.
        if let Some(rest) = url.split("/resolve/").nth(1) {
            let hash = rest.split(['?', '/']).next().unwrap_or(rest);
            return format!("resolve:{hash}");
        }
        return format!("url:{url}");
    }
    if let Some(ext) = &item.external_url {
        return format!("ext:{ext}");
    }
    "empty".to_string()
}

fn stream_identity_set(streams: &[StreamItem]) -> BTreeSet<String> {
    streams.iter().map(stream_identity).collect()
}

/// Path capturado → path concreto que o parser aceita.
fn concrete_path(masked: &str) -> String {
    masked.replace("{{config}}", CONFIG_SEGMENT)
}

// ── remontagem via gate congelado ───────────────────────────────────────────

/// O caso tem as fixtures internas que o replay exige?
fn has_inputs(root: &Path, meta: &ManifestCase) -> bool {
    let dir = root.join(&meta.dir);
    REQUIRED_INPUTS.iter().all(|name| dir.join(name).is_file())
}

/// `response.json` é envelope: a remontagem compara o `body` (o JSON que o
/// Stremio recebeu), nunca o envelope.
fn expected_body(meta: &ManifestCase, response: &Value) -> Result<Value, String> {
    let Some(body) = response.get("body") else {
        let has_raw = response.get("body_raw").is_some();
        return Err(format!(
            "response.json sem body{} no caso {}",
            if has_raw {
                " (só body_raw: corpo não-JSON não remonta)"
            } else {
                ""
            },
            meta.id
        ));
    };
    Ok(body.clone())
}

/// Materializa o caso do e2e num diretório no layout do `FrozenCase`.
///
/// O gate lê `<caso>/request.json` (tipo/id/tamanho do encoded) + `<caso>/inputs/*`;
/// o request do corpus guarda só o path mascarado, então os campos de replay vêm
/// do manifest. Nada é inventado: os inputs são copiados byte a byte.
fn materialize_case(root: &Path, meta: &ManifestCase) -> Result<PathBuf, String> {
    let source = root.join(&meta.dir);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "adom-e2e-{}-{}-{nanos}",
        std::process::id(),
        meta.id
    ));
    let inputs = dir.join("inputs");
    fs::create_dir_all(&inputs).map_err(|err| format!("{}: {err}", inputs.display()))?;
    let request = serde_json::json!({
        "format": "adom-stream-e2e-frozen/1",
        "case": meta.id,
        "type": meta.kind,
        "stream_id": meta.stream_id,
        // O path do corpus é `{{config}}`; o replay usa CONFIG_SEGMENT.
        "encoded_len": CONFIG_SEGMENT.len(),
    });
    fs::write(
        dir.join("request.json"),
        format!(
            "{}\n",
            serde_json::to_string_pretty(&request).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|err| format!("{}: {err}", dir.join("request.json").display()))?;

    let entries = fs::read_dir(source.join("inputs"))
        .map_err(|err| format!("{}: {err}", source.join("inputs").display()))?;
    for entry in entries {
        let entry = entry.map_err(|err| err.to_string())?;
        if !entry.file_type().map_err(|err| err.to_string())?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let target = inputs.join(&name);
        fs::copy(entry.path(), &target).map_err(|err| format!("{}: {err}", target.display()))?;
    }
    Ok(dir)
}

/// Remonta UM caso e devolve o diff legível do gate (vazio = igual ao Node).
async fn replay_loaded(root: &Path, case: &LoadedCase) -> Result<(), String> {
    let body = expected_body(&case.meta, &case.response)?;
    let dir = materialize_case(root, &case.meta)?;
    let outcome =
        frozen_gate::run_case_with_expected(&dir, &body, E2E_ORIGIN, CONFIG_SEGMENT).await;
    let _ = fs::remove_dir_all(&dir);
    outcome.map_err(|diff| format!("{}\n{diff}", case.meta.id))
}

fn load_case(root: &Path, id: &str) -> (ManifestCase, Value) {
    let manifest: Manifest = serde_json::from_str(
        &fs::read_to_string(root.join("manifest.json")).expect("manifest legível"),
    )
    .expect("manifest JSON válido");
    let meta = manifest
        .cases
        .into_iter()
        .find(|case| case.id == id)
        .unwrap_or_else(|| panic!("caso {id} ausente do manifest"));
    let response: Value = serde_json::from_slice(
        &fs::read(root.join(&meta.dir).join("response.json")).expect("response.json legível"),
    )
    .expect("response.json JSON válido");
    (meta, response)
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

#[test]
fn contract_deserializa_round_trip_e_identidades_estaveis() {
    let (_root, _manifest, cases) = load_corpus();
    for case in &cases {
        let Some(body) = case.response.get("body") else {
            // HTML/proxy: só sanidade do envelope (já coberta no teste de carga).
            continue;
        };

        let parsed: StreamResponse = serde_json::from_value(body.clone()).unwrap_or_else(|e| {
            panic!(
                "StreamResponse não deserializa no caso {}: {e}",
                case.meta.id
            )
        });
        assert_eq!(
            parsed.cache_max_age, case.meta.cache_max_age,
            "cacheMaxAge corpo × manifest no caso {}",
            case.meta.id
        );
        assert_eq!(
            case.response["cacheMaxAge"].as_u64(),
            Some(u64::from(case.meta.cache_max_age)),
            "cacheMaxAge envelope × manifest no caso {}",
            case.meta.id
        );

        // Variante: ao menos uma ação por item (P2P / debrid / aviso).
        for (i, item) in parsed.streams.iter().enumerate() {
            let ok = item.url.is_some() || item.info_hash.is_some() || item.external_url.is_some();
            assert!(
                ok,
                "stream[{i}] sem url/infoHash/externalUrl no caso {}",
                case.meta.id
            );
        }

        // Campos internos `_*` não podem vazar no JSON capturado.
        if let Some(arr) = body["streams"].as_array() {
            for (i, item) in arr.iter().enumerate() {
                let Some(obj) = item.as_object() else {
                    continue;
                };
                for key in obj.keys() {
                    assert!(
                        !key.starts_with('_'),
                        "campo interno {key} no stream[{i}] do caso {}",
                        case.meta.id
                    );
                }
            }
        }

        // Round-trip do contrato (forma tipada, sem ordem de chaves do Node).
        let json = serde_json::to_string(&parsed).expect("serialize");
        let again: StreamResponse = serde_json::from_str(&json).expect("round-trip");
        assert_eq!(again, parsed, "round-trip no caso {}", case.meta.id);

        // Unicidade no JSON capturado (não é paridade Rust×Node).
        let set = stream_identity_set(&parsed.streams);
        assert_eq!(
            set.len(),
            parsed.streams.len(),
            "identidade duplicada na lista do caso {} (corpus capturado)",
            case.meta.id
        );
    }
}

/// PILOTO da Fase 1 (roda SEM `--ignored`): Cidade de Deus remontada pelo
/// `frozen_gate` a partir das fixtures internas tem que bater com o corpo que o
/// Node devolveu. Prova a costura e2e → `FrozenCase` sem exigir o corpus inteiro.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn piloto_cidade_de_deus_remonta_igual_ao_node() {
    let root = corpus_root();
    let (meta, response) = load_case(&root, PILOT_CASE);
    assert!(
        has_inputs(&root, &meta),
        "piloto sem fixtures internas ({}): recapture com --with-internal",
        root.join(&meta.dir).join("inputs").display()
    );
    let body = expected_body(&meta, &response).expect("body do piloto");
    let streams = body["streams"].as_array().map_or(0, Vec::len);
    let case = LoadedCase {
        meta,
        request: Value::Null,
        response,
    };
    if let Err(diff) = replay_loaded(&root, &case).await {
        panic!("[e2e] piloto {PILOT_CASE} divergiu:\n{diff}");
    }
    println!("[e2e] piloto {PILOT_CASE}: {streams} stream(s) — igual ao Node");
}

/// Corpus INTEIRO: exige as fixtures internas em todos os 51 casos. Fica
/// `#[ignore]` até o batch; quando rodar, falha listando o que falta e/ou o diff
/// de cada caso (nunca só o primeiro erro).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "corpus ainda só tem o piloto com inputs/ — o batch captura os 51"]
async fn build_stream_list_parity_completa() {
    let (root, _manifest, cases) = load_corpus();
    let total = cases.len();
    let mut missing = Vec::new();
    let mut failures = Vec::new();
    let mut passed = 0;
    for case in &cases {
        if !has_inputs(&root, &case.meta) {
            missing.push(case.meta.id.clone());
            println!("[e2e] {}: SKIP (sem inputs internos)", case.meta.id);
            continue;
        }
        match replay_loaded(&root, case).await {
            Ok(()) => {
                passed += 1;
                println!("[e2e] {}: PASS", case.meta.id);
            }
            Err(diff) => {
                let head = diff.lines().next().unwrap_or("(sem diff)");
                println!("[e2e] {}: FAIL {head}", case.meta.id);
                failures.push(diff);
            }
        }
    }
    println!(
        "[e2e] resumo: {passed}/{total} PASS; missing={}; failures={}",
        missing.len(),
        failures.len()
    );
    assert!(
        missing.is_empty(),
        "casos sem inputs internos ({} de {}): {}",
        missing.len(),
        cases.len(),
        missing.join(", ")
    );
    assert!(
        failures.is_empty(),
        "paridade e2e falhou em {} caso(s):\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}
