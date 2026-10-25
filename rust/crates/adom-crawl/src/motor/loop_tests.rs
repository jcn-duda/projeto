//! Testes do tick do motor (C4).
//!
//! Exercitam o loop REAL: `crawl.db` temporário em disco, Node falso respondendo
//! as rotas que o motor usa (o POST de resultado NÃO deve mais acontecer) e
//! engines/ingestões injetadas pelas costuras [`PageEngine`]/[`PageIngest`].
//! Nada aqui depende do parser — é justamente o que fica provado.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::State;
use axum::routing::{get, post};
use axum::Json;

use super::ingest::test_support::FakeIngest;
use super::r#loop::{CrawlMotor, TickOutcome};
use super::types::{
    error_work, now_ms, CrawlResultStatus, CrawlWorkResult, MotorConfig, PageEngine, PageFuture,
    PageOutcome,
};
use crate::store::ops::{CrawlStore, UrlRow};

/// Engine que sempre entrega uma página `done` (ou um erro, em `falha`).
struct EngineFake {
    falha: bool,
}

impl EngineFake {
    fn pronta() -> Arc<dyn PageEngine> {
        Arc::new(Self { falha: false })
    }
    fn com_erro() -> Arc<dyn PageEngine> {
        Arc::new(Self { falha: true })
    }
}

impl PageEngine for EngineFake {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        if self.falha {
            // Fetch tentado e perdido: a engine não sabe o custo, então vale o
            // piso declarado por `error_work` (1 requisição).
            let work = error_work(row, "boom de rede simulado");
            return Box::pin(async move { PageOutcome::Work(Box::new(work)) });
        }
        let mut work = CrawlWorkResult::parser_pending(row);
        work.status = CrawlResultStatus::Done;
        work.error = String::new();
        work.imdb = Some("tt0000001".to_string());
        // Custo declarado de 2 requisições: é o que o teto por hora deve cobrar.
        work.request_cost = 2;
        Box::pin(async move { PageOutcome::Work(Box::new(work)) })
    }
}

/// Config de teste apontando para um banco e um Node específicos.
fn config(db_path: &str, node_url: &str) -> MotorConfig {
    MotorConfig {
        db_path: db_path.to_string(),
        node_url: node_url.to_string(),
        admin_token: "token-de-teste".to_string(),
        idle_window_ms: 60_000,
        max_per_hour: 100,
        ..Default::default()
    }
}

/// Linha due de filme na fila (o `upsert` grava o `site` do argumento).
fn linha(key: &str) -> UrlRow {
    UrlRow {
        site: SITE.to_string(),
        url: format!("https://exemplo.tv/{key}"),
        url_key: key.to_string(),
        kind: "movie".to_string(),
        status: "pending".to_string(),
        lastmod: String::new(),
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

const SITE: &str = "site-teste";

/// Site real do registro de perfis — o recovery de boot só percorre ids conhecidos.
const REAL: &str = "nerdfilmes";

/// Semeia uma URL na fila e devolve o caminho do banco.
fn seed(db_path: &str, row: UrlRow) {
    let db = CrawlStore::open(db_path).expect("abrir para semear");
    db.migrate().expect("migrar");
    db.upsert_urls(SITE, &[row]).expect("semear");
}

/// Lê `(status, tries, next_at)` de uma linha direto no arquivo.
fn ler_linha(db_path: &str, key: &str) -> (String, u32, i64) {
    let db = CrawlStore::open(db_path).expect("abrir para ler");
    db.conn()
        .query_row(
            "SELECT status, tries, next_at FROM crawl_url WHERE url_key = ?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("linha presente")
}

/// Node falso: responde o freio de tráfego e conta POSTs de resultado (a
/// contagem tem de ficar em ZERO: a página agora é ingerida no processo).
async fn node_falso(posts: Arc<AtomicUsize>) -> String {
    let app = axum::Router::new()
        .route("/internal/activity", get(activity))
        .route("/internal/crawl-result", post(crawl_result))
        .with_state(posts);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do node falso");
    let addr = listener.local_addr().expect("addr do node falso");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("[teste] node falso caiu: {e}");
        }
    });
    format!("http://{addr}")
}

