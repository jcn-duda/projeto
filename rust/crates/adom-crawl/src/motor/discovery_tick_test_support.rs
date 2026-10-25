//! Harness compartilhado dos testes da descoberta dentro do tick (fase 6).
//!
//! A costura não cabe num arquivo só — a catraca de 400 linhas vale para teste
//! também. O dublê, o motor e o node falso moram aqui; os dois arquivos de caso
//! (`discovery_tick_tests` e `discovery_tick_state_tests`) trazem só os testes.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::routing::get;
use axum::Json;

use crate::discovery::{
    DiscoveredUrl, DiscoveryFuture, DiscoveryOptions, DiscoveryReport, SiteDiscovery,
};
use crate::motor::r#loop::CrawlMotor;
use crate::motor::types::MotorConfig;
use crate::sitemap::CrawlPageKind;

/// Primeiro site do rodízio (`discoverable_sites()` começa nos de sitemap).
pub(super) const PRIMEIRO: &str = "vacatorrent";

#[derive(Clone)]
pub(super) struct Call {
    pub(super) site: String,
    pub(super) opts: DiscoveryOptions,
}

/// Descoberta de dublê: entrega os relatórios na ordem do roteiro e, esgotado
/// ele, uma rodada vazia e completa.
pub(super) struct FakeDiscovery {
    script: Mutex<VecDeque<Result<DiscoveryReport, String>>>,
    calls: Mutex<Vec<Call>>,
    /// Chaves de `crawl_state` que a trilha pede ANTES de rodar. Vazio para a
    /// trilha de sitemap, que corta por data (`next_cursor`) e não por estado.
    state_keys: Vec<String>,
}

impl FakeDiscovery {
    pub(super) fn new(script: Vec<Result<DiscoveryReport, String>>) -> Arc<Self> {
        Self::reading(script, Vec::new())
    }

    /// Dublê que se declara dependente de estado durável (a listagem).
    pub(super) fn reading(
        script: Vec<Result<DiscoveryReport, String>>,
        state_keys: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
            state_keys,
        })
    }

    pub(super) fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl SiteDiscovery for FakeDiscovery {
    fn state_keys(&self, _site: &str) -> Vec<String> {
        self.state_keys.clone()
    }

    fn discover<'a>(&'a self, site: &'a str, opts: &'a DiscoveryOptions) -> DiscoveryFuture<'a> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(Call {
                site: site.to_string(),
                opts: opts.clone(),
            });
            let next = { self.script.lock().unwrap().pop_front() };
            next.unwrap_or_else(|| Ok(DiscoveryReport::empty_complete()))
        })
    }
}

pub(super) fn discovered(path: &str, lastmod: &str, kind: CrawlPageKind) -> DiscoveredUrl {
    DiscoveredUrl {
        url: format!("https://bludvfilmes.xyz{path}"),
        lastmod: lastmod.to_string(),
        kind,
    }
}

/// Rodada PARCIAL de kind misto: filme completo, série com um arquivo caído.
pub(super) fn report_parcial() -> DiscoveryReport {
    DiscoveryReport {
        urls: vec![
            discovered("/a/", "2026-10-01T00:00:00Z", CrawlPageKind::Movie),
            discovered("/b/", "2026-10-03T00:00:00Z", CrawlPageKind::TvShow),
        ],
        complete: false,
        complete_movie: true,
        complete_tv_show: false,
        failures: vec!["post-sitemap2.xml: HTTP 404".to_string()],
        request_cost: 3,
        state_writes: Vec::new(),
    }
}

pub(super) fn config(db: &str, node: &str) -> MotorConfig {
    MotorConfig {
        db_path: db.to_string(),
        node_url: node.to_string(),
        admin_token: "token-de-teste".to_string(),
        max_parallel: 1,
        retry_base_ms: 5_000,
        discovery_interval_ms: 3_600_000,
        ..Default::default()
    }
}

pub(super) fn motor(db: &str, node: &str, fake: Arc<FakeDiscovery>) -> CrawlMotor {
    let discovery: Arc<dyn SiteDiscovery> = fake;
    CrawlMotor::new(config(db, node)).with_discovery(discovery)
}

/// Node falso: freio de tráfego com `recent` fixo (o tick consulta antes de
/// reivindicar).
pub(super) async fn node(recent: bool) -> String {
    let app = axum::Router::new().route(
        "/internal/activity",
        get(move || async move { Json(serde_json::json!({ "recent": recent })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do node falso");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

pub(super) fn db_temp() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().expect("utf8").to_string();
    (dir, caminho)
}
