use super::*;
use serde_json::{json, Value};

const TTL: u64 = 30 * 24 * 3600;
const NOW: i64 = 1_700_000_000_000;

fn store() -> ReleaseIndexStore {
    ReleaseIndexStore::open_memory().expect("memória")
}

fn record(
    store: &ReleaseIndexStore,
    imdb: &str,
    location: WorkTarget,
    items: &[Value],
    partial: bool,
    now: i64,
) -> usize {
    store
        .record(
            imdb,
            location,
            items,
            RecordOptions {
                partial,
                keep_partial: false,
                source: None,
                supplemental: false,
            },
            TTL,
            60,
            now,
            None,
        )
        .expect("record")
}

fn movie() -> WorkTarget {
    WorkTarget {
        season: None,
        episode: None,
    }
}

#[test]
fn grava_e_le_no_formato_do_node() {
    let store = store();
    let items = vec![json!({
        "title": "Filme 2024 1080p BluRay Dublado",
        "infoHash": "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        "seeders": 42,
        "size": 123456,
        "indexer": "bludv",
        "tracker": "BluDV",
        "isBr": true,
        "dubbed": true,
        "lied": false,
    })];
    let added = record(&store, "tt1234567", movie(), &items, false, NOW);
    assert_eq!(added, 1);
    let out = store.lookup("tt1234567", movie(), NOW);
    assert_eq!(out.len(), 1);
    let release = &out[0];
    assert_eq!(release.hash, "abcdef0123456789abcdef0123456789abcdef01");
    assert_eq!(release.title, "Filme 2024 1080p BluRay Dublado");
    assert_eq!(release.size, Some(123456));
    assert_eq!(release.indexer, "bludv");
    assert_eq!(release.tracker.as_deref(), Some("BluDV"));
    assert!(release.is_br);
    assert!(release.dubbed);
    assert_eq!(release.quality, "1080p");
    assert_eq!(release.seeders, 42);
    assert_eq!(release.seen_at, NOW);
    assert!(!release.lied);
    assert_eq!(release.source, None);
}

#[test]
fn json_da_chave_e_o_do_cache_do_node() {
    let store = store();
    let items = vec![json!({
        "title": "Filme 2024 1080p",
        "infoHash": "abcdef0123456789abcdef0123456789abcdef01",
    })];
    record(&store, "tt1234567", movie(), &items, false, NOW);
    let entry = store
        .read_entry("idx:v14:tt1234567", NOW)
        .expect("entrada gravada");
    assert_eq!(entry.at, NOW);
    assert!(!entry.partial);
    assert_eq!(entry.releases.len(), 1);
    let raw = serde_json::to_value(&entry).expect("json");
    // Campo a campo do `release-index-types.ts` (undefined = ausente).
    let release = &raw["releases"][0];
    assert_eq!(
        release["hash"],
        json!("abcdef0123456789abcdef0123456789abcdef01")
    );
    assert_eq!(release["title"], json!("Filme 2024 1080p"));
    assert_eq!(release["size"], Value::Null);
    assert_eq!(release["indexer"], json!(""));
    assert!(
        release.get("tracker").is_none(),
        "undefined não é serializado"
    );
    assert_eq!(release["isBr"], json!(false));
    assert_eq!(release["dubbed"], json!(false));
    assert_eq!(release["quality"], json!("1080p"));
    assert_eq!(release["seenAt"], json!(NOW));
    assert_eq!(release["lied"], json!(false));
    assert!(release.get("source").is_none());
    assert!(release.get("mediaSource").is_none());
}

#[test]
fn le_entrada_gravada_pelo_node() {
    let store = store();
    // Valor literal no formato do Node (um teste de contrato, não de round-trip).
    let node_json = r#"{"at":1700000000000,"partial":false,"releases":[{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","title":"Obscuro 2024 1080p WEB-DL Dublado","size":900000000,"indexer":"nerdfilmes","tracker":"NerdFilmes","isBr":true,"dubbed":true,"quality":"1080p","seeders":1,"seenAt":1700000000000,"lied":false,"mediaSource":"WEB-DL"}]}"#;
    store
        .write_entry(
            "idx:v14:tt7654321",
            &serde_json::from_str(node_json).unwrap(),
            TTL,
            NOW,
        )
        .expect("grava fixture");
    let out = store.lookup("tt7654321", movie(), NOW);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].indexer, "nerdfilmes");
    assert_eq!(out[0].media_source.as_deref(), Some("WEB-DL"));
    assert!(out[0].is_br && out[0].dubbed);
}

#[test]
fn reabre_do_disco() {
    let dir = tempfile::tempdir().expect("tmp");
    let path = dir.path().join("cache.db");
    {
        let store = ReleaseIndexStore::open(&path).expect("abre");
        let items = vec![json!({
            "title": "Filme 2024 1080p",
            "infoHash": "abcdef0123456789abcdef0123456789abcdef01",
        })];
        record(&store, "tt1111111", movie(), &items, false, NOW);
    }
    let reopened = ReleaseIndexStore::open(&path).expect("reabre");
    let out = reopened.lookup("tt1111111", movie(), NOW + 1_000);
    assert_eq!(out.len(), 1, "restart não perde o índice");
    assert_eq!(out[0].title, "Filme 2024 1080p");
}

