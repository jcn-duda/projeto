//! Multiobra, data doméstica, série e as réguas do núcleo chamadas pelo
//! `MetaLookup` (WEB/BluRay × CAM/TS, trailer fora).

mod support;

use adom_sources::{
    now_ms, CacheValue, LookupOptions, MediaType, MemoryMetaStore, MetaSources, MetaStore,
};
use support::{
    config, FakeApi, HOME_RELEASE, HOME_RELEASE_AT, MULTIWORK, ONE_PART, SERIES, YEAR_DIVERGE,
};

const DEADLINE_MS: i64 = 3_000;
const MARGIN_MS: i64 = 48 * 60 * 60 * 1_000;

#[tokio::test]
async fn multiobra_le_colecao_e_exige_dois_anos() {
    let (api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    // Sem o opt-in não há chamada de coleção (o TS só faz no caminho BR).
    let sem_optin = sources
        .lookup(
            MULTIWORK,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;
    assert!(sem_optin.collection.is_none());
    assert_eq!(api.count("/collection/"), 0);

    let meta = sources
        .lookup(
            MULTIWORK,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::multiwork(),
        )
        .await;
    let collection = meta.collection.expect("coleção multiobra");
    assert_eq!(collection.name, "The Hunger Games Collection");
    assert_eq!(collection.root, "hunger games");
    assert_eq!(collection.years, vec![2012, 2013, 2014]);

    // Raiz existe, mas só UMA parte/ano: não é multiobra.
    let one_part = sources
        .lookup(
            ONE_PART,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::multiwork(),
        )
        .await;
    assert!(one_part.collection.is_none());
}

#[tokio::test]
async fn data_domestica_corta_web_antes_e_deixa_cam_passar() {
    let (api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");
    let deadline = now_ms() + DEADLINE_MS;

    // Sem o opt-in: nem rede, nem cache.
    let sem_optin = sources
        .lookup(
            HOME_RELEASE,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(sem_optin.home_release_at, None);
    assert_eq!(api.count("/release_dates"), 0);

    let meta = sources
        .lookup(
            HOME_RELEASE,
            MediaType::Movie,
            deadline,
            &LookupOptions::home_release(),
        )
        .await;
    assert_eq!(meta.home_release_at, Some(HOME_RELEASE_AT));
    assert_eq!(api.count("/release_dates"), 1);
    assert_eq!(
        sources.tmdb.peek_home_release_at(HOME_RELEASE),
        Some(HOME_RELEASE_AT)
    );

    // WEB/BluRay/HDTV antes do lançamento doméstico NÃO são o filme.
    assert!(meta.blocks_before_home_release(
        "The.Odyssey.2026.1080p.WEB-DL",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    assert!(meta.blocks_before_home_release(
        "The.Odyssey.2026.BluRay",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    assert!(meta.blocks_before_home_release(
        "The.Odyssey.2026.HDTV",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    // CAM/TS passam: são gravação de cinema, não outra obra doméstica.
    assert!(!meta.blocks_before_home_release(
        "The.Odyssey.2026.CAM",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    assert!(!meta.blocks_before_home_release(
        "The.Odyssey.2026.TS",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    // Dentro da margem de 48h não corta; kill-switch também não.
    assert!(!meta.blocks_before_home_release(
        "The.Odyssey.2026.1080p.WEB-DL",
        HOME_RELEASE_AT - 10 * 60 * 60 * 1_000,
        true,
        MARGIN_MS,
    ));
    assert!(!meta.blocks_before_home_release(
        "The.Odyssey.2026.1080p.WEB-DL",
        HOME_RELEASE_AT - 72 * 60 * 60 * 1_000,
        false,
        MARGIN_MS,
    ));

    // Trailer/teaser/trilha saem sempre; o nome da obra isenta o próprio título.
    assert!(meta.is_non_feature_release("The.Odyssey.2026.Trailer"));
    assert!(!meta.is_non_feature_release("The.Odyssey.2026.1080p.WEB-DL"));
    let mut exempt = meta.clone();
    exempt.names = vec!["The Trailer Park".to_string()];
    assert!(!exempt.is_non_feature_release("The.Trailer.Park.2024.Trailer"));

    // Peek não refaz rede; o segundo lookup com opt-in também vem do cache.
    let calls = api.count("/release_dates");
    sources
        .lookup(
            HOME_RELEASE,
            MediaType::Movie,
            deadline,
            &LookupOptions::home_release(),
        )
        .await;
    assert_eq!(api.count("/release_dates"), calls);
}

#[tokio::test]
async fn serie_traz_episodios_por_temporada_e_datas_reais() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let meta = sources
        .lookup(
            SERIES,
            MediaType::Series,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;

    assert!(meta.is_series());
    assert_eq!(meta.title_pt.as_deref(), Some("Lioness"));
    assert_eq!(meta.episodes_by_season.get(&0), None);
    assert_eq!(meta.episodes_by_season.get(&1), Some(&2));
    assert_eq!(meta.episodes_by_season.get(&2), Some(&1));
    assert_eq!(meta.episode_counts(), vec![(1, 2), (2, 1)]);
    // `released` com fallback em `firstAired`; episódio sem data não entra.
    assert_eq!(meta.episode_aired_at(1, 1), Some("2020-01-01"));
    assert_eq!(meta.episode_aired_at(1, 2), Some("2020-01-08"));
    assert_eq!(meta.episode_aired_at(0, 1), None);
    assert_eq!(meta.episode_aired_at(2, 1), None);
    // Ano cru do Cinemeta quando as fontes concordam.
    assert_eq!(meta.year.as_deref(), Some("2018–"));
    assert_eq!(meta.alt_year, None);
    // Série não pede multiobra nem data doméstica.
    assert!(meta.collection.is_none());
    assert!(meta.home_release_at.is_none());
}

#[tokio::test]
async fn ano_divergente_escolhe_tmdb_e_guarda_o_alternativo() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let meta = sources
        .lookup(
            YEAR_DIVERGE,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;

    // Cinemeta 2018 × TMDB 2021 (>2): o ano mundial vence, o outro volta em
    // `alt_year` para o filtro aceitar as duas datas.
    assert_eq!(meta.year.as_deref(), Some("2021"));
    assert_eq!(meta.alt_year, Some(2018));
}

#[test]
fn store_em_memoria_respeita_ttl() {
    let store = MemoryMetaStore::new();
    store.set("tmdb:x", CacheValue::Titles(None), 10, 1_000);
    assert_eq!(store.get("tmdb:x", 10_999), Some(CacheValue::Titles(None)));
    assert_eq!(store.get("tmdb:x", 11_000), None);
    // ttl 0 desliga a escrita.
    store.set("tmdb:y", CacheValue::Titles(None), 0, 1_000);
    assert_eq!(store.get("tmdb:y", 1_001), None);
}
