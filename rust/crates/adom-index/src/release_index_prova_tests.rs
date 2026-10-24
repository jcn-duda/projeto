use super::*;
use crate::release_index::RecordOptions;
use rusqlite::params;
use serde_json::json;

const TTL_MS: i64 = 30 * 24 * 3600 * 1000;
const NOW: i64 = 1_700_000_000_000;
const H1: &str = "aa01000000000000000000000000000000000001";
const H2: &str = "bb02000000000000000000000000000000000002";

fn store() -> ReleaseIndexStore {
    ReleaseIndexStore::open_memory().expect("memória")
}

fn ep(season: i64, episode: i64) -> WorkTarget {
    WorkTarget {
        season: Some(season),
        episode: Some(episode),
    }
}

fn filme() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

fn item(titulo: &str, hash: &str) -> serde_json::Value {
    json!({ "title": titulo, "infoHash": hash, "isBr": true, "seeders": 4 })
}

fn grava(
    store: &ReleaseIndexStore,
    imdb: &str,
    location: WorkTarget,
    items: &[serde_json::Value],
    partial: bool,
    source: Option<&str>,
) {
    store
        .record(
            imdb,
            location,
            items,
            RecordOptions {
                partial,
                keep_partial: false,
                source,
                supplemental: false,
            },
            30 * 24 * 3600,
            60,
            NOW,
            None,
        )
        .expect("record");
}

/// Valor cru de uma chave, como o Node o grava.
fn cru(store: &ReleaseIndexStore, key: &str) -> String {
    store
        .lock()
        .query_row(
            "SELECT value FROM cache WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .expect("chave gravada")
}

#[test]
fn miss_por_episodio_so_vale_no_proprio_episodio_e_expira() {
    let s = store();
    assert!(s.mark_missing("tt1", ep(1, 2), H1, NOW).unwrap());
    assert!(
        !s.mark_missing("tt1", ep(1, 2), H1, NOW).unwrap(),
        "re-marcar renova mas não é evidência nova"
    );
    assert!(s.is_missing("tt1", ep(1, 2), H1, NOW));
    assert!(!s.is_missing("tt1", ep(1, 3), H1, NOW));
    assert!(
        !s.mark_missing(
            "tt1",
            WorkTarget {
                season: Some(1),
                episode: None
            },
            H1,
            NOW
        )
        .unwrap(),
        "sem episódio não há o que provar"
    );
    assert!(
        !s.is_missing("tt1", ep(1, 2), H1, NOW + TTL_MS + 1),
        "expirou"
    );
}

#[test]
fn miss_de_temporada_vale_para_todos_os_episodios_dela() {
    let s = store();
    assert!(s.mark_missing_season("tt1", 2, H1, NOW).unwrap());
    assert!(s.is_missing("tt1", ep(2, 1), H1, NOW));
    assert!(s.is_missing("tt1", ep(2, 9), H1, NOW));
    assert!(!s.is_missing("tt1", ep(3, 1), H1, NOW));
}

#[test]
fn file_evidence_grava_no_formato_do_node() {
    let s = store();
    let ev = FileEvidence {
        a: "por".into(),
        e: None,
        q: "1080p".into(),
        n: "Filme".into(),
    };
    assert!(s.mark_file_evidence(H1, &ev, NOW).unwrap());
    assert!(!s.mark_file_evidence(H1, &ev, NOW).unwrap());
    assert_eq!(s.file_evidence(H1, NOW), Some(ev));
    let raw = cru(&s, &format!("{}file:{H1}", idx_prefix()));
    assert!(
        !raw.contains("\"e\""),
        "episódio não provado não vai ao JSON: {raw}"
    );
}

#[test]
fn file_evidence_le_o_json_que_o_node_grava() {
    let s = store();
    s.lock()
        .execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            params![
                format!("{}file:{H2}", idx_prefix()),
                r#"{"a":"pt","e":1,"q":"720p","n":"x"}"#,
                NOW + TTL_MS
            ],
        )
        .unwrap();
    let lida = s.file_evidence(H2, NOW).expect("lida");
    assert_eq!(lida.e, Some(1));
    assert_eq!(lida.a, "pt");
}