#[test]
fn episodio_temporada_e_raiz_se_agregam() {
    let store = store();
    let ep = json!({"title": "Serie S02E05 1080p", "infoHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"});
    let pack = json!({"title": "Serie 2ª Temporada 1080p", "infoHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"});
    let root = json!({"title": "Serie Completa 1080p", "infoHash": "cccccccccccccccccccccccccccccccccccccccc"});
    record(
        &store,
        "tt2222222",
        WorkTarget {
            season: Some(2),
            episode: Some(5),
        },
        std::slice::from_ref(&ep),
        false,
        NOW,
    );
    record(
        &store,
        "tt2222222",
        WorkTarget {
            season: Some(2),
            episode: Some(5),
        },
        std::slice::from_ref(&pack),
        false,
        NOW,
    );
    record(
        &store,
        "tt2222222",
        WorkTarget {
            season: Some(2),
            episode: Some(5),
        },
        std::slice::from_ref(&root),
        false,
        NOW,
    );
    assert!(store.read_entry("idx:v14:tt2222222:S2E5", NOW).is_some());
    assert!(store.read_entry("idx:v14:tt2222222:S2", NOW).is_some());
    assert!(store.read_entry("idx:v14:tt2222222", NOW).is_some());
    let out = store.lookup(
        "tt2222222",
        WorkTarget {
            season: Some(2),
            episode: Some(5),
        },
        NOW,
    );
    assert_eq!(out.len(), 3, "episódio + pack + raiz");
}

#[test]
fn roteia_pelo_dn_mais_especifico() {
    let store = store();
    // Post de "4ª Temporada" com dn do E03: a release pertence ao E03.
    let item = json!({
        "title": "Serie 4ª Temporada 1080p",
        "magnet": "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd&dn=Serie.S04E03.1080p",
    });
    record(
        &store,
        "tt3333333",
        WorkTarget {
            season: Some(4),
            episode: Some(1),
        },
        &[item],
        false,
        NOW,
    );
    assert!(
        store.read_entry("idx:v14:tt3333333:S4E3", NOW).is_some(),
        "dn vence o título e roteia para o E03"
    );
    assert!(store.read_entry("idx:v14:tt3333333:S4E1", NOW).is_none());
}

#[test]
fn merge_por_hash_or_aderente_e_mais_recente_vence() {
    let store = store();
    let first = json!({
        "title": "Filme 2024 720p",
        "infoHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "seeders": 10,
        "isBr": true,
        "dubbed": false,
        "lied": false,
    });
    record(&store, "tt4444444", movie(), &[first], false, NOW);
    let second = json!({
        "title": "Filme 2024 1080p Legendado",
        "infoHash": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "seeders": 3,
    });
    record(&store, "tt4444444", movie(), &[second], false, NOW + 1_000);
    let out = store.lookup("tt4444444", movie(), NOW + 1_000);
    assert_eq!(out.len(), 1);
    // Título/seeders do mais recente; marcas OR (isBr/dubbed não caem) e
    // seeders pelo MÁXIMO (snapshot pior não rebaixa).
    assert_eq!(out[0].title, "Filme 2024 1080p Legendado");
    assert_eq!(out[0].seeders, 10);
    assert!(out[0].is_br, "isBr OR-aderente");
    assert!(!out[0].dubbed, "a primeira gravação não era dublada");
}

#[test]
fn autofetch_promove_ao_rever_e_observacao_publica_limpa_a_fonte() {
    let store = store();
    let autofetch_item = json!({
        "title": "Filme 2024 1080p",
        "infoHash": "ffffffffffffffffffffffffffffffffffffffff",
        "seeders": 1,
    });
    store
        .record(
            "tt5555555",
            movie(),
            &[autofetch_item],
            RecordOptions {
                partial: false,
                keep_partial: false,
                source: Some("autofetch"),
                supplemental: false,
            },
            TTL,
            60,
            NOW,
            None,
        )
        .expect("record autofetch");
    assert_eq!(
        store.lookup("tt5555555", movie(), NOW)[0].source.as_deref(),
        Some("autofetch")
    );
    let observed = json!({
        "title": "Filme 2024 1080p",
        "infoHash": "ffffffffffffffffffffffffffffffffffffffff",
        "seeders": 7,
    });
    store
        .record(
            "tt5555555",
            movie(),
            &[observed],
            RecordOptions {
                partial: false,
                keep_partial: false,
                source: None,
                supplemental: false,
            },
            TTL,
            60,
            NOW,
            None,
        )
        .expect("record observado");
    let out = store.lookup("tt5555555", movie(), NOW);
    assert_eq!(out[0].source, None, "observação pública promove o registro");
    assert_eq!(out[0].seeders, 7);
}

#[path = "release_index_tests_part2.rs"]
mod part2;

// Cota por faixa de prefixo: semântica, plano e a medição antes/depois.
#[path = "release_index_quota_tests.rs"]
mod quota;
