//! Testes do L2 da fila (`harvest:v1:q`).
//!
//! Movidos do `mod tests` inline do `store.rs` quando a fatia T1-A3 entrou: o
//! `store.rs` estava em 334 linhas e a quarentena o levaria ao teto de 400.

use std::path::Path;

use super::*;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::types::{HarvestEntry, HarvestMediaType, HarvestRequest};

fn clock_fixed() -> i64 {
    1_700_000_000_000
}

fn sample_entry(imdb: &str) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "miss".into(),
        enqueued_at: clock_fixed(),
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

/// Arquivo com bytes de lixo: o que uma queda no meio da escrita deixa.
fn arquivo_podre(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("cache.db");
    std::fs::write(&path, b"not a database").unwrap();
    path
}

#[test]
fn open_memory_save_load_roundtrip() {
    let store = HarvestStore::open_memory().unwrap();
    let entries = vec![sample_entry("tt0111161"), sample_entry("tt0068646")];
    store
        .save(&entries, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
        .unwrap();
    assert!(store.has_queue(clock_fixed()).unwrap());
    let loaded = store.load(clock_fixed()).unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].imdb_id, "tt0111161");
    assert_eq!(loaded[1].imdb_id, "tt0068646");
}

#[test]
fn save_vazio_apaga_chave() {
    let store = HarvestStore::open_memory().unwrap();
    store
        .save(&[sample_entry("tt0111161")], 60, clock_fixed())
        .unwrap();
    store.save(&[], 60, clock_fixed()).unwrap();
    assert!(!store.has_queue(clock_fixed()).unwrap());
    assert!(store.load(clock_fixed()).unwrap().is_empty());
}

#[test]
fn load_expirado_apaga_e_devolve_vazio() {
    let store = HarvestStore::open_memory().unwrap();
    store
        .save(&[sample_entry("tt0111161")], 60, clock_fixed())
        .unwrap();
    let past = clock_fixed() + 60_000 + 1;
    assert!(store.load(past).unwrap().is_empty());
    assert!(!store.has_queue(past).unwrap());
}

#[test]
fn load_filtra_imdb_invalido() {
    let store = HarvestStore::open_memory().unwrap();
    // JSON cru com entrada podre (como L2 legado).
    store
        .put_raw_for_test(
            r#"[{"imdbId":"nope","type":"movie","reason":"miss","enqueuedAt":1},{"imdbId":"tt0111161","type":"movie","reason":"miss","enqueuedAt":1}]"#,
            clock_fixed() + 60_000,
        )
        .unwrap();
    let loaded = store.load(clock_fixed()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].imdb_id, "tt0111161");
}

#[test]
fn fila_em_memoria_flush_periodico() {
    // enqueue/take_head mutam a memória; save/load espelham cache.set do TS.
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: 10,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    );
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0068646", "br-gap"));
    queue
        .save_to(&store, DEFAULT_ENTRY_TTL_SECONDS, clock_fixed())
        .unwrap();

    let mut other = HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: 10,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    );
    other.load_from(&store, clock_fixed(), None).unwrap();
    assert_eq!(other.depth(), 2);
    // Ingresso já prioriza: br-gap recente sobe; o save/load preserva a ordem.
    assert_eq!(other.take_head().expect("cabeça").imdb_id, "tt0068646");
    assert_eq!(other.preview(1)[0].imdb_id, "tt0111161");
}

#[test]
fn open_path_persiste_em_disco() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("harvest.db");
    {
        let store = HarvestStore::open(&path).unwrap();
        store
            .save(&[sample_entry("tt0111161")], 3600, clock_fixed())
            .unwrap();
    }
    let store = HarvestStore::open(&path).unwrap();
    let loaded = store.load(clock_fixed()).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].imdb_id, "tt0111161");
}

#[test]
fn abrir_banco_novo_nao_e_degradado() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("harvest.db");

    let store = HarvestStore::open(&path).unwrap();
    assert!(!store.degraded());
    assert!(store.degraded_error().is_none());
}

#[test]
fn open_com_arquivo_corrompido_quarentena_e_recria() {
    let dir = tempfile::tempdir().unwrap();
    let path = arquivo_podre(dir.path());

    let store = HarvestStore::open(&path).expect("recria após quarentena");
    assert!(store.degraded(), "o painel precisa saber do cache perdido");
    let err = store.degraded_error().expect("motivo registrado");
    assert!(err.contains("quick_check"), "motivo: {err}");
    assert!(err.contains("corrupt-"), "destino: {err}");
    assert!(path.exists(), "o arquivo NOVO está no caminho original");
    assert!(store.load(clock_fixed()).unwrap().is_empty());
    // O store recriado aceita escrita de novo (o boot continua).
    store
        .save(&[sample_entry("tt0111161")], 3600, clock_fixed())
        .unwrap();
    assert_eq!(store.load(clock_fixed()).unwrap().len(), 1);
}

#[test]
fn load_com_json_invalido_copia_para_chave_de_corrupcao() {
    let store = HarvestStore::open_memory().unwrap();
    let lixo = r#"[{"imdbId": "tt0111161", "#;
    store
        .put_raw_for_test(lixo, clock_fixed() + 600_000)
        .unwrap();

    // A fila vira vazia, mas nada foi apagado.
    assert!(store.load(clock_fixed()).unwrap().is_empty());

    let copia = store
        .get_value(CORRUPT_QUEUE_KEY, clock_fixed())
        .unwrap()
        .expect("valor cru copiado");
    assert_eq!(copia, lixo);
    let original = store
        .get_value(QUEUE_KEY, clock_fixed())
        .unwrap()
        .expect("original preservado");
    assert_eq!(original, lixo, "sem cópia não se apaga o original");
}

#[test]
fn chave_de_corrupcao_fica_ao_lado_da_fila() {
    assert_eq!(
        CORRUPT_QUEUE_KEY,
        format!("{QUEUE_KEY}:corrupt"),
        "a cópia não pode cair em outro namespace"
    );
}

#[test]
fn read_row_devolve_none_no_miss_e_propaga_erro_real() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    assert!(read_row(&conn, QUEUE_KEY).unwrap().is_none());

    // Esquema errado = erro de verdade, não "miss" silencioso.
    let outro = rusqlite::Connection::open_in_memory().unwrap();
    outro
        .execute_batch("CREATE TABLE outra (x INTEGER);")
        .unwrap();
    let err = read_row(&outro, QUEUE_KEY).expect_err("erro propagado");
    assert!(err.contains("ler"), "mensagem: {err}");
}
