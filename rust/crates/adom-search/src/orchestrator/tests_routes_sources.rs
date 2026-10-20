use super::test_support::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

// â”€â”€ Path sem /:userConfig â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tokio::test]
async fn path_sem_config_manda_encoded_canonico_em_meta_e_collect() {
    let store = Arc::new(MemorySwrStore::new());
    let backend = Arc::new(RecordingBackend::default());
    let orch = Orchestrator::new(config(), store)
        .with_collector(backend.clone())
        .with_meta(backend.clone())
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }));

    let req = StreamRequest::from_path(
        "/stream/movie/tt0133093.json",
        Some("Stremio/1.6"),
        Some(ORIGIN),
        Some(1_000_000),
    )
    .expect("path sem config deve casar");
    // URL truth: sem segmento. Corpo interno (abaixo) recebe o canÃ´nico `e30`.
    assert_eq!(req.encoded, None);
    assert_eq!(req.prefix(), "");

    let resposta = orch.handle(req).await;

    let meta_encoded = backend.meta_encoded.lock().expect("meta").clone();
    let collect_encoded = backend.collect_encoded.lock().expect("collect").clone();
    assert!(!meta_encoded.is_empty(), "meta precisa ser chamado");
    assert!(!collect_encoded.is_empty(), "collect precisa ser chamado");
    for enc in meta_encoded.iter().chain(collect_encoded.iter()) {
        assert!(
            !enc.is_empty(),
            "encoded no corpo nunca pode ser vazio (Node recusa)"
        );
        assert_eq!(enc, SEGMENT);
    }
    // Prefixo de play/aviso continua sem `/e30` inventado.
    if let Some(url) = resposta.streams.iter().find_map(|s| s.url.as_ref()) {
        assert!(
            url.starts_with("/resolve/") || url.starts_with(&format!("/{SEGMENT}/resolve/")),
            "url inesperada: {url}"
        );
        assert!(
            !url.starts_with(&format!("/{SEGMENT}/resolve/")),
            "path sem config nÃ£o deve prefixar /e30 nas URLs de play: {url}"
        );
    }
}

// â”€â”€ CompositeCollector com SOURCES_RUST â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tokio::test]
async fn composite_collector_preserva_fontes_do_node_com_sources_rust() {
    let store = Arc::new(MemorySwrStore::new());

    // Simulador da fonte nativa (ex: Jackett em Rust)
    let native_jackett: Arc<dyn Collector> = StubCollector::with_always(vec![RawItem {
        indexer: Some("jackett".into()),
        title: Some("Filme Teste 2024 1080p Dublado Jackett".into()),
        info_hash: Some(HASH.into()),
        seeders: Some(10.0),
        size_bytes: Some(1_000_000.0),
        is_br: true,
        ..RawItem::default()
    }]);

    // Simulador do NodeCollector (traz BLUDV, Mico e conta)
    let node_collector: Arc<dyn Collector> = StubCollector::with_always(vec![
        RawItem {
            indexer: Some("bludv".into()),
            title: Some("Filme Teste 2024 1080p Dublado BLUDV".into()),
            info_hash: Some("1111111111111111111111111111111111111111".into()),
            seeders: Some(1.0),
            is_br: true,
            ..RawItem::default()
        },
        RawItem {
            indexer: Some("mico".into()),
            title: Some("Filme Teste 2024 720p Dublado Mico".into()),
            info_hash: Some("2222222222222222222222222222222222222222".into()),
            seeders: Some(1.0),
            is_br: true,
            ..RawItem::default()
        },
    ]);

    let composite = Arc::new(CompositeCollector::new(vec![
        native_jackett,
        node_collector,
    ]));

    let orch = Orchestrator::new(config(), store)
        .with_collector(composite)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![
                HASH.into(),
                "1111111111111111111111111111111111111111".into(),
                "2222222222222222222222222222222222222222".into(),
            ],
        }));

    let req = StreamRequest::from_path(
        &format!("/{SEGMENT}/stream/movie/tt0133093.json"),
        Some("Stremio/1.6"),
        Some(ORIGIN),
        Some(1_000_000),
    )
    .expect("path vÃ¡lido");

    let resposta = orch.handle(req).await;
    let mut all_text = Vec::new();
    for s in &resposta.streams {
        let t = format!("name={:?}, title={:?}, url={:?}", s.name, s.title, s.url);
        all_text.push(t);
    }

    assert!(
        all_text
            .iter()
            .any(|t| t.contains("BLUDV") || t.contains("bludv")),
        "BLUDV vindo do Node deve estar presente na resposta: {:?}",
        all_text
    );
    assert!(
        all_text
            .iter()
            .any(|t| t.contains("Mico") || t.contains("mico")),
        "Mico vindo do Node deve estar presente na resposta: {:?}",
        all_text
    );
    assert!(
        all_text
            .iter()
            .any(|t| t.contains("Jackett") || t.contains("jackett")),
        "Jackett nativo deve estar presente na resposta: {:?}",
        all_text
    );
}

// â”€â”€ Via do Ãndice e Via InstantÃ¢nea do Banco â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Default)]
struct StubInternalRoutes {
    index_response: Mutex<Option<SearchIndexResponse>>,
}

