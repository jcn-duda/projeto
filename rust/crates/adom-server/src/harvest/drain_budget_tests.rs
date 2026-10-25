//! Teto rígido entre consultas Jackett (T1-A1).
//!
//! Jackett falso em loopback: zero rede real, zero gateway. O que se mede é o
//! CORTE — quantos alvos saíram, quantos sobraram sem consulta e quantas
//! requisições o servidor viu.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use adom_harvest::{HarvestEntry, HarvestMediaType};
use adom_search::orchestrator::{SearchMeta, SharedIndex};
use adom_sources::{
    CinemetaConfig, JackettClient, JackettConfig, MetaSources, SourcesConfig, TmdbConfig,
};
use adom_store::{NativeReleaseIndex, ReleaseIndexStore};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde_json::json;

use super::NetworkDrain;

const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW: i64 = 1_700_000_000_000;
const TITLE: &str = "Coringa 2019 1080p Dublado";

/// Jackett falso: conta as consultas e responde um item por alvo.
#[derive(Clone)]
struct FakeJackett {
    hits: Arc<AtomicUsize>,
}

impl FakeJackett {
    async fn start() -> (Self, String) {
        let api = Self {
            hits: Arc::new(AtomicUsize::new(0)),
        };
        let app = Router::new()
            .route("/api/v2.0/indexers/{indexer}/results", get(results))
            .with_state(api.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (api, format!("http://{addr}"))
    }

    fn hits(&self) -> usize {
        self.hits.load(Ordering::SeqCst)
    }
}

async fn results(State(api): State<FakeJackett>, Path(indexer): Path<String>) -> Response {
    api.hits.fetch_add(1, Ordering::SeqCst);
    (
        StatusCode::OK,
        axum::Json(json!({
            "Results": [{
                "Title": TITLE,
                "MagnetUri": format!("magnet:?xt=urn:btih:{HASH}"),
                "InfoHash": HASH,
                "Seeders": 5,
                "Size": 1234,
                "Tracker": indexer,
                "TrackerId": indexer,
            }],
            "Indexers": [{ "Status": 2, "Error": null }]
        })),
    )
        .into_response()
}

fn jackett_config(base: &str, indexers: &[String]) -> JackettConfig {
    JackettConfig {
        url: base.trim_end_matches('/').into(),
        api_key: "k".into(),
        indexers: indexers.to_vec(),
        pt_br_indexers: Vec::new(),
        breaker_enabled: false,
        indexer_timeout_ms: 1_500,
        br_indexer_timeout_ms: 1_500,
        ..JackettConfig::default()
    }
}

/// Metadados não entram neste teste; o `for_test` só exige a fonte montada.
fn sources(base: &str) -> SourcesConfig {
    SourcesConfig {
        user_agent: "adom-harvest-budget/1.0".into(),
        cinemeta: CinemetaConfig {
            base_url: base.into(),
            request_timeout_ms: 1_500,
            ..CinemetaConfig::default()
        },
        tmdb: TmdbConfig {
            api_key: String::new(),
            request_timeout_ms: 1_500,
            ..TmdbConfig::default()
        },
    }
}

fn entry() -> HarvestEntry {
    HarvestEntry {
        imdb_id: "tt7286456".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "miss".into(),
        enqueued_at: NOW,
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

fn meta() -> SearchMeta {
    SearchMeta {
        query: "Coringa 2019".into(),
        pt_query: Some("Coringa 2019".into()),
        name: "Coringa".into(),
        ..SearchMeta::default()
    }
}

fn drain(base: &str, indexers: &[String], delay_ms: u64) -> NetworkDrain {
    let index: SharedIndex = Arc::new(NativeReleaseIndex::from_store(
        ReleaseIndexStore::open_memory().expect("índice"),
    ));
    NetworkDrain::for_test(
        MetaSources::with_memory_store(sources(base)).expect("metadados"),
        JackettClient::new(jackett_config(base, indexers)).expect("jackett"),
        jackett_config(base, indexers),
        index,
        None,
        None,
        indexers.to_vec(),
        Vec::new(),
        delay_ms,
    )
}

fn ten_targets() -> Vec<String> {
    (0..10).map(|n| format!("alvo{n}")).collect()
}

#[tokio::test]
async fn teto_rigido_corta_entre_alvos_jackett() {
    let (api, base) = FakeJackett::start().await;
    let indexers = ten_targets();
    let drain = drain(&base, &indexers, 0);
    let jackett = JackettClient::new(jackett_config(&base, &indexers)).expect("jackett");

    // Balde em 119/120: sobra UMA consulta para dez alvos.
    let batch = drain
        .search_jackett_with_budget(&jackett, &entry(), &meta(), 1)
        .await;

    assert_eq!(batch.attempted, 1, "o teto corta antes do segundo alvo");
    assert_eq!(batch.answered, 1);
    assert_eq!(batch.remaining_targets, 9, "nove alvos sem consulta");
    assert_eq!(api.hits(), 1, "uma consulta de rede, não dez");
    assert_eq!(batch.items.len(), 1, "o que já saiu continua valendo");
}

#[tokio::test]
async fn orcamento_inteiro_percorre_todos_os_alvos() {
    let (api, base) = FakeJackett::start().await;
    let indexers = ten_targets();
    let drain = drain(&base, &indexers, 0);
    let jackett = JackettClient::new(jackett_config(&base, &indexers)).expect("jackett");

    let batch = drain
        .search_jackett_with_budget(&jackett, &entry(), &meta(), 120)
        .await;

    assert_eq!(batch.attempted, 10);
    assert_eq!(batch.answered, 10);
    assert_eq!(batch.remaining_targets, 0, "sem corte nada sobra");
    assert_eq!(api.hits(), 10);
    assert_eq!(batch.items.len(), 10);
}
