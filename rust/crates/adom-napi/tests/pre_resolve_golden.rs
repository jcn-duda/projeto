//! Paridade do golden `pre-resolve` (G4) — as duas regras que vivem no crate
//! `adom-napi` (`pre_resolve.rs`): o score de escolha do candidato
//! (`resolveCandidateScore`) e a regex de temporada do título do laço do
//! protetor BR.
//!
//! O `expected` de cada linha é a saída do **TypeScript do branch `esm`**
//! (`pre-resolve-oracle.mjs`), gerado fora deste branch: aqui só se compara o
//! Rust contra o arquivo commitado, nunca input contra input.
//!
//! Cobertura por operação do corpus (`golden-kit` válida o corpus na geração):
//! `score` → `resolve_candidate_score_napi` (a ponte pública do score);
//! `rank` → `pre_resolve_br_napi` com o lote inteiro, comparando a ORDEM dos
//! aprovados (a do TS: score desc, ordem original no empate); `season` →
//! `pre_resolve_br_napi` com `requested_season`, onde `keep` é o veredito e a
//! sonda 1..=6 prende o MARCADOR exato (keep só na temporada declarada no
//! título).
//!
//! A regex é privada do módulo; a sonda por `requested_season` a exercita pelo
//! caminho real (o mesmo que o rust.yml chama), sem abrir API só para teste.

use adom_napi::{
    pre_resolve_br_napi, resolve_candidate_score_napi, PreResolvePost, PreResolveQuery,
    PreResolveSettings, REJECT_SEASON,
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const JSONL: &str = include_str!("../../../golden/pre-resolve.jsonl");
const MANIFEST: &str = include_str!("../../../golden/pre-resolve.manifest.json");
const CORPUS: &str = include_str!("../../../../scripts/golden/corpus-pre-resolve.json");
const CASES: usize = 22;
const REGISTRY: &str = "pre-resolve/preResolve";

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

struct Case {
    id: String,
    input: String,
    expected: String,
}

fn cases() -> Vec<Case> {
    JSONL
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|line| {
            let v: Value = serde_json::from_str(line).expect("linha do golden é JSON");
            Case {
                id: v["id"].as_str().expect("id").to_string(),
                input: v["input"].as_str().expect("input").to_string(),
                expected: v["expected"].as_str().expect("expected").to_string(),
            }
        })
        .collect()
}

fn settings() -> PreResolveSettings {
    PreResolveSettings {
        now_ms: 1_760_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 48 * 3600 * 1000,
        title_precision_tail_cut: true,
    }
}

/// Query sem filtro de título: o corpus mede SÓ score e temporada. Com `wanted`
/// e `names` vazios a etapa 1 do lote é pulada, como o oráculo pressupõe.
fn query() -> PreResolveQuery {
    PreResolveQuery {
        names: Vec::new(),
        wanted: None,
        year: None,
        query_year: None,
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
        br_is_series: false,
        requested_season: None,
        requested_ep_season: None,
        requested_ep: None,
        max_resolves: 20,
        allow_private_urls: false,
    }
}

/// URL única por post: senão o dedupe por `downloadUrl` come o caso.
fn post(title: &str, n: usize) -> PreResolvePost {
    PreResolvePost {
        title: Some(title.to_string()),
        title_pascal: None,
        magnet: None,
        magnet_uri: None,
        guid: None,
        is_br: false,
        info_hash: None,
        download_url: Some(format!("https://tracker.example/file{n}.torrent")),
        link_trusted: false,
    }
}

fn req(case: &Case) -> Value {
    serde_json::from_str(&case.input).expect("input do caso é JSON")
}

fn opt_i64(v: &Value) -> Option<i64> {
    v.as_i64()
}

#[test]
fn manifest_registro_formato_e_contagem_batem() {
    let m: Value = serde_json::from_str(MANIFEST).expect("manifest é JSON");
    assert_eq!(m["format"], "adom-golden-manifest/1");
    assert_eq!(m["registry"], serde_json::json!([REGISTRY]));
    assert_eq!(m["function"]["name"], "preResolve");
    assert_eq!(
        m["function"]["sourcePath"],
        "src/providers/jackett-resolve.ts"
    );
    assert_eq!(
        m["function"]["artifactPath"],
        "dist/src/providers/jackett-resolve.js"
    );
    assert_eq!(m["output"]["path"], "rust/golden/pre-resolve.jsonl");
    assert_eq!(
        m["corpus"]["path"],
        "scripts/golden/corpus-pre-resolve.json"
    );
    assert_eq!(m["output"]["lines"], CASES);
    assert_eq!(m["corpus"]["cases"], CASES);
    assert_eq!(cases().len(), CASES);
}

