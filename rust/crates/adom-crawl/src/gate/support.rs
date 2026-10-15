//! Infra de teste do executor de portões: crawl.db temporário, Node falso
//! (captura do `POST /internal/crawl-result` — a MESMA via em que o acervo é
//! gravado) e resolver/sonda falsos com contagem de pagamentos. Separado do
//! `gate_tests.rs` pela catraca de 400 linhas; itens `pub(super)` para o
//! irmão `tests` consumir.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::motor::types::MotorConfig;
use crate::sidecar::http_client::SidecarHttpClient;
use crate::store::ops::{CrawlStore, GatePendingRecord, UrlRow};

use super::{FlareProbe, GateExecutor, GateExecutorConfig, GateFuture, GateResolver};

pub(super) const SITE: &str = "site-teste";
pub(super) const GATE: &str = "https://bludvfilmes1.xyz/gate/go/0646028353024d92?p=60609";
pub(super) const MAGNET: &str =
    "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=Filme.2024.1080p.DUAL";

/// Linha due de filme na fila (mesma forma dos testes do motor).
pub(super) fn linha(key: &str) -> UrlRow {
    UrlRow {
        site: SITE.to_string(),
        url: format!("https://bludv.com/filmes/{key}/"),
        url_key: key.to_string(),
        kind: "movie".to_string(),
        status: "pending".to_string(),
        lastmod: String::new(),
        imdb: Some("tt1111111".to_string()),
        tries: 0,
        next_at: 0,
        checked_at: 0,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 0,
    }
}

/// Semeador: URL na fila + pendência de portão marcada (o caminho que o motor
/// grava quando o parser devolve `gate-pending`).
pub(super) fn semear_gate(caminho: &str, key: &str, gate: &str) {
    let db = CrawlStore::open(caminho).expect("abrir para semear");
    db.migrate().expect("migrar");
    db.upsert_urls(SITE, &[linha(key)]).expect("semear");
    db.mark_gate_pending(
        SITE,
        key,
        &GatePendingRecord {
            gate: gate.to_string(),
            title: "Filme 2024 1080p Dual".to_string(),
            year: 2024,
            imdb: "tt1111111".to_string(),
            kind: "movie".to_string(),
        },
    )
    .expect("marcar pendência");
}

/// Lê `(status, tries, next_at)` de uma linha direto no arquivo.
pub(super) fn ler_linha(caminho: &str, key: &str) -> (String, u32, i64) {
    let db = CrawlStore::open(caminho).expect("abrir para ler");
    db.conn()
        .query_row(
            "SELECT status, tries, next_at FROM crawl_url WHERE url_key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("linha presente")
}

/// Resolver falso: conta pagamentos e falha a pedido. Tipo público ao pai
/// (gate_tests.rs) porque atravessa assinaturas pub(super) dos helpers.
pub(super) struct ResolverFake {
    chamadas: Arc<AtomicUsize>,
    falha: bool,
}

impl GateResolver for ResolverFake {
    fn resolve<'a>(&'a self, gate: &'a str, post: &'a str) -> GateFuture<'a> {
        let chamadas = self.chamadas.clone();
        let falha = self.falha;
        let gate = gate.to_string();
        let post = post.to_string();
        Box::pin(async move {
            chamadas.fetch_add(1, Ordering::SeqCst);
            if falha {
                // Mesmo corpo reservado do resolver real (503 + gate_pending).
                return Err("pendente no resolver".to_string());
            }
            Ok(format!("{MAGNET}&g={gate}&post={post}"))
        })
    }
}

/// Sonda Flare falso (livre/ocupado a pedido do teste).
pub(super) struct FlareFake {
    pub(super) ocupado: bool,
}

impl FlareProbe for FlareFake {
    fn flare_busy(&self) -> bool {
        self.ocupado
    }
}

/// Entregas capturadas do Node falso.
pub(super) type Entregues = Arc<StdMutex<Vec<serde_json::Value>>>;

/// Handler do POST /internal/crawl-result: captura e responde ok.
async fn entrega(
    State(entregues): State<Entregues>,
    Json(v): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    entregues.lock().unwrap().push(v);
    Json(serde_json::json!({ "ok": true }))
}

/// Handler que RECUSA a primeira entrega (500) e aceita as seguintes —
/// para provar o re-pagamento evitado pelo dedupe durável.
async fn entrega_falha_primeira(
    State((entregues, falhas)): State<(Entregues, Arc<AtomicUsize>)>,
    Json(v): Json<serde_json::Value>,
) -> Response {
    entregues.lock().unwrap().push(v);
    if falhas.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({ "ok": true }))).into_response()
}

/// Node falso: freio de tráfego (`recent`) + captura de entregas.
pub(super) async fn node_falso(entregues: Entregues, recent: bool) -> String {
    let app = Router::new()
        .route(
            "/internal/activity",
            get(move || async move { Json(serde_json::json!({ "recent": recent })) }),
        )
        .route("/internal/crawl-result", post(entrega))
        .with_state(entregues);
    bind_node(app).await
}

/// Node falso que recusa a primeira entrega (dedupe durável).
pub(super) async fn node_recusa_primeira(entregues: Entregues) -> String {
    let app = Router::new()
        .route(
            "/internal/activity",
            get(|| async { Json(serde_json::json!({ "recent": false })) }),
        )
        .route(
            "/internal/crawl-result",
            post(entrega_falha_primeira).get(|| async { "nao-usado" }),
        )
        .with_state((entregues, Arc::new(AtomicUsize::new(0))));
    bind_node(app).await
}

async fn bind_node(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do node falso");
    let addr = listener.local_addr().expect("addr do node falso");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

/// Executor de teste apontando para o banco e o Node do teste.
pub(super) fn executor(
    caminho: &str,
    node: &str,
    resolver: Arc<dyn GateResolver>,
    flare: Arc<dyn FlareProbe>,
    cap: u32,
) -> GateExecutor {
    let store = Arc::new(StdMutex::new(CrawlStore::open(caminho).expect("abrir")));
    let cfg = GateExecutorConfig {
        hourly_cap: cap,
        node_url: node.to_string(),
        admin_token: "token-de-teste".to_string(),
        ..Default::default()
    };
    // Régua do motor para o from_work (defaults: max_tries 3 etc.).
    let tuning = MotorConfig {
        node_url: node.to_string(),
        admin_token: "token-de-teste".to_string(),
        ..Default::default()
    };
    GateExecutor::new(
        cfg,
        tuning,
        store,
        Arc::new(SidecarHttpClient::new(
            node.to_string(),
            "token-de-teste".to_string(),
        )),
        resolver,
        flare,
    )
}

pub(super) fn falso(chamadas: Arc<AtomicUsize>, falha: bool) -> Arc<ResolverFake> {
    Arc::new(ResolverFake { chamadas, falha })
}
