//! Infra de teste do executor de portões: crawl.db temporário, ingestão
//! falsa (captura a página que iria ao acervo — a MESMA porta `PageIngest` do
//! motor), Node falso só com `/internal/activity` (sem `/internal/crawl-result`,
//! como em produção) e resolver/sonda falsos com contagem de pagamentos.
//! Separado do `gate_tests.rs` pela catraca de 400 linhas; itens `pub(super)`
//! para o irmão `tests` consumir.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use axum::routing::get;
use axum::{Json, Router};

use crate::ingest::{IngestOptions, PageReport};
use crate::motor::types::{CrawlWorkResult, MotorConfig};
use crate::motor::{IngestFuture, PageIngest};
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

/// Páginas que a ingestão falsa recebeu, em JSON (o que iria ao acervo).
pub(super) type Entregues = Arc<StdMutex<Vec<serde_json::Value>>>;

/// Quando a ingestão falsa recusa (relatório `retryable`, como o TMDB fora).
#[derive(Clone, Copy)]
pub(super) enum Recusa {
    Nunca,
    Primeira,
    Sempre,
}

/// Ingestão falsa: captura cada página e responde conforme a `Recusa`.
pub(super) struct IngestFake {
    pub(super) entregues: Entregues,
    recusa: Recusa,
    chamadas: AtomicUsize,
}

impl IngestFake {
    pub(super) fn novo(recusa: Recusa) -> Arc<Self> {
        Arc::new(Self {
            entregues: Arc::new(StdMutex::new(Vec::new())),
            recusa,
            chamadas: AtomicUsize::new(0),
        })
    }

    pub(super) fn chamadas(&self) -> usize {
        self.chamadas.load(Ordering::SeqCst)
    }
}

impl PageIngest for IngestFake {
    fn apply_page<'a>(
        &'a self,
        _site: &'a str,
        page: &'a CrawlWorkResult,
        _now_ms: i64,
        _options: IngestOptions<'a>,
    ) -> IngestFuture<'a> {
        let n = self.chamadas.fetch_add(1, Ordering::SeqCst);
        let json = serde_json::to_value(page).expect("página serializável");
        self.entregues.lock().unwrap().push(json);
        let recusa = match self.recusa {
            Recusa::Nunca => false,
            Recusa::Primeira => n == 0,
            Recusa::Sempre => true,
        };
        let report = if recusa {
            PageReport {
                reason: Some("tmdb-indisponivel".to_string()),
                retryable: true,
                ..PageReport::default()
            }
        } else {
            PageReport::default()
        };
        Box::pin(async move { Ok(report) })
    }
}

/// A ingestão falsa na forma que o executor recebe.
pub(super) fn plug(ingest: &Arc<IngestFake>) -> Option<Arc<dyn PageIngest>> {
    Some(ingest.clone())
}

/// Node falso: SÓ o freio de tráfego (`recent`). Não há
/// `/internal/crawl-result` — uma entrega por HTTP cairia em 404, como em
/// produção depois da T3-L3.
pub(super) async fn node_falso(recent: bool) -> String {
    let app = Router::new().route(
        "/internal/activity",
        get(move || async move { Json(serde_json::json!({ "recent": recent })) }),
    );
    bind_node(app).await
}

/// A fila de portões ficou vazia (pendência resolvida)?
pub(super) fn db_gate_vazia(caminho: &str) -> bool {
    let db = CrawlStore::open(caminho).expect("reabrir");
    db.take_gate_batch(10).expect("lote").is_empty()
}

/// Vence o recuo de uma linha (o relógio do teste não espera minutos).
pub(super) fn vencer_recuo(caminho: &str, key: &str) {
    let db = CrawlStore::open(caminho).expect("abrir para vencer");
    db.conn()
        .execute("UPDATE crawl_url SET next_at = 0 WHERE url_key = ?1", [key])
        .expect("vencer recuo");
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
    ingest: Option<Arc<dyn PageIngest>>,
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
    let ex = GateExecutor::new(
        cfg,
        tuning,
        store,
        Arc::new(SidecarHttpClient::new(
            node.to_string(),
            "token-de-teste".to_string(),
        )),
        resolver,
        flare,
    );
    match ingest {
        Some(ingest) => ex.with_ingest(ingest),
        None => ex,
    }
}

pub(super) fn falso(chamadas: Arc<AtomicUsize>, falha: bool) -> Arc<ResolverFake> {
    Arc::new(ResolverFake { chamadas, falha })
}