#[test]
fn hashes_sha256_batem_com_o_manifest() {
    let m: Value = serde_json::from_str(MANIFEST).expect("manifest é JSON");
    assert_eq!(sha256_hex(JSONL.as_bytes()), m["output"]["sha256"]);
    assert_eq!(sha256_hex(CORPUS.as_bytes()), m["corpus"]["sha256"]);
}

#[test]
fn ids_unicos_e_corpus_concorda_com_o_golden() {
    let cases = cases();
    let mut ids = std::collections::HashSet::new();
    for c in &cases {
        assert!(ids.insert(c.id.clone()), "id duplicado: {}", c.id);
    }
    let corpus: Value = serde_json::from_str(CORPUS).expect("corpus é JSON");
    let list = corpus["cases"].as_array().expect("corpus tem cases");
    assert_eq!(list.len(), cases.len());
    for (i, c) in list.iter().enumerate() {
        assert_eq!(c["id"].as_str().expect("id do corpus"), cases[i].id);
        assert_eq!(
            c["input"].as_str().expect("input do corpus"),
            cases[i].input
        );
    }
}

#[test]
fn score_bate_com_o_oraculo_caso_a_caso() {
    let mut vistos = 0;
    for case in cases() {
        let r = req(&case);
        if r["op"] != "score" {
            continue;
        }
        let title = r["title"].as_str().unwrap_or("");
        let got = resolve_candidate_score_napi(
            title.to_string(),
            opt_i64(&r["season"]),
            opt_i64(&r["episode"]),
        );
        let want: Value = serde_json::from_str(&case.expected).expect("expected do score é JSON");
        assert_eq!(Value::from(got), want, "caso {} (score)", case.id);
        vistos += 1;
    }
    assert!(vistos >= 10, "o golden precisa cobrir o score ({vistos})");
}

#[test]
fn rank_bate_com_a_ordem_do_ts() {
    let mut vistos = 0;
    for case in cases() {
        let r = req(&case);
        if r["op"] != "rank" {
            continue;
        }
        let titles: Vec<String> = r["titles"]
            .as_array()
            .expect("títulos do rank")
            .iter()
            .map(|t| t.as_str().expect("título").to_string())
            .collect();
        let posts: Vec<PreResolvePost> =
            titles.iter().enumerate().map(|(i, t)| post(t, i)).collect();
        let mut q = query();
        q.max_resolves = titles.len() as i64;
        let out = pre_resolve_br_napi(posts, q, settings());
        assert!(out.rejected.is_empty(), "caso {}: nada é cortado", case.id);
        let got: Vec<u64> = out.approved.iter().map(|i| u64::from(*i)).collect();
        let want: Value = serde_json::from_str(&case.expected).expect("expected do rank é JSON");
        let want: Vec<u64> = want
            .as_array()
            .expect("expected do rank é lista")
            .iter()
            .map(|v| v.as_u64().expect("índice"))
            .collect();
        assert_eq!(got, want, "caso {} (ordem do lote)", case.id);
        vistos += 1;
    }
    assert!(vistos >= 2, "o golden precisa cobrir a ordem ({vistos})");
}

#[test]
fn season_bate_com_o_marcador_do_ts() {
    let mut vistos = 0;
    for case in cases() {
        let r = req(&case);
        if r["op"] != "season" {
            continue;
        }
        let title = r["title"].as_str().unwrap_or("");
        let requested = opt_i64(&r["requested"]).expect("requested");
        let want: Value =
            serde_json::from_str(&case.expected).expect("expected da temporada é JSON");
        let want_keep = want["keep"].as_bool().expect("keep");
        let want_marker = opt_i64(&want["marker"]);

        let kept = |season: i64| -> bool {
            let mut q = query();
            q.requested_season = Some(season);
            let out = pre_resolve_br_napi(vec![post(title, 0)], q, settings());
            if !out.approved.is_empty() {
                return true;
            }
            assert!(
                out.rejected
                    .iter()
                    .any(|rej| rej.index == 0 && rej.reason == REJECT_SEASON),
                "caso {}: rejeição que não é de temporada",
                case.id
            );
            false
        };

        assert_eq!(kept(requested), want_keep, "caso {}: keep pedido", case.id);
        // A sonda prende o MARCADOR: keep só na temporada que o título declara
        // (ou em todas, quando o título não declara nenhuma).
        for probe in 1..=6 {
            let esperado = want_marker.is_none_or(|m| m == probe);
            assert_eq!(kept(probe), esperado, "caso {}: sonda S{probe}", case.id);
        }
        vistos += 1;
    }
    assert!(
        vistos >= 8,
        "o golden precisa cobrir a temporada ({vistos})"
    );
}