async fn activity() -> Json<serde_json::Value> {
    // `recent: false` = app ocioso, o motor pode raspando.
    Json(serde_json::json!({ "recent": false }))
}

async fn crawl_result(
    State(posts): State<Arc<AtomicUsize>>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    posts.fetch_add(1, Ordering::SeqCst);
    Json(serde_json::json!({ "ok": true, "kept": 0, "added": 0 }))
}

#[tokio::test]
async fn tick_sem_parser_nao_reivindica_nenhuma_url() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-1"));

    let node = node_falso(Arc::new(AtomicUsize::new(0))).await;
    let motor = CrawlMotor::new(config(caminho, &node));
    let outcome = motor.tick_once().await.expect("tick");

    assert_eq!(outcome, TickOutcome::Skipped("parser-pendente"));
    // A fila sobrevive intacta: nada foi reivindicado nem queimado.
    let (status, tries, _) = ler_linha(caminho, "filme-1");
    assert_eq!(status, "pending");
    assert_eq!(tries, 0);
    assert!(!motor.parser_ready());
}

#[tokio::test]
async fn tick_sem_ingestao_nao_reivindica_nenhuma_url() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-0"));

    let node = node_falso(Arc::new(AtomicUsize::new(0))).await;
    let motor = CrawlMotor::new(config(caminho, &node)).with_page_engine(EngineFake::pronta());
    let outcome = motor.tick_once().await.expect("tick");

    assert_eq!(outcome, TickOutcome::Skipped("ingest-pendente"));
    let (status, tries, _) = ler_linha(caminho, "filme-0");
    assert_eq!(status, "pending", "sem quem grave, a fila não é tocada");
    assert_eq!(tries, 0);
}

#[tokio::test]
async fn tick_entrega_marca_done_e_cobra_o_custo_real() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-2"));

    let posts = Arc::new(AtomicUsize::new(0));
    let node = node_falso(posts.clone()).await;
    let ingest = Arc::new(FakeIngest::delivered());
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(EngineFake::pronta())
        .with_ingest(ingest.clone());

    let outcome = motor.tick_once().await.expect("tick");
    assert_eq!(
        outcome,
        TickOutcome::Processed {
            claimed: 1,
            delivered: 1
        }
    );
    assert_eq!(ingest.calls(), 1, "a página foi ingerida UMA vez");
    assert!(ingest.abort_present(), "o passo entregou a cerca do prazo");
    assert!(
        !ingest.abort_at_call(),
        "dentro do prazo a cerca está aberta"
    );
    assert_eq!(
        posts.load(Ordering::SeqCst),
        0,
        "o POST /internal/crawl-result não acontece mais"
    );

    let (status, tries, next_at) = ler_linha(caminho, "filme-2");
    assert_eq!(status, "done");
    assert_eq!(tries, 1);
    assert_eq!(next_at, 0, "terminal não fica na fila de retry");
    // Custo REAL cobrado no teto (2 requisições), não "1 por página".
    assert_eq!(motor.status().await.pages_this_hour, 2);
}

/// Roteamento por lane: o LOTE PARALELO não reivindica site own_pace (Mico).
/// Quem o trabalha é a lane dedicada (`own_pace_once`), fora do teto e das
/// vagas; sem lane ligada a fila do Mico fica intacta, sem queimar tentativa.
#[tokio::test]
async fn tick_nao_reivindica_own_pace_no_lote_paralelo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    // Semeia a fila do Mico com o id real (o critério é o perfil de rede).
    let mut mico = linha("tt0000001");
    mico.site = "mico".to_string();
    mico.url = "https://mico-leao-dublado-apiv-2.vercel.app/crawl/movie/tt0000001/".to_string();
    {
        let db_semente = CrawlStore::open(caminho).expect("abrir para semear");
        db_semente.migrate().expect("migrar");
        db_semente.upsert_urls("mico", &[mico]).expect("semear");
    }

    let posts = Arc::new(AtomicUsize::new(0));
    let node = node_falso(posts.clone()).await;
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(EngineFake::pronta())
        .with_ingest(Arc::new(FakeIngest::delivered()));

    let outcome = motor.tick_once().await.expect("tick");
    assert_eq!(outcome, TickOutcome::Skipped("sem-fila"));
    assert!(
        motor.own_pace_once().await.expect("own_pace").is_none(),
        "sem lane ligada não há passo próprio"
    );
    let (status, tries, _) = ler_linha(caminho, "tt0000001");
    assert_eq!(status, "pending", "fila do Mico espera a lane dedicada");
    assert_eq!(tries, 0, "nenhuma tentativa queimada");
    assert_eq!(posts.load(Ordering::SeqCst), 0, "nada entregue ao Node");
}