#[test]
fn mark_lied_marca_so_o_hash_e_mantem_o_parcial() {
    let s = store();
    grava(
        &s,
        "tt1",
        ep(1, 1),
        &[item("Filme A 1080p DUBLADO", H1), item("Filme B 720p", H2)],
        true,
        None,
    );
    assert_eq!(s.mark_lied("tt1", ep(1, 1), H1, NOW).unwrap(), 1);
    let rel = s.lookup("tt1", ep(1, 1), NOW);
    assert!(rel.iter().find(|r| r.hash == H1).unwrap().lied);
    assert!(!rel.iter().find(|r| r.hash == H2).unwrap().lied);
    assert!(
        s.is_partial("tt1", ep(1, 1), NOW),
        "marcar lied não limpa o parcial"
    );
    assert_eq!(
        s.mark_lied("tt1", ep(1, 1), H1, NOW).unwrap(),
        0,
        "já marcado não conta"
    );
}

#[test]
fn clear_partial_limpa_so_a_obra_e_nao_toca_prefixo_parecido() {
    let s = store();
    grava(
        &s,
        "tt1",
        ep(1, 1),
        &[item("Filme A 1080p DUBLADO", H1)],
        true,
        None,
    );
    grava(
        &s,
        "tt12",
        filme(),
        &[item("Filme C 1080p DUBLADO", H2)],
        true,
        None,
    );
    assert_eq!(s.clear_partial("tt1", NOW).unwrap(), 1);
    assert!(!s.is_partial("tt1", ep(1, 1), NOW));
    assert!(s.is_partial("tt12", filme(), NOW), "tt12 não é tt1");
    assert_eq!(s.lookup("tt1", ep(1, 1), NOW).len(), 1, "as releases ficam");
}

#[test]
fn forget_autofetch_remove_so_a_submissao_do_autofetch() {
    let s = store();
    grava(
        &s,
        "tt1",
        ep(1, 1),
        &[item("Filme A 1080p", H1), item("Filme B 720p", H2)],
        false,
        Some("autofetch"),
    );
    assert_eq!(s.forget_autofetch_hash("tt1", H1, NOW).unwrap(), 1);
    let rel = s.lookup("tt1", ep(1, 1), NOW);
    assert!(rel.iter().all(|r| r.hash != H1));
    assert!(rel.iter().any(|r| r.hash == H2));
}

#[test]
fn forget_autofetch_preserva_observacao_publica_do_mesmo_hash() {
    let s = store();
    grava(
        &s,
        "tt2",
        ep(1, 1),
        &[item("Filme D 1080p", H1)],
        false,
        Some("autofetch"),
    );
    grava(
        &s,
        "tt2",
        ep(1, 1),
        &[item("Filme D 1080p", H1)],
        false,
        None,
    );
    assert_eq!(s.forget_autofetch_hash("tt2", H1, NOW).unwrap(), 0);
    assert!(s.lookup("tt2", ep(1, 1), NOW).iter().any(|r| r.hash == H1));
}

#[test]
fn snapshot_agrega_so_as_obras_pedidas_e_ignora_miss_e_file() {
    let s = store();
    grava(
        &s,
        "tt1",
        ep(1, 1),
        &[item("Filme A 1080p DUBLADO", H1)],
        false,
        None,
    );
    grava(
        &s,
        "tt1",
        WorkTarget {
            season: Some(1),
            episode: None,
        },
        &[item("Serie X 720p", H2)],
        false,
        None,
    );
    grava(
        &s,
        "tt2",
        filme(),
        &[item("Filme B 1080p", H2)],
        false,
        None,
    );
    s.mark_missing("tt1", ep(1, 1), H2, NOW).unwrap();
    s.mark_file_evidence(
        H1,
        &FileEvidence {
            a: "por".into(),
            e: None,
            q: "1080p".into(),
            n: "x".into(),
        },
        NOW,
    )
    .unwrap();

    let um = s.snapshot_works(&["tt1".to_string()], NOW).unwrap();
    assert_eq!(um.len(), 1);
    assert_eq!(
        um["tt1"].len(),
        2,
        "episódio e temporada, dedupados por hash"
    );

    let tudo = s.snapshot_all_works(NOW).unwrap();
    assert_eq!(tudo.len(), 2, "só tt1 e tt2: miss e file não são obra");
}

#[test]
fn snapshot_nao_devolve_linha_expirada() {
    let s = store();
    grava(
        &s,
        "tt1",
        ep(1, 1),
        &[item("Filme A 1080p", H1)],
        false,
        None,
    );
    assert!(s.snapshot_all_works(NOW + TTL_MS + 1).unwrap().is_empty());
}
