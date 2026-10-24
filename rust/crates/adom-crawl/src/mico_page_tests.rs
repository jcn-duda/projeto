//! Testes da leitura de página do Mico e do roteamento `own_pace`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::mico::{mico_episode_stream_url, mico_movie_stream_url, SeriesMeta};
use crate::mico_net::api::{MicoApi, MicoFuture};
use crate::mico_net::types::{CatalogPage, CatalogType, MicoError};
use crate::motor::types::{CrawlResultStatus, PageEngine, PageOutcome};
use crate::store::UrlRow;

use super::{MicoPageEngine, RoutedPageEngine};

const BASE: &str = "https://mico.teste";

#[derive(Default)]
struct FakeApi {
    streams: HashMap<String, String>,
    meta: Option<SeriesMeta>,
    calls: Mutex<Vec<String>>,
}

impl FakeApi {
    fn com_streams(urls: &[(String, String)]) -> Self {
        Self {
            streams: urls.iter().cloned().collect(),
            ..Default::default()
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl MicoApi for FakeApi {
    fn catalog_page<'a>(
        &'a self,
        _kind: CatalogType,
        _catalog_id: &'a str,
        _skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
        Box::pin(async { unimplemented!("leitura de página não lista catálogo") })
    }

    fn get_json<'a>(&'a self, url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(url.to_string());
            Ok(self.streams.get(url).cloned())
        })
    }

    fn series_meta<'a>(
        &'a self,
        _imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<SeriesMeta>, MicoError>> {
        Box::pin(async move { Ok(self.meta.clone()) })
    }
}

fn row(url: &str, kind: &str) -> UrlRow {
    UrlRow {
        site: "mico".to_string(),
        url: url.to_string(),
        url_key: url
            .trim_start_matches(BASE)
            .trim_end_matches('/')
            .to_string(),
        lastmod: String::new(),
        kind: kind.to_string(),
        status: "inflight".to_string(),
        imdb: None,
        tries: 0,
        next_at: 0,
        checked_at: 0,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 0,
    }
}

