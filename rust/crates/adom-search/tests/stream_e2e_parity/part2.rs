//! Parte 2 do harness de paridade do corpus `rust/golden/stream-e2e`.
//!
//! Corte mecânico do alvo `stream_e2e_parity`: os helpers de remontagem via
//! `frozen_gate` e os testes assíncronos. Nada muda de comportamento.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use adom_search::orchestrator::frozen_gate;
use adom_search::{StreamItem, StreamResponse};
use serde_json::Value;

use super::{corpus_root, load_corpus, LoadedCase, Manifest, ManifestCase, CONFIG_SEGMENT};

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

/// Corpus INTEIRO: exige as fixtures internas em todos os 51 casos. Roda na
/// suíte normal; falha listando o que falta e/ou o diff de cada caso (nunca só
/// o primeiro erro).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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
