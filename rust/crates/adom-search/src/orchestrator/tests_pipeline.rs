use super::test_support::*;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

#[path = "tests_pipeline_part2.rs"]
mod part2;

// ── SWR ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn hit_swr_servivel_nao_recomputa() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let primeira = orch.handle(request(1_000_000)).await;
    assert_eq!(primeira.streams.len(), 1);
    assert_eq!(collector.calls(), 1);

    // Segunda abertura: hit fresco serve direto (sem nova coleta) e com o host
    // de QUEM pergunta (a entrada guarda só o path relativo).
    let segunda = orch.handle(request(1_000_000)).await;
    assert_eq!(segunda.streams.len(), 1);
    assert_eq!(collector.calls(), 1, "hit não pode recomputar");
    assert_eq!(primeira.streams[0].url, segunda.streams[0].url);
    assert!(segunda.streams[0]
        .url
        .as_deref()
        .unwrap_or("")
        .starts_with(ORIGIN));
    assert_eq!(segunda.cache_max_age, 900);
}

#[tokio::test]
async fn hit_stale_serve_e_revalida_em_fundo() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let _ = orch.handle(request(1_000_000)).await;
    assert_eq!(collector.calls(), 1);
    // TTL de 900s (decisão da lista completa): 901,5s depois a entrada está stale mas na graça de 300s.
    let stale = orch.handle(request(1_901_500)).await;
    assert_eq!(stale.streams.len(), 1, "stale serve na hora");
    assert_eq!(stale.cache_max_age, 900);
    // A revalidação roda em fundo: a segunda coleta acontece depois.
    for _ in 0..40 {
        if collector.calls() > 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(collector.calls() > 1, "revalidação de fundo não rodou");
    assert_eq!(orch.searches_in_flight(), 0);
}

// ── Miss → coleta → build → HMAC ────────────────────────────────────────────

#[tokio::test]
async fn miss_coleta_build_resposta_com_hmac_e_aviso() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[HASH]);

    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1);
    let url = resposta.streams[0].url.as_deref().expect("url de play");
    assert!(
        url.starts_with(&format!("{ORIGIN}/{SEGMENT}/resolve/{HASH}?w=")),
        "{url}"
    );
    assert_eq!(resposta.cache_max_age, 900);

    // HMAC conferido pelo MESMO verificador da rota `/resolve`.
    let (rest, sig) = url.rsplit_once("sig=").expect("sig na URL");
    let encoded_hint = rest
        .trim_end_matches('&')
        .split("?w=")
        .nth(1)
        .expect("dica w");
    let hint = percent_decode(encoded_hint);
    assert!(hint.contains("\"n\":[\"Filme Teste\"]"), "{hint}");
    assert!(hint.contains("\"y\":2024"), "{hint}");
    assert!(hint.contains("\"i\":\"tt0133093\""), "{hint}");
    assert!(adom_core::verify_resolve(
        HASH,
        "",
        Some(sig),
        &hint,
        "chave-teste"
    ));

    // Entrada do cache: URL RELATIVA e sem host em lugar nenhum.
    let entry = store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .expect("entrada gravada")
        .value;
    let gravado = serde_json::to_string(&entry).expect("json");
    assert!(!gravado.contains("127.0.0.1"), "host vazou: {gravado}");
    assert_eq!(
        entry.streams[0].url.as_deref(),
        Some(format!("/{SEGMENT}/resolve/{HASH}?w={encoded_hint}&sig={sig}").as_str())
    );

    // Lista sem candidato (série) → aviso de lista vazia, nunca 500.
    let mut serie = meta();
    serie.season = Some(1);
    serie.episode = Some(1);
    serie.query = "Filme Teste S01E01".into();
    let vazio = StubCollector::empty();
    let orch = Orchestrator::new(config(), store.clone())
        .with_collector(vazio)
        .with_meta(Arc::new(StubMeta(serie)))
        .with_debrid(Arc::new(StubDebrid { cached: vec![] }));
    let aviso = orch
        .handle(StreamRequest {
            kind: "series".into(),
            id: "tt0903747:1:1".into(),
            encoded: Some(SEGMENT.into()),
            user_agent: None,
            origin: Some(ORIGIN.into()),
            now_ms: Some(1_000_000),
        })
        .await;
    assert_eq!(aviso.streams.len(), 1);
    assert!(aviso.streams[0]
        .name
        .as_deref()
        .unwrap_or("")
        .contains("Nada pronto ainda"));
    assert_eq!(
        aviso.streams[0].external_url.as_deref(),
        Some(format!("{ORIGIN}/{SEGMENT}/configure").as_str())
    );
    assert_eq!(aviso.cache_max_age, 0);
}

