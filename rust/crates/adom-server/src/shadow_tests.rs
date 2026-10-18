use super::*;
use std::sync::Arc;

use adom_search::orchestrator::{NoDebridFactory, OrchestratorConfig};
use adom_search::MemorySwrStore;

fn item_ih(hash: &str) -> StreamItem {
    StreamItem {
        info_hash: Some(hash.to_string()),
        ..StreamItem::default()
    }
}

fn item_url(url: &str) -> StreamItem {
    StreamItem {
        url: Some(url.to_string()),
        ..StreamItem::default()
    }
}

#[test]
fn mascara_host_sig_e_config() {
    let raw = "https://powermovie.net/eyJ4IjoxfQ/resolve/abc123def?sig=DEADBEEF&x=1";
    assert_eq!(
        mask_url(raw, Some("eyJ4IjoxfQ")),
        "/{{config}}/resolve/abc123def?sig={{sig}}&x=1"
    );
}

#[test]
fn identidade_ignora_ordem_e_host() {
    let a = vec![
        item_url("https://a.test/resolve/AAAA?sig=1"),
        item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    ];
    let b = vec![
        item_ih("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
        item_url("http://outro.host/resolve/AAAA?sig=ZZZ"),
    ];
    assert_eq!(identity_set(&a, None), identity_set(&b, None));
    assert_eq!(
        divergent_item_count(&identity_set(&a, None), &identity_set(&b, None)),
        0
    );
}

#[test]
fn divergence_conta_itens_da_diferenca_simetrica() {
    let metrics = ShadowMetrics::new();
    let node = StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    };
    let rust = StreamResponse {
        streams: vec![item_ih("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")],
        cache_max_age: 0,
    };
    record_comparison(&node, &rust, None, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 2);
}

#[test]
fn paridade_nao_marca_divergence() {
    let metrics = ShadowMetrics::new();
    let body = StreamResponse {
        streams: vec![item_ih("cccccccccccccccccccccccccccccccccccccccc")],
        cache_max_age: 900,
    };
    record_comparison(&body, &body, None, &metrics);
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_ITEMS), 0);
}

#[test]
fn shadow_orchestrator_e_compare_only_sem_debrid() {
    let orch = crate::stream::build_shadow_orchestrator();
    assert!(orch.shadow_mode(), "sombra exige shadow_mode");
}

#[tokio::test]
async fn observe_sem_remount_ainda_pula() {
    let metrics = ShadowMetrics::new();
    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        ShadowRequest {
            path: "/stream/movie/tt0133093.json".into(),
            user_agent: Some("Stremio/1.6".into()),
            origin: None,
        },
        metrics.clone(),
        None,
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(ERROR), 0);
}

#[tokio::test]
async fn observe_com_remount_shadow_sobe_compared_sem_debrid() {
    let metrics = ShadowMetrics::new();
    // Collector default falha → lista/aviso; sem AdapterDebridFactory.
    let orch = Orchestrator::new(
        OrchestratorConfig::default(),
        Arc::new(MemorySwrStore::new()),
    )
    .with_shadow_mode(true)
    .with_debrid(Arc::new(NoDebridFactory));
    assert!(orch.shadow_mode());

    let body = serde_json::to_vec(&StreamResponse {
        streams: vec![item_ih("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
        cache_max_age: 0,
    })
    .unwrap();
    observe_node_response(
        StatusCode::OK,
        Bytes::from(body),
        ShadowRequest {
            path: "/stream/movie/tt0133093.json".into(),
            user_agent: Some("Stremio/1.6".into()),
            origin: None,
        },
        metrics.clone(),
        Some(orch),
    )
    .await;
    assert_eq!(metrics.get(COMPARED), 1);
    // Corpos diferem (Node com ih vs aviso/vazio do stub) → divergence ok;
    // o que importa: compared sobe e o caminho não panica sem debrid.
    assert_eq!(metrics.get(TIMEOUT), 0);
    assert_eq!(metrics.get(ERROR), 0);
}