fn corpo(hash: &str, titulo: &str) -> String {
    format!(r#"{{"streams":[{{"infoHash":"{hash}","title":"{titulo}"}}]}}"#)
}

fn engine(api: Arc<FakeApi>, max_buttons: u32) -> MicoPageEngine {
    let cfg = crate::mico_discovery::MicoCrawlConfig {
        base_url: BASE.to_string(),
        series_max_buttons: max_buttons,
        series_max_seasons: 2,
        ..Default::default()
    };
    MicoPageEngine::new(api, &cfg)
}

fn work(outcome: PageOutcome) -> Box<crate::motor::types::CrawlWorkResult> {
    match outcome {
        PageOutcome::Work(w) => w,
        PageOutcome::Failed(msg) => panic!("esperava Work, veio Failed: {msg}"),
        PageOutcome::TimedOut => panic!("esperava Work, veio TimedOut"),
    }
}

fn meta_serie() -> SeriesMeta {
    let mut episodes = HashMap::new();
    episodes.insert("1".to_string(), 3u32);
    let mut aired = HashMap::new();
    for ep in 1..=3 {
        aired.insert(format!("1:{ep}"), "2020-01-01".to_string());
    }
    SeriesMeta {
        episodes,
        episode_aired: aired,
        name: Some("Serie".to_string()),
        year: None,
    }
}

fn streams_da_serie() -> Vec<(String, String)> {
    (1..=3)
        .map(|ep| {
            let url = mico_episode_stream_url("tt1234567", 1, ep, Some(BASE)).unwrap();
            (
                url,
                corpo(&format!("{ep}").repeat(40), &format!("Episodio {ep}")),
            )
        })
        .collect()
}

#[tokio::test]
async fn filme_done_com_magnet_e_imdb() {
    let url = mico_movie_stream_url("tt0133093", Some(BASE)).unwrap();
    let hash = "a".repeat(40);
    let esperado_magnet = format!("magnet:?xt=urn:btih:{hash}");
    let api = Arc::new(FakeApi::com_streams(&[(
        url,
        corpo(&hash, "Matrix 1999 1080p"),
    )]));
    let row = row("https://mico.teste/crawl/movie/tt0133093/", "movie");
    let out = work(engine(api, 40).execute(&row).await);
    assert_eq!(out.status, CrawlResultStatus::Done);
    assert_eq!(out.imdb.as_deref(), Some("tt0133093"));
    assert_eq!(out.kind, "movie");
    assert_eq!(out.releases.len(), 1);
    assert_eq!(
        out.releases[0].magnet.as_deref(),
        Some(esperado_magnet.as_str())
    );
    assert_eq!(out.request_cost, 1);
}

#[tokio::test]
async fn filme_4xx_vira_no_torrent_sem_erro() {
    let api = Arc::new(FakeApi::default()); // nenhum stream conhecido = 4xx
    let row = row("https://mico.teste/crawl/movie/tt0133093/", "movie");
    let out = work(engine(api, 40).execute(&row).await);
    assert_eq!(out.status, CrawlResultStatus::NoTorrent);
    assert_eq!(out.request_cost, 1);
}

#[tokio::test]
async fn kind_divergente_falha_sem_tocar_a_rede() {
    let api = Arc::new(FakeApi::default());
    let row = row("https://mico.teste/crawl/movie/tt0133093/", "tv_show");
    let outcome = engine(api.clone(), 40).execute(&row).await;
    assert!(matches!(outcome, PageOutcome::Failed(_)));
    assert!(api.calls().is_empty(), "kind divergente não faz requisição");
}

#[tokio::test]
async fn serie_parcial_retoma_e_conclui_com_progresso_monotonico() {
    let api = Arc::new(FakeApi {
        streams: streams_da_serie().into_iter().collect(),
        meta: Some(meta_serie()),
        calls: Mutex::new(Vec::new()),
    });
    let engine = engine(api.clone(), 2);
    let primeira = row("https://mico.teste/crawl/series/tt1234567/", "tv_show");
    let out1 = work(engine.execute(&primeira).await);
    assert_eq!(out1.status, CrawlResultStatus::Partial);
    assert_eq!(out1.groups.len(), 2);
    assert!(out1.error.starts_with("series_truncated"));
    let progress = out1.progress.clone().expect("progresso do passe parcial");
    let v: serde_json::Value = serde_json::from_str(&progress).unwrap();
    assert_eq!(v["totalCards"], 3);
    assert_eq!(v["doneCards"].as_array().unwrap().len(), 2);
    assert_eq!(api.calls().len(), 2);

    let mut segunda = row("https://mico.teste/crawl/series/tt1234567/", "tv_show");
    segunda.progress = progress;
    let out2 = work(engine.execute(&segunda).await);
    assert_eq!(out2.status, CrawlResultStatus::Done);
    assert_eq!(out2.groups.len(), 1, "só o episódio que faltava foi lido");
    assert_eq!(out2.groups[0].episode, Some(3));
    let v2: serde_json::Value = serde_json::from_str(out2.progress.as_deref().unwrap()).unwrap();
    assert_eq!(v2["doneCards"].as_array().unwrap().len(), 3);
    assert_eq!(api.calls().len(), 3, "retomada não relê episódio feito");
}

#[tokio::test]
async fn serie_sem_meta_e_erro_retentavel() {
    let api = Arc::new(FakeApi::default()); // meta = None
    let row = row("https://mico.teste/crawl/series/tt1234567/", "tv_show");
    match engine(api, 40).execute(&row).await {
        PageOutcome::Failed(msg) => assert!(msg.contains("sem meta"), "mensagem: {msg}"),
        outro => panic!("esperava Failed, veio {outro:?}"),
    }
}

#[tokio::test]
async fn serie_sem_episodio_exibido_e_no_torrent_com_custo_zero() {
    let mut meta = meta_serie();
    meta.episode_aired.clear(); // nenhum episódio com data = nenhum alvo
    let api = Arc::new(FakeApi {
        meta: Some(meta),
        ..Default::default()
    });
    let row = row("https://mico.teste/crawl/series/tt1234567/", "tv_show");
    let out = work(engine(api, 40).execute(&row).await);
    assert_eq!(out.status, CrawlResultStatus::NoTorrent);
    assert_eq!(out.request_cost, 0, "sem alvo não gastou o Mico");
    assert!(out.groups.is_empty());
}

#[tokio::test]
async fn serie_respeita_o_teto_de_episodios_por_passe() {
    let api = Arc::new(FakeApi {
        streams: streams_da_serie().into_iter().collect(),
        meta: Some(meta_serie()),
        calls: Mutex::new(Vec::new()),
    });
    let row = row("https://mico.teste/crawl/series/tt1234567/", "tv_show");
    let out = work(engine(api.clone(), 1).execute(&row).await);
    assert_eq!(out.status, CrawlResultStatus::Partial);
    assert_eq!(api.calls().len(), 1, "um botão por passe");
    assert_eq!(out.request_cost, 1);
}

#[tokio::test]
async fn roteador_manda_own_pace_para_a_engine_do_mico() {
    struct Marca(&'static str);
    impl PageEngine for Marca {
        fn is_ready(&self) -> bool {
            true
        }
        fn execute<'a>(&'a self, _row: &'a UrlRow) -> crate::motor::types::PageFuture<'a> {
            let nome = self.0;
            Box::pin(async move { PageOutcome::Failed(nome.to_string()) })
        }
    }
    let router = RoutedPageEngine::new(Arc::new(Marca("html")), Arc::new(Marca("mico")));
    let mico = row("https://mico.teste/crawl/movie/tt0133093/", "movie");
    match router.execute(&mico).await {
        PageOutcome::Failed(msg) => assert_eq!(msg, "mico"),
        outro => panic!("esperava a engine do Mico, veio {outro:?}"),
    }
    let mut html = row("https://nerdfilmes.net/filme/x/", "movie");
    html.site = "nerdfilmes".to_string();
    match router.execute(&html).await {
        PageOutcome::Failed(msg) => assert_eq!(msg, "html"),
        outro => panic!("esperava a engine HTML, veio {outro:?}"),
    }
}