#[tokio::test]
async fn erro_de_collector_vira_lista_vazia_com_aviso() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::failing();
    let orch = orchestrator(config(), store.clone(), collector.clone(), &[]);
    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1, "aviso no lugar da lista");
    assert_eq!(resposta.streams[0].name.as_deref(), Some(NOTICE_SEARCHING));
    assert_eq!(resposta.cache_max_age, 0);
    assert_eq!(
        resposta.streams[0].external_url.as_deref(),
        Some(format!("{ORIGIN}/{SEGMENT}/configure").as_str())
    );
    // Nada de cache "vazio confiável".
    assert!(store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .map(|hit| hit.value.streams.is_empty())
        .unwrap_or(true));
}

/// Filme a frio: coleta assenta PARCIAL com balde vazio dentro do reply_ms.
/// Sem aviso virava `{"streams":[],"cacheMaxAge":0}` (Joker/Inception); o
/// retry enchía porque o completion já tinha gravado. Paridade com o corte
/// externo — "ainda procurando", não "não tem".
#[tokio::test]
async fn parcial_vazio_filme_devolve_aviso_reabra() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::empty_partial();
    let orch = orchestrator(config(), store, collector, &[]);
    let resposta = orch.handle(request(1_000_000)).await;
    assert_eq!(resposta.streams.len(), 1, "aviso no lugar de streams:[]");
    assert_eq!(resposta.streams[0].name.as_deref(), Some(NOTICE_SEARCHING));
    assert_eq!(resposta.cache_max_age, 0);
}

// ── Coalescing ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn duas_requisicoes_simultaneas_uma_busca() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::slow(vec![item(HASH)], Duration::from_millis(80));
    let orch = Arc::new(orchestrator(
        config(),
        store.clone(),
        collector.clone(),
        &[HASH],
    ));

    let a = {
        let orch = orch.clone();
        tokio::spawn(async move { orch.handle(request(1_000_000)).await })
    };
    let b = {
        let orch = orch.clone();
        tokio::spawn(async move { orch.handle(request(1_000_000)).await })
    };
    let (a, b) = (a.await.expect("a"), b.await.expect("b"));
    assert_eq!(collector.calls(), 1, "uma única coleta para a mesma chave");
    assert_eq!(a.streams.len(), 1);
    assert_eq!(a.streams[0].url, b.streams[0].url);
    assert!(orch.searches_in_flight() == 0 || orch.searches_in_flight() <= 1);
}

// ── Trace ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn trace_serializado_no_formato_do_stream_trace() {
    let store = Arc::new(MemorySwrStore::new());
    let collector = StubCollector::with(vec![item(HASH)]);
    let orch = orchestrator(config(), store.clone(), collector, &[HASH]);
    let _ = orch.handle(request(1_000_000)).await;

    let entry = store
        .get_with_stale(&entry_key(&orch), 300, 1_000_000)
        .expect("entrada")
        .value;
    let trace = entry.trace.expect("ledger gravado");
    assert_eq!(
        trace.get("startedAt").and_then(Value::as_f64),
        Some(1_000_000.0)
    );
    assert!(trace.get("finishedAt").and_then(Value::as_f64).is_some());
    let stages = trace.get("stages").expect("stages");
    assert_eq!(stages.get("raw").and_then(Value::as_u64), Some(1));
    assert_eq!(stages.get("final").and_then(Value::as_u64), Some(1));
    assert!(stages.get("afterSort").is_some());
    // `searchMeta` também viaja para o `/stream-trace.json` offline.
    assert_eq!(
        entry.search_meta.as_ref().and_then(|m| m.get("year")),
        Some(&json!("2024"))
    );
}
