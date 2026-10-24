//! Segunda metade dos testes do meta store (formato antigo, expiração, valor
//! corrompido e cota do namespace); separada para a fonte caber na catraca de
//! 400 linhas. Reusa os helpers e os imports de super::tests.

use super::*;

#[test]
fn entrada_em_formato_antigo_e_reconsultada() {
    let store = MetaCacheStore::open_memory().expect("memória");
    // Cinemeta sem `__metaV`: o próprio Node reconsulta uma vez.
    store
        .write_value(
            "meta:series:tt1",
            &json!({ "name": "Velha", "year": "2010", "type": "series" }),
            600,
            NOW,
        )
        .expect("grava");
    assert_eq!(store.get("meta:series:tt1", NOW), None);
    // Títulos sem `en`/`br` (formato anterior): MISS.
    store
        .write_value(
            "tmdb:tt1",
            &json!({ "pt": "Antigo", "original": "Antigo", "year": "2010" }),
            600,
            NOW,
        )
        .expect("grava");
    assert_eq!(store.get("tmdb:tt1", NOW), None);
    // Campo legado `aliases` também invalida.
    store
        .write_value(
            "tmdb:tt2",
            &json!({
                "pt": "Antigo", "original": "Antigo", "en": "Old",
                "br": [], "year": "2010", "aliases": ["x"]
            }),
            600,
            NOW,
        )
        .expect("grava");
    assert_eq!(store.get("tmdb:tt2", NOW), None);
}

#[test]
fn expirado_some_na_leitura_e_nao_volta_apos_restart() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("cache.db");
    let store = MetaCacheStore::open(&path).expect("abre");
    store.set(
        "tmdbh:tt1",
        CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(7),
            ok: true,
        }),
        60,
        NOW,
    );
    let depois = NOW + 60_000;
    assert_eq!(store.get("tmdbh:tt1", depois), None);
    drop(store);
    let reaberto = MetaCacheStore::open(&path).expect("reabre");
    assert_eq!(reaberto.get("tmdbh:tt1", depois), None);
    // O vencido foi apagado na leitura, não só ignorado.
    assert_eq!(reaberto.len().expect("len"), 0);
}

#[test]
fn chave_de_outro_namespace_nao_e_tocada() {
    let store = MetaCacheStore::open_memory().expect("memória");
    store
        .write_value("raw:v1:bludv:d:x", &json!({ "items": [] }), 600, NOW)
        .expect_err("raw não é namespace de metadados");
    store.set(
        "raw:v1:bludv:d:x",
        CacheValue::Titles(Some(titles())),
        600,
        NOW,
    );
    assert_eq!(store.get("raw:v1:bludv:d:x", NOW), None);
    assert_eq!(store.len().expect("len"), 0);
    assert!(MetaCacheStore::owns("meta:movie:tt1"));
    assert!(MetaCacheStore::owns("tmdb:tt1"));
    assert!(MetaCacheStore::owns("tmdbc:tt1"));
    assert!(MetaCacheStore::owns("tmdbh:tt1"));
    assert!(!MetaCacheStore::owns("tmdbx:tt1"));
    assert!(!MetaCacheStore::owns("meta"));
}

#[test]
fn valor_corrompido_e_ignorado() {
    let store = MetaCacheStore::open_memory().expect("memória");
    store
        .lock()
        .execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            params!["meta:movie:tt1", "{nao e json", NOW + 60_000],
        )
        .expect("grava cru");
    assert_eq!(store.get("meta:movie:tt1", NOW), None);
}

#[test]
fn cota_do_namespace_despeja_o_que_expira_primeiro() {
    let store = MetaCacheStore::open_memory().expect("memória");
    let quota = quota_for("meta");
    // Uma entrada a mais que a cota; TTL crescente deixa a ordem previsível.
    for index in 0..=quota {
        let key = format!("meta:movie:tt{index}");
        store.set(&key, CacheValue::Cinemeta(None), 600 + index as u64, NOW);
    }
    assert_eq!(store.len().expect("len"), quota);
    assert_eq!(
        store.get("meta:movie:tt0", NOW),
        None,
        "a que expira primeiro cedeu lugar"
    );
    assert!(store.get(&format!("meta:movie:tt{quota}"), NOW).is_some());
}