impl InternalRoutes for StubInternalRoutes {
    fn meta<'a>(&'a self, req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async move {
            Ok(serde_json::from_value(json!({
                "ok": true,
                "type": req.media_type,
                "id": req.id,
                "imdb_id": req.id,
            }))
            .expect("meta"))
        })
    }

    fn collect<'a>(&'a self, _req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async {
            Ok(serde_json::from_value(json!({
                "ok": true,
                "type": "movie",
                "items": [],
                "partial": false,
            }))
            .expect("collect"))
        })
    }

    fn index_write<'a>(&'a self, _req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async {
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 1,
                entries: 1,
                bank_marked: 0,
                failed: 0,
            })
        })
    }

    fn effects<'a>(&'a self, _req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async {
            Ok(EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }

    fn search_index<'a>(
        &'a self,
        _req: SearchIndexRequest,
    ) -> RouteFuture<'a, SearchIndexResponse> {
        let resp = self
            .index_response
            .lock()
            .expect("index_response")
            .clone()
            .unwrap_or_default();
        Box::pin(async move { Ok(resp) })
    }
}

#[tokio::test]
async fn resposta_do_indice_coberta_responde_imediatamente_com_snapshot() {
    let store = Arc::new(MemorySwrStore::new());
    let routes = Arc::new(StubInternalRoutes {
        index_response: Mutex::new(Some(SearchIndexResponse {
            ok: true,
            is_partial: false,
            index_covered: true,
            instant_eligible: false,
            index_items: vec![json!({
                "title": "Filme Teste 2024 1080p Dublado Foto",
                "infoHash": HASH,
                "seeders": 5.0,
                "size": 1000000.0,
                "indexer": "bludv",
                "isBr": true,
                "fromFallback": true
            })],
            instant_items: vec![],
            account_items: vec![],
            effects: vec![],
        })),
    });

    let collector = StubCollector::empty(); // Coletor ao vivo vazio
    let orch = Orchestrator::new(config(), store)
        .with_collector(collector)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_internal_routes(routes);

    let req = StreamRequest::from_path(
        &format!("/{SEGMENT}/stream/movie/tt0133093.json"),
        Some("Stremio/1.6"),
        Some(ORIGIN),
        Some(1_000_000),
    )
    .expect("path vÃ¡lido");

    let resposta = orch.handle(req).await;
    assert_eq!(resposta.streams.len(), 1);
    let title = resposta.streams[0].title.as_deref().unwrap_or("");
    assert!(
        title.contains("Filme Teste"),
        "stream do indice deve estar presente: {title}"
    );
}

#[tokio::test]
async fn resposta_instantanea_do_banco_responde_com_itens_do_acervo() {
    let store = Arc::new(MemorySwrStore::new());
    let routes = Arc::new(StubInternalRoutes {
        index_response: Mutex::new(Some(SearchIndexResponse {
            ok: true,
            is_partial: false,
            index_covered: false,
            instant_eligible: true,
            index_items: vec![],
            instant_items: vec![json!({
                "title": "Filme Teste 2024 1080p Dublado Acervo",
                "infoHash": HASH,
                "seeders": 1.0,
                "indexer": "mico",
                "isBr": true,
                "fromFallback": true
            })],
            account_items: vec![],
            effects: vec![],
        })),
    });

    let collector = StubCollector::empty();
    let orch = Orchestrator::new(config(), store)
        .with_collector(collector)
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_internal_routes(routes);

    let req = StreamRequest::from_path(
        &format!("/{SEGMENT}/stream/movie/tt0133093.json"),
        Some("Stremio/1.6"),
        Some(ORIGIN),
        Some(1_000_000),
    )
    .expect("path vÃ¡lido");

    let resposta = orch.handle(req).await;
    assert_eq!(resposta.streams.len(), 1);
    let title = resposta.streams[0].title.as_deref().unwrap_or("");
    assert!(
        title.contains("Acervo"),
        "stream instantÃ¢neo do banco deve estar presente: {title}"
    );
}

/// Ãndice coberto E instantÃ¢nea elegÃ­vel ao mesmo tempo: a instantÃ¢nea vence
/// (mesma ordem do `search-index-path.ts`) e a foto do Ã­ndice sai marcada como
/// `fromSnapshot`, nÃ£o como reserva bloqueada.
#[tokio::test]
async fn via_instantanea_vence_quando_o_indice_tambem_cobre() {
    let routes = Arc::new(StubInternalRoutes {
        index_response: Mutex::new(Some(SearchIndexResponse {
            ok: true,
            is_partial: false,
            index_covered: true,
            instant_eligible: true,
            index_items: vec![
                json!({"title": "Filme Teste 2024 Foto", "infoHash": HASH, "indexer": "bludv"}),
            ],
            instant_items: vec![
                json!({"title": "Filme Teste 2024 Acervo", "infoHash": HASH, "indexer": "mico", "fromFallback": true}),
            ],
            account_items: vec![],
            effects: vec![],
        })),
    });
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_internal_routes(routes);
    let input = crate::orchestrator::finish::SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some("e30".into()),
        prefix: "p".into(),
        options: json!({}),
        key: "k".into(),
        now_ms: 1_000,
        deadline_at: Some(1_000_000),
    };

    let fast = orch
        .fast_path_items(&input, &meta())
        .await
        .expect("via rÃ¡pida");
    assert!(fast.instant, "instantanea tem precedencia sobre o indice");
    let foto = fast
        .items
        .iter()
        .find(|i| i.title.as_deref().unwrap_or("").contains("Foto"));
    let acervo = fast
        .items
        .iter()
        .find(|i| i.title.as_deref().unwrap_or("").contains("Acervo"));
    assert!(foto.is_some_and(|i| i.from_snapshot && !i.from_fallback));
    assert!(acervo.is_some_and(|i| i.from_fallback && !i.from_snapshot));
}