#[tokio::test]
async fn tries_esgotados_viram_erro_terminal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let mut cansada = linha("filme-4");
    cansada.tries = 2; // max_tries default = 3 → esta é a última tentativa
    seed(caminho, cansada);

    let node = node_falso(Arc::new(AtomicUsize::new(0))).await;
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(EngineFake::com_erro())
        .with_ingest(Arc::new(FakeIngest::failing()));
    motor.tick_once().await.expect("tick");

    let (status, tries, next_at) = ler_linha(caminho, "filme-4");
    assert_eq!(
        status, "error",
        "esgotou: terminal, reprocessável pelo painel"
    );
    assert_eq!(tries, 3);
    assert_eq!(next_at, 0);
}

/// Espera a linha sair de `inflight` (recovery do boot), cedendo a thread.
async fn esperar_fila(caminho: &str, key: &str) {
    loop {
        if ler_linha(caminho, key).0 == "pending" {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Exercita o caminho real do binário: `run()` abre o banco, recupera o que
/// ficou preso em `inflight` e para limpo no `stop()` — sem tocar na rede.
#[tokio::test]
async fn run_abre_banco_recupera_inflight_e_para_no_stop() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();

    // URL presa em `inflight` por uma execução anterior que morreu no meio.
    let init = CrawlStore::open(caminho).expect("abrir para semear");
    init.migrate().expect("migrar");
    let mut presa = linha("filme-6");
    presa.site = REAL.to_string();
    presa.status = "inflight".to_string();
    init.upsert_urls(REAL, &[presa]).expect("semear");
    drop(init);

    // Teto zero: o loop entra, faz o boot e fica nos freios — nada é reivindicado.
    let mut cfg = config(caminho, "http://127.0.0.1:1");
    cfg.max_per_hour = 0;
    let motor = Arc::new(CrawlMotor::new(cfg));
    let handle = {
        let motor = motor.clone();
        tokio::spawn(async move { motor.run().await })
    };

    let recuperada = tokio::time::timeout(Duration::from_secs(5), esperar_fila(caminho, "filme-6"))
        .await
        .is_ok();
    motor.stop().await;
    handle
        .await
        .expect("task viva")
        .expect("run sem erro fatal");
    assert!(recuperada, "inflight volta para a fila no boot");
    assert!(!motor.status().await.active, "stop() encerrou o loop");
}

#[tokio::test]
async fn modo_degradado_entrega_placeholder_sem_parser() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-5"));

    let posts = Arc::new(AtomicUsize::new(0));
    let node = node_falso(posts.clone()).await;
    let mut cfg = config(caminho, &node);
    cfg.degraded_write = true; // fuga explícita: banco de diagnóstico
    let motor = CrawlMotor::new(cfg).with_ingest(Arc::new(FakeIngest::delivered()));

    let outcome = motor.tick_once().await.expect("tick");
    assert_eq!(
        outcome,
        TickOutcome::Processed {
            claimed: 1,
            delivered: 1
        }
    );
    assert_eq!(posts.load(Ordering::SeqCst), 0, "nada é postado ao Node");
    // O placeholder é um erro: a linha fica em retry, nunca `done` inventado.
    let (status, _, next_at) = ler_linha(caminho, "filme-5");
    assert_eq!(status, "pending");
    assert!(next_at > now_ms());
}

// Testes do caminho de pendência de portão e do efeito da ingestão: arquivos
// próprios (catraca de 400 linhas); como módulos filhos, enxergam os helpers
// daqui via `super::*`.
#[path = "loop_gate_tests.rs"]
mod gate_pending_tests;

#[path = "loop_ingest_tests.rs"]
mod ingest_tests;
