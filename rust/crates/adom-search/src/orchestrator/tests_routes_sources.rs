use std::sync::Arc;

use adom_core::{InstantMagnet, InstantSource, InstantWork};

use super::test_support::*;

// ── Path sem /:userConfig ──────────────────────────────────────────────────

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
    // URL truth: sem segmento. Corpo interno (abaixo) recebe o canônico `e30`.
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
            "path sem config não deve prefixar /e30 nas URLs de play: {url}"
        );
    }
}

// ── CompositeCollector com SOURCES_RUST ────────────────────────────────────

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
    .expect("path válido");

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

// ── Via do Índice e Via Instantânea do Banco (nativas) ─────────────────────

const BANK_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Release do `idx:v14` no formato que o Node grava.
fn index_release(hash: &str, title: &str, indexer: &str) -> IndexedReleaseWire {
    IndexedReleaseWire {
        hash: hash.to_string(),
        title: title.to_string(),
        size: Some(1_000_000),
        indexer: indexer.to_string(),
        tracker: None,
        is_br: true,
        dubbed: true,
        quality: "1080p".to_string(),
        seeders: 5,
        seen_at: 0,
        lied: false,
        source: None,
        media_source: None,
    }
}

/// Obra elegível do `magnets.db`: `passed_filter = 1` e observada AGORA (a
/// janela adaptativa da instantânea é medida contra o relógio real).
fn instant_work(hash: &str, title: &str) -> InstantWork {
    let now = crate::orchestrator::respond::now_ms();
    InstantWork {
        hash: hash.to_string(),
        passed_filter: 1,
        last_seen: now,
        first_seen: now,
        magnet: Some(InstantMagnet {
            hash: hash.to_string(),
            uri: format!("magnet:?xt=urn:btih:{hash}&dn={title}"),
            title: title.to_string(),
            size: 1_000,
            is_br: true,
            dubbed: true,
            quality: "1080p".to_string(),
            seeders_max: 9,
            seeders_last: 7,
            last_seen: now,
            lied: false,
        }),
    }
}

fn instant_bank(hash: &str, title: &str) -> Arc<StubBank> {
    let mut sources = std::collections::BTreeMap::new();
    sources.insert(
        hash.to_string(),
        vec![InstantSource {
            indexer: "bludv".into(),
            tracker: "BLUDV".into(),
            last_seen: crate::orchestrator::respond::now_ms(),
            // O orquestrador recalcula a permissão a partir do pedido.
            allowed: false,
        }],
    );
    StubBank::new(vec![instant_work(hash, title)], sources)
}

#[tokio::test]
async fn indice_nativo_coberto_responde_imediatamente_com_a_foto() {
    let index = StubIndex::with(vec![index_release(
        HASH,
        "Filme Teste 2024 1080p Dublado Foto",
        "bludv",
    )]);
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![HASH.into()],
        }))
        .with_index_source(index);

    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(
        resposta.streams.len(),
        1,
        "o índice coberto responde sozinho"
    );
    let title = resposta.streams[0].title.as_deref().unwrap_or("");
    assert!(
        title.contains("Filme Teste"),
        "stream do índice deve estar presente: {title}"
    );
}

#[tokio::test]
async fn banco_nativo_instantaneo_responde_com_itens_do_acervo() {
    let bank = instant_bank(BANK_HASH, "Filme Teste 2024 1080p Dublado Acervo");
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_debrid(Arc::new(StubDebrid {
            cached: vec![BANK_HASH.into()],
        }))
        .with_bank_source(bank);

    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1, "o acervo responde sozinho");
    let title = resposta.streams[0].title.as_deref().unwrap_or("");
    assert!(
        title.contains("Acervo"),
        "stream instantâneo do banco deve estar presente: {title}"
    );
}

/// Índice coberto E instantânea elegível ao mesmo tempo: a instantânea vence
/// (mesma ordem do antigo `search-index-path.ts`) e a foto do índice sai
/// marcada como `fromSnapshot`, não como reserva bloqueada.
#[tokio::test]
async fn via_instantanea_vence_quando_o_indice_tambem_cobre() {
    // Hashes DIFERENTES: a instantânea exclui os hashes que o índice já tem.
    let index = StubIndex::with(vec![index_release(
        HASH,
        "Filme Teste 2024 1080p Foto",
        "bludv",
    )]);
    let bank = instant_bank(BANK_HASH, "Filme Teste 2024 1080p Dublado Acervo");
    let orch = Orchestrator::new(config(), Arc::new(MemorySwrStore::new()))
        .with_collector(StubCollector::empty())
        .with_meta(Arc::new(StubMeta(meta())))
        .with_index_source(index)
        .with_bank_source(bank);
    let input = crate::orchestrator::finish::SearchInput {
        kind: "movie".into(),
        id: "tt0133093".into(),
        encoded: Some(SEGMENT.into()),
        prefix: "p".into(),
        options: options(),
        key: "k".into(),
        now_ms: 1_000,
        deadline_at: Some(1_000_000),
    };

    let fast = orch
        .fast_path_items(&input, &meta())
        .await
        .expect("via rápida");
    assert!(fast.instant, "instantânea tem precedência sobre o índice");
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
