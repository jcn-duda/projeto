//! Testes do gate congelado (comparador, anotacoes e captura).

use super::annotate::{applied_debrid_verdicts, pre_debrid_hashes, retain_item_hashes};
use super::annotate_sources::applied_media_sources;
use super::audio::applied_audio_proofs;
use super::capture::ApplyDebridFile;
use super::compare::mask_text;
use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

#[test]
fn pre_debrid_hashes_le_a_chave_da_primeira_chamada() {
    let files = vec![ApplyDebridFile {
        key: "alldebrid|0|AA, bb ,,cc".into(),
        output: Vec::new(),
    }];
    let allowed = pre_debrid_hashes(&files).expect("chave válida");
    assert!(allowed.contains("aa"));
    assert!(allowed.contains("bb"));
    assert!(allowed.contains("cc"));
    assert_eq!(allowed.len(), 3);
    // Sem chave (captura antiga): não filtra.
    assert!(pre_debrid_hashes(&[ApplyDebridFile::default()]).is_none());
}

#[test]
fn retain_item_hashes_remove_o_que_o_node_nao_passou_ao_debrid() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let mut items = vec![
        json!({"infoHash": a.clone()}),
        json!({"infoHash": b.clone()}),
        json!({"url": format!("/e30/resolve/{c}?sig=x")}),
    ];
    let allowed: BTreeSet<String> = [a.clone(), c.clone()].into_iter().collect();
    retain_item_hashes(&mut items, &allowed);
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["infoHash"], a);
    assert_eq!(items[1]["url"], format!("/e30/resolve/{c}?sig=x"));
}

#[test]
fn audio_proof_usa_so_a_primeira_passada() {
    // Primeira passada: sem `_dubbed` → sem prova (o Node não rotulava DUAL).
    // Segunda (tardio): `_dubbed:true` + chip DUAL → NÃO pode vazar.
    let files = vec![
        ApplyDebridFile {
            key: "svc|0|abde".into(),
            output: vec![json!({
                "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
                "name": "📦 · 720p BluRay BR · Bludv",
                "_dubbed": false
            })],
        },
        ApplyDebridFile {
            key: String::new(),
            output: vec![json!({
                "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
                "name": "📦 · 720p BluRay DUAL BR · Bludv",
                "_dubbed": true
            })],
        },
    ];
    let proofs = applied_audio_proofs(&files, &BTreeMap::new());
    assert!(
        proofs.is_empty(),
        "prova da passada tardia vazou: {proofs:?}"
    );

    // E a primeira passada com prova positiva continua valendo.
    let files = vec![ApplyDebridFile {
        key: "svc|0|abde".into(),
        output: vec![json!({
            "url": "/e30/resolve/abde0d9e255eae8ac5758ec9203f91ef612801fa",
            "name": "📦 · 720p BluRay DUB BR · Bludv",
            "_dubbed": true
        })],
    }];
    let proofs = applied_audio_proofs(&files, &BTreeMap::new());
    assert_eq!(
        proofs
            .get("abde0d9e255eae8ac5758ec9203f91ef612801fa")
            .map(|proof| proof.audio.as_str()),
        Some("Dublado")
    );
}

/// Cópia recursiva sem dependência nova (`tempfile` não é dev-dep aqui).
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn temp_case() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("adom-frozen-shadow-{}-{nanos}", std::process::id()))
}

