use std::collections::BTreeMap;

use serde_json::json;

use super::*;
use adom_sources::{EpisodeAired, MediaType};

const NOW: i64 = 1_700_000_000_000;

fn cinemeta_series() -> CinemetaMeta {
    let mut episodes = BTreeMap::new();
    episodes.insert(8, 6);
    CinemetaMeta {
        name: Some("Game of Thrones".into()),
        year: Some("2011–2019".into()),
        media_type: MediaType::Series,
        episodes_by_season: episodes,
        released: Some("2011-04-17T00:00:00.000Z".into()),
        first_aired: Some("2011-04-17".into()),
        episode_aired: vec![EpisodeAired {
            season: 8,
            episode: 3,
            date: "2019-04-29T05:00:00.000Z".into(),
        }],
    }
}

fn titles() -> Titles {
    // Só os campos que o Node PERSISTE: `tmdb_id`/`original_language`/`is_series`
    // são do cliente em memória e não sobrevivem ao cache (nem no Node).
    Titles {
        pt: Some("Duna".into()),
        original: Some("Dune".into()),
        en: Some("Dune".into()),
        aliases_br: vec!["Duna: Parte 2".into()],
        year: Some("2021".into()),
        original_language: None,
        tmdb_id: None,
        is_series: false,
    }
}

fn collection() -> CollectionInfo {
    CollectionInfo {
        name: "Duna Collection".into(),
        root: "duna".into(),
        years: vec![2021, 2024],
    }
}

fn roundtrip(store: &dyn MetaStore, key: &str, value: CacheValue) {
    store.set(key, value.clone(), 600, NOW);
    assert_eq!(store.get(key, NOW), Some(value), "chave {key}");
}

#[test]
fn roundtrip_dos_quatro_namespaces_em_arquivo() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("cache.db");
    let store = MetaCacheStore::open(&path).expect("abre");
    roundtrip(
        &store,
        "meta:series:tt0944947",
        CacheValue::Cinemeta(Some(cinemeta_series())),
    );
    roundtrip(&store, "tmdb:tt1160419", CacheValue::Titles(Some(titles())));
    roundtrip(
        &store,
        "tmdbc:tt1160419",
        CacheValue::Collection(CollectionRead {
            info: Some(collection()),
            ok: true,
        }),
    );
    roundtrip(
        &store,
        "tmdbh:tt1160419",
        CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(1_634_083_200_000),
            ok: true,
        }),
    );
    assert_eq!(store.len().expect("len"), 4);

    // Queda/restart: reabrir o MESMO arquivo e ler quente (nada de memória).
    drop(store);
    let reaberto = MetaCacheStore::open(&path).expect("reabre");
    assert_eq!(
        reaberto.get("meta:series:tt0944947", NOW),
        Some(CacheValue::Cinemeta(Some(cinemeta_series())))
    );
    assert_eq!(
        reaberto.get("tmdb:tt1160419", NOW),
        Some(CacheValue::Titles(Some(titles())))
    );
    assert_eq!(
        reaberto.get("tmdbh:tt1160419", NOW),
        Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(1_634_083_200_000),
            ok: true
        }))
    );
}

#[test]
fn valor_gravado_tem_o_formato_do_node() {
    let store = MetaCacheStore::open_memory().expect("memória");
    store.set(
        "meta:series:tt0944947",
        CacheValue::Cinemeta(Some(cinemeta_series())),
        600,
        NOW,
    );
    store.set(
        "tmdb:tt1160419",
        CacheValue::Titles(Some(titles())),
        600,
        NOW,
    );
    store.set(
        "tmdbc:tt1160419",
        CacheValue::Collection(CollectionRead {
            info: Some(collection()),
            ok: true,
        }),
        600,
        NOW,
    );
    store.set(
        "tmdbh:tt1160419",
        CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(42),
            ok: true,
        }),
        600,
        NOW,
    );

    // `__metaV:2` + `episodes` string-keyed: é o que faz o `getMeta` do Node
    // servir a entrada gravada pelo Rust.
    let meta = store
        .read_value("meta:series:tt0944947", NOW)
        .expect("meta");
    assert_eq!(meta["__metaV"], json!(2));
    assert_eq!(meta["type"], json!("series"));
    assert_eq!(meta["episodes"]["8"], json!(6));
    assert_eq!(
        meta["episodeAired"]["8:3"],
        json!("2019-04-29T05:00:00.000Z")
    );
    assert_eq!(meta["firstAired"], json!("2011-04-17"));

    let tmdb = store.read_value("tmdb:tt1160419", NOW).expect("tmdb");
    assert_eq!(tmdb["pt"], json!("Duna"));
    assert_eq!(tmdb["br"], json!(["Duna: Parte 2"]));
    assert_eq!(tmdb["year"], json!("2021"));
    assert!(
        tmdb.get("aliases").is_none(),
        "campo legado não pode voltar"
    );

    let tmdbc = store.read_value("tmdbc:tt1160419", NOW).expect("tmdbc");
    assert_eq!(tmdbc["info"]["root"], json!("duna"));
    assert_eq!(tmdbc["info"]["years"], json!([2021, 2024]));

    let tmdbh = store.read_value("tmdbh:tt1160419", NOW).expect("tmdbh");
    assert_eq!(tmdbh, json!({ "at": 42 }));
}

