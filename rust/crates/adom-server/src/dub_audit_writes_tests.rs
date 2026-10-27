//! Paridade das escritas do veredito (T3-L7a) sobre o SQLite de verdade —
//! o que o teste TS `runDubAudit: mentira do tail destrava adprot` provava.

use super::*;
use adom_index::NativeKv;
use serde_json::json;

fn temp_path() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    (dir, path)
}

#[test]
fn mentira_grava_lie_e_destrava_o_adprot() {
    let (_dir, path) = temp_path();
    let now = now_ms();
    let api_key = "chave-nativa";
    let hash = "ab".repeat(20);
    let account = account_scope(&Value::String(api_key.to_string()));
    let key = format!("adprot:v1:alldebrid:{account}:{hash}");
    NativeKv::open(&path)
        .unwrap()
        .put_json(&key, &json!({ "at": now }), 0, now)
        .unwrap();

    let writes = NativeWrites::open(&path, None);
    assert!(!writes.is_lie("alldebrid", api_key, &hash));
    writes.mark_lie("alldebrid", api_key, &hash, now);
    assert!(writes.is_lie("alldebrid", api_key, &hash));
    // O veredito é por conta: outra chave não herda a mentira.
    assert!(!writes.is_lie("alldebrid", "outra-chave", &hash));

    writes.unprotect("alldebrid", api_key, &hash);
    assert_eq!(
        NativeKv::open(&path)
            .unwrap()
            .remaining_seconds(&key, now)
            .unwrap(),
        None,
        "adprot destravado"
    );
}

#[test]
fn episodio_errado_grava_a_prova_por_episodio_e_da_temporada() {
    let (_dir, path) = temp_path();
    let now = now_ms();
    let writes = NativeWrites::open(&path, None);
    let hash = "ab".repeat(20);

    writes.mark_missing("tt123", 1, 4, &hash, false, now);
    assert!(writes.is_missing("tt123", Some(1), Some(4), &hash, now));
    assert!(
        !writes.is_missing("tt123", Some(1), Some(5), &hash, now),
        "o mesmo hash continua candidato para outro episódio"
    );

    // Arquivo sem episódio declarado no nome: invalida a temporada inteira.
    let other = "cd".repeat(20);
    writes.mark_missing("tt123", 2, 1, &other, true, now);
    let index = ReleaseIndexStore::open(&path).unwrap();
    assert!(index.is_missing(
        "tt123",
        WorkTarget {
            season: Some(2),
            episode: None,
        },
        &other,
        now
    ));
}