fn read_value(path: &Path) -> Value {
    let bytes = fs::read(path).expect("ler json");
    serde_json::from_slice(&bytes).expect("json válido")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn caso_copiado_bate_e_stream_alterado_falha() {
    let source = corpus_root().join("movie-cidade-de-deus");
    let dir = temp_case();
    copy_tree(&source, &dir).expect("copiar caso");
    let body = read_value(&dir.join("expected/node-response.json"));

    // 1) o próprio corpo do Node, com a máscara do gate, compara igual.
    run_case_with_expected(&dir, &body, FROZEN_ORIGIN, "e30")
        .await
        .expect("caso copiado deve bater com o corpo do Node");

    // 2) `cacheMaxAge`/`stale*` fora do comparador da sombra.
    let mut envelope = body.clone();
    envelope["cacheMaxAge"] = json!(0);
    envelope["staleRevalidate"] = json!(true);
    envelope["staleError"] = json!(86400);
    run_case_with_expected(&dir, &envelope, FROZEN_ORIGIN, "e30")
        .await
        .expect("envelope fora de streams não pode divergir");

    // 3) stream alterado: diff com UMA linha `#` (o que a métrica conta).
    let mut alterado = body.clone();
    alterado["streams"][0]["name"] = json!("[alterado]");
    let diff = run_case_with_expected(&dir, &alterado, FROZEN_ORIGIN, "e30")
        .await
        .expect_err("stream alterado tem que divergir");
    assert!(
        diff.starts_with("streams divergentes"),
        "diff inesperado: {diff}"
    );
    assert_eq!(
        diff.lines().filter(|line| line.starts_with('#')).count(),
        1,
        "diff: {diff}"
    );

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn mascara_o_segmento_global_como_o_node() {
    // O hash pode conter o próprio segmento (`e30`); o record do Node
    // mascara por `split(encoded).join`, então o lado Rust precisa fazer o
    // mesmo ou o comparador acusa divergência de item idêntico.
    let hash = "90d3277aa33f639c3533a6d7015e3002c892e2d5";
    let masked = mask_text(hash, "", "e30");
    assert_eq!(masked, "90d3277aa33f639c3533a6d7015{{config}}02c892e2d5");
    // URL com o segmento no path continua mascarada uma vez só.
    let url = "http://x/e30/resolve/90d3277aa33f639c3533a6d7015e3002c892e2d5?sig=abc";
    assert_eq!(
        mask_text(url, "http://x", "e30"),
        "{{base}}/{{config}}/resolve/90d3277aa33f639c3533a6d7015{{config}}02c892e2d5?sig={{sig}}"
    );
    // Idempotência: o expected já vem mascarado.
    assert_eq!(
        mask_text(&masked, "", "e30"),
        "90d3277aa33f639c3533a6d7015{{config}}02c892e2d5"
    );
}

#[test]
fn p2p_da_passada_nao_marca_o_lote_todo_como_unusable() {
    // Um hash sem prefixo no `apply-debrid` é P2P, mas os `[AD⚡]` do mesmo
    // lote continuam resolvidos — marcar `unusable` derrubava todos.
    let cached = "a".repeat(40);
    let p2p = "b".repeat(40);
    let files = vec![ApplyDebridFile {
        key: String::new(),
        output: vec![
            json!({"url": format!("/e30/resolve/{cached}?sig=x"), "name": "[AD⚡] 4K · AllDebrid · 👤 1"}),
            json!({"infoHash": p2p, "name": "1080p · The Pirate Bay · 👤 2"}),
        ],
    }];
    let verdicts = applied_debrid_verdicts(&files);
    assert!(verdicts.get(&cached).is_some_and(|v| v.cached));
    let p2p_verdict = verdicts.get(&p2p).expect("hash P2P");
    assert!(!p2p_verdict.known, "{p2p_verdict:?}");
    assert_eq!(
        p2p_verdict.unusable.as_ref().and_then(Value::as_str),
        Some("p2p"),
        "{p2p_verdict:?}"
    );
    assert!(!p2p_verdict.cached, "{p2p_verdict:?}");
}

#[test]
fn media_source_da_primeira_passada_any_nao_e_emprestada() {
    let hash = "a".repeat(40);
    let files = vec![
        ApplyDebridFile {
            key: String::new(),
            output: vec![json!({
                "infoHash": hash,
                "behaviorHints": {"bingeGroup": "powerm-720p-any"},
            })],
        },
        ApplyDebridFile {
            key: String::new(),
            output: vec![json!({
                "url": format!("/e30/resolve/{hash}?sig=x"),
                "behaviorHints": {"bingeGroup": "powerm-720p-BluRay"},
            })],
        },
    ];
    let sources = applied_media_sources(&files);
    assert!(
        !sources.contains_key(&hash),
        "o `any` da primeira passada é a fonte real (ausente): {sources:?}"
    );
    // Sem o primeiro passe, a segunda fonte vale.
    let only_second = applied_media_sources(&files[1..]);
    assert_eq!(only_second.get(&hash).map(String::as_str), Some("BluRay"));
}