#[test]
fn le_entradas_gravadas_pelo_node() {
    let store = MetaCacheStore::open_memory().expect("memória");
    // Escritas no formato EXATO do Node (sem passar pelo encode do store).
    store
        .write_value(
            "meta:series:tt0944947",
            &json!({
                "name": "Game of Thrones",
                "year": "2011–2019",
                "type": "series",
                "episodes": { "8": 6 },
                "released": "2011-04-17T00:00:00.000Z",
                "firstAired": "2011-04-17",
                "episodeAired": { "8:3": "2019-04-29T05:00:00.000Z" },
                "__metaV": 2
            }),
            600,
            NOW,
        )
        .expect("grava meta");
    store
        .write_value(
            "tmdb:tt1160419",
            &json!({
                "pt": "Duna", "original": "Dune", "en": "Dune",
                "br": ["Duna: Parte 2"], "year": "2021"
            }),
            600,
            NOW,
        )
        .expect("grava tmdb");
    store
        .write_value(
            "tmdbc:tt1160419",
            &json!({ "info": { "name": "Duna Collection", "root": "duna", "years": [2021, 2024] } }),
            600,
            NOW,
        )
        .expect("grava tmdbc");
    store
        .write_value("tmdbh:tt1160419", &json!({ "at": null }), 600, NOW)
        .expect("grava tmdbh");

    assert_eq!(
        store.get("meta:series:tt0944947", NOW),
        Some(CacheValue::Cinemeta(Some(cinemeta_series())))
    );
    assert_eq!(
        store.get("tmdb:tt1160419", NOW),
        Some(CacheValue::Titles(Some(titles())))
    );
    assert_eq!(
        store.get("tmdbc:tt1160419", NOW),
        Some(CacheValue::Collection(CollectionRead {
            info: Some(collection()),
            ok: true
        }))
    );
    assert_eq!(
        store.get("tmdbh:tt1160419", NOW),
        Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: None,
            ok: true
        }))
    );
}

#[test]
fn miss_e_ausencia_autoritativa() {
    let store = MetaCacheStore::open_memory().expect("memória");
    for (key, value) in [
        ("meta:movie:tt1", CacheValue::Cinemeta(None)),
        ("tmdb:tt1", CacheValue::Titles(None)),
        (
            "tmdbc:tt1",
            CacheValue::Collection(CollectionRead {
                info: None,
                ok: true,
            }),
        ),
    ] {
        store.set(key, value.clone(), 600, NOW);
        assert_eq!(store.get(key, NOW), Some(value), "chave {key}");
    }
    // Coleção em FALHA (`ok:false`) vira `{miss:true}`, o mesmo do Node.
    store.set(
        "tmdbc:tt2",
        CacheValue::Collection(CollectionRead {
            info: None,
            ok: false,
        }),
        600,
        NOW,
    );
    assert_eq!(
        store.read_value("tmdbc:tt2", NOW),
        Some(json!({ "miss": true }))
    );
    assert_eq!(
        store.get("tmdbc:tt2", NOW),
        Some(CacheValue::Collection(CollectionRead {
            info: None,
            ok: true
        }))
    );
    // `tmdbc` com `info:null` (ausência autoritativa) também é miss de tipo.
    store
        .write_value("tmdbc:tt3", &json!({ "info": null }), 600, NOW)
        .expect("grava");
    assert_eq!(
        store.get("tmdbc:tt3", NOW),
        Some(CacheValue::Collection(CollectionRead {
            info: None,
            ok: true
        }))
    );
}

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

#[test]
fn ttl_zero_nao_grava() {
    let store = MetaCacheStore::open_memory().expect("memória");
    store.set("tmdb:tt1", CacheValue::Titles(Some(titles())), 0, NOW);
    assert_eq!(store.get("tmdb:tt1", NOW), None);
    assert_eq!(store.len().expect("len"), 0);
}

#[test]
fn read_only_le_o_arquivo_mas_nunca_grava() {
    let dir = tempfile::TempDir::new().expect("tempdir");
    let path = dir.path().join("cache.db");
    {
        let store = MetaCacheStore::open(&path).expect("abre");
        store.set(
            "tmdbh:tt1",
            CacheValue::HomeRelease(HomeReleaseRead {
                at: Some(9),
                ok: true,
            }),
            600,
            NOW,
        );
    }
    let read_only = MetaCacheStore::open_read_only(&path).expect("read-only");
    assert_eq!(
        read_only.get("tmdbh:tt1", NOW),
        Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(9),
            ok: true
        }))
    );
    // Escrita na referência da sombra é descartada (não muda o arquivo).
    read_only.set(
        "tmdbh:tt1",
        CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(1),
            ok: true,
        }),
        600,
        NOW,
    );
    drop(read_only);
    let reaberto = MetaCacheStore::open(&path).expect("reabre");
    assert_eq!(
        reaberto.get("tmdbh:tt1", NOW),
        Some(CacheValue::HomeRelease(HomeReleaseRead {
            at: Some(9),
            ok: true
        }))
    );
}
