//! Contrato do `lookup`: find duplo, parcial honesto, `original_*` ignorado,
//! travas dos aliases BR e cache só com `ok:true`.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use adom_sources::{now_ms, LookupOptions, MediaType, MetaSources};
use support::{
    config, FakeApi, RecordingStore, ALIASES, ALIASES_FAIL, CINEMETA_404, CINEMETA_FAILS, EN_FAILS,
    EN_SLOW, MOVIE_OK, ORIGINAL_IGNORED, PT_EMPTY, PT_FAILS, SLOW,
};

const DEADLINE_MS: i64 = 3_000;

#[tokio::test]
async fn find_duplo_no_mesmo_prazo_e_titulos_canonicos() {
    let (api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let meta = sources
        .lookup(
            MOVIE_OK,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;

    assert_eq!(meta.title_pt.as_deref(), Some("Coringa"));
    assert_eq!(meta.title_en.as_deref(), Some("Joker"));
    assert_eq!(meta.title_original.as_deref(), Some("Joker"));
    assert_eq!(meta.meta_name.as_deref(), Some("Coringa"));
    assert_eq!(meta.year.as_deref(), Some("2019"));
    assert_eq!(meta.alt_year, None);
    assert_eq!(meta.names, vec!["Coringa".to_string(), "Joker".to_string()]);
    assert!(meta.aliases_br.is_empty());

    // O find duplo acontece de verdade, um por idioma, e os aliases usam o id
    // numérico devolvido pelo pt-BR.
    assert_eq!(api.find_calls("pt-BR"), 1);
    assert_eq!(api.find_calls("en-US"), 1);
    assert_eq!(api.count("/alternative_titles"), 1);
    // `User-Agent` configurável chega em TODAS as requisições.
    assert!(api
        .calls()
        .iter()
        .all(|call| call.user_agent.as_deref() == Some("adom-sources-test/1.0")));
}

#[tokio::test]
async fn um_lado_falha_devolve_resultado_parcial() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    // TMDB en-US cai: pt/original/ano continuam valendo.
    let en_fail = sources
        .lookup(
            EN_FAILS,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(en_fail.title_pt.as_deref(), Some("Filme Teste"));
    assert_eq!(en_fail.title_en, None);
    assert_eq!(en_fail.meta_name.as_deref(), Some("Filme Teste"));

    // TMDB pt-BR cai: o Cinemeta sozinho mantém nome e ano.
    let pt_fail = sources
        .lookup(
            PT_FAILS,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(pt_fail.title_pt, None);
    assert_eq!(pt_fail.title_en.as_deref(), Some("Test Movie"));
    assert_eq!(pt_fail.meta_name.as_deref(), Some("Filme Teste"));

    // Cinemeta cai: o TMDB mantém títulos e ano.
    let cinemeta_fail = sources
        .lookup(
            CINEMETA_FAILS,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(cinemeta_fail.meta_name, None);
    assert_eq!(cinemeta_fail.title_pt.as_deref(), Some("Filme Teste"));
    assert_eq!(cinemeta_fail.title_en.as_deref(), Some("Test Movie"));
    assert_eq!(cinemeta_fail.year.as_deref(), Some("2020"));
}

#[tokio::test]
async fn original_title_nunca_vira_titulo_en() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let meta = sources
        .lookup(
            ORIGINAL_IGNORED,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;

    // A resposta en-US só tem `original_title` (italiano). O canônico inglês
    // NÃO pode ser promovido dali.
    assert_eq!(meta.title_pt.as_deref(), Some("Django Kill"));
    assert_eq!(meta.title_original.as_deref(), Some("Se sei vivo spara"));
    assert_eq!(meta.title_en, None);
}

#[tokio::test]
async fn aliases_br_aceitos_e_recusados_pelas_travas() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let meta = sources
        .lookup(
            ALIASES,
            MediaType::Movie,
            now_ms() + DEADLINE_MS,
            &LookupOptions::default(),
        )
        .await;

    // "Operação: Lioness"/"Agente Lioness" contêm a palavra canônica; "Kill"
    // solto abriria outra obra; "Lioness" é idêntico ao canônico; "US Alias" não
    // é BR. Teto de 2 do núcleo.
    assert_eq!(
        meta.aliases_br,
        vec![
            "Operação: Lioness".to_string(),
            "Agente Lioness".to_string()
        ]
    );
    assert!(meta.names.contains(&"Operação: Lioness".to_string()));
}

#[tokio::test]
async fn cache_longo_so_com_consultas_ok() {
    let (api, base) = FakeApi::start().await;
    let store = Arc::new(RecordingStore::default());
    let sources = MetaSources::new(config(&base), store.clone()).expect("fachada");
    let deadline = now_ms() + DEADLINE_MS;

    // Caminho feliz: título e meta vão para o TTL longo.
    sources
        .lookup(
            MOVIE_OK,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store
            .set_for("tmdb:tt1000001")
            .expect("títulos")
            .ttl_seconds,
        777
    );
    assert_eq!(
        store
            .set_for("meta:movie:tt1000001")
            .expect("meta")
            .ttl_seconds,
        86_400
    );

    // O segundo lookup não vai à rede: entradas vivas.
    let calls = api.calls().len();
    sources
        .lookup(
            MOVIE_OK,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(api.calls().len(), calls, "cache hit não refaz HTTP");

    // en-US cai: degradação, TTL transitório (40s), nunca os 777s.
    sources
        .lookup(
            EN_FAILS,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store
            .set_for("tmdb:tt1000002")
            .expect("títulos")
            .ttl_seconds,
        40
    );

    // alternative_titles cai: mesma degradação.
    sources
        .lookup(
            ALIASES_FAIL,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store
            .set_for("tmdb:tt1000012")
            .expect("títulos")
            .ttl_seconds,
        40
    );

    // Ausência AUTORITATIVA (200 sem resultado) usa o miss TTL cheio.
    sources
        .lookup(
            PT_EMPTY,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store.set_for("tmdb:tt1000014").expect("miss").ttl_seconds,
        111
    );

    // Cinemeta: 5xx é transitório (30s); 404 é autoritativo (300s).
    sources
        .lookup(
            CINEMETA_FAILS,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store
            .set_for("meta:movie:tt1000009")
            .expect("miss transitório")
            .ttl_seconds,
        30
    );
    sources
        .lookup(
            CINEMETA_404,
            MediaType::Movie,
            deadline,
            &LookupOptions::default(),
        )
        .await;
    assert_eq!(
        store
            .set_for("meta:movie:tt1000015")
            .expect("miss autoritativo")
            .ttl_seconds,
        300
    );
}

#[tokio::test]
async fn prazo_vencido_nao_vai_a_rede() {
    let (api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let started = Instant::now();
    let meta = sources
        .lookup(
            MOVIE_OK,
            MediaType::Movie,
            now_ms() - 1_000,
            &LookupOptions::default(),
        )
        .await;
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "prazo vencido não pode esperar rede"
    );
    assert!(
        api.calls().is_empty(),
        "nenhuma requisição com prazo vencido"
    );
    assert_eq!(meta.imdb, MOVIE_OK);
    assert_eq!(meta.title_pt, None);
    assert_eq!(meta.meta_name, None);
}

#[tokio::test]
async fn prazo_estourado_no_meio_devolve_parcial() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let started = Instant::now();
    let meta = sources
        .lookup(
            SLOW,
            MediaType::Movie,
            now_ms() + 80,
            &LookupOptions::default(),
        )
        .await;

    // O servidor dorme 700ms; o prazo absoluto de 80ms corta as duas pernas.
    assert!(
        started.elapsed() < Duration::from_millis(600),
        "lookup esperou além do prazo: {:?}",
        started.elapsed()
    );
    assert_eq!(meta.title_pt, None);
    assert_eq!(meta.meta_name, None);
    assert_eq!(meta.year, None);
}

#[tokio::test]
async fn en_us_usa_o_prazo_absoluto_do_caller() {
    let (_api, base) = FakeApi::start().await;
    let sources = MetaSources::with_memory_store(config(&base)).expect("fachada");

    let started = Instant::now();
    // Só o lado en-US dorme: o pt-BR responde e o prazo curto NÃO pode ser
    // renovado para o en-US (o orçamento é o do caller, não um por chamada).
    let meta = sources
        .lookup(
            EN_SLOW,
            MediaType::Movie,
            now_ms() + 150,
            &LookupOptions::default(),
        )
        .await;

    assert!(
        started.elapsed() < Duration::from_millis(600),
        "en-US ganhou prazo próprio: {:?}",
        started.elapsed()
    );
    assert_eq!(meta.title_pt.as_deref(), Some("Filme Teste"));
    assert_eq!(meta.title_en, None);
    assert_eq!(meta.year.as_deref(), Some("2020"));
}

#[tokio::test]
async fn timeout_por_requisicao_vence_antes_do_prazo_absoluto() {
    let (_api, base) = FakeApi::start().await;
    let mut cfg = config(&base);
    cfg.cinemeta.request_timeout_ms = 80;
    cfg.tmdb.request_timeout_ms = 80;
    let sources = MetaSources::with_memory_store(cfg).expect("fachada");

    let started = Instant::now();
    let meta = sources
        .lookup(
            SLOW,
            MediaType::Movie,
            now_ms() + 5_000,
            &LookupOptions::default(),
        )
        .await;

    // O prazo absoluto ainda tem 5s, mas o teto de 80ms POR REQUISIÇÃO corta
    // a perna lenta (o servidor dorme 700ms).
    assert!(
        started.elapsed() < Duration::from_millis(600),
        "teto por requisição não venceu: {:?}",
        started.elapsed()
    );
    assert_eq!(meta.title_pt, None);
    assert_eq!(meta.meta_name, None);
}
