//! Testes do tick de DESCOBERTA no motor (fase 6).
//!
//! Sem esta costura o motor drenava a fila e parava em `sem-fila` para sempre —
//! a fila `crawl_url` é ALIMENTADA pela descoberta. O contrato medido aqui:
//! um site por tick com rodízio, relógio por site (completa = intervalo cheio,
//! parcial/erro = retry curto), custo no MESMO teto por hora das páginas e
//! cursor durável que só anda com a completude DAQUELE kind.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::routing::get;
use axum::Json;

use crate::discovery::{
    cursor_key, discoverable_sites, DiscoveredUrl, DiscoveryFuture, DiscoveryOptions,
    DiscoveryReport, SiteDiscovery,
};
use crate::motor::ingest::test_support::FakeIngest;
use crate::motor::r#loop::{CrawlMotor, TickOutcome};
use crate::motor::types::{now_ms, MotorConfig, PageEngine, PageFuture, PageOutcome};
use crate::sitemap::CrawlPageKind;
use crate::store::ops::{CrawlStore, UrlRow};

const PRIMEIRO: &str = "vacatorrent";

#[derive(Clone)]
struct Call {
    site: String,
    opts: DiscoveryOptions,
}

/// Descoberta de dublê: entrega os relatórios na ordem do roteiro e, esgotado
/// ele, uma rodada vazia e completa.
struct FakeDiscovery {
    script: Mutex<VecDeque<Result<DiscoveryReport, String>>>,
    calls: Mutex<Vec<Call>>,
}

impl FakeDiscovery {
    fn new(script: Vec<Result<DiscoveryReport, String>>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script.into()),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }
}

impl SiteDiscovery for FakeDiscovery {
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

fn discovered(path: &str, lastmod: &str, kind: CrawlPageKind) -> DiscoveredUrl {
    DiscoveredUrl {
        url: format!("https://bludvfilmes.xyz{path}"),
        lastmod: lastmod.to_string(),
        kind,
    }
}

/// Rodada PARCIAL de kind misto: filme completo, série com um arquivo caído.
fn report_parcial() -> DiscoveryReport {
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
    }
}

fn config(db: &str, node: &str) -> MotorConfig {
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

fn motor(db: &str, node: &str, fake: Arc<FakeDiscovery>) -> CrawlMotor {
    let discovery: Arc<dyn SiteDiscovery> = fake;
    CrawlMotor::new(config(db, node)).with_discovery(discovery)
}

/// Node falso: freio de tráfego com `recent` fixo (o tick consulta antes de
/// reivindicar).
async fn node(recent: bool) -> String {
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

fn db_temp() -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().expect("utf8").to_string();
    (dir, caminho)
}

// ─── Rodízio e relógio ──────────────────────────────────────────────────────

#[tokio::test]
async fn um_site_por_tick_e_rodizio_completo() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(Vec::new());
    let motor = motor(&db, "http://127.0.0.1:1", fake.clone());

    for _ in 0..discoverable_sites().len() {
        assert!(
            motor.discover_once().await.is_some(),
            "cada tick descobre UM site"
        );
    }
    let mut rodizio: Vec<String> = fake.calls().iter().map(|c| c.site.clone()).collect();
    rodizio.sort();
    let mut esperado: Vec<String> = discoverable_sites().iter().map(|s| s.to_string()).collect();
    esperado.sort();
    assert_eq!(rodizio, esperado, "todo site vencido passou uma vez");

    assert!(
        motor.discover_once().await.is_none(),
        "nenhum site vencido: nada a fazer"
    );
}

#[tokio::test]
async fn parcial_volta_no_retry_curto_e_completa_no_intervalo() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    let antes = now_ms();
    let parcial = motor.discover_once().await.expect("parcial");
    let alvo = motor
        .discover_next_at
        .lock()
        .await
        .get(&parcial.site)
        .copied()
        .expect("site agendado");
    assert!(
        alvo - antes <= 7_000,
        "parcial volta no prazo curto de retry ({} ms)",
        alvo - antes
    );

    motor.force_discovery().await;
    let antes = now_ms();
    let completa = motor.discover_once().await.expect("completa");
    let alvo = motor
        .discover_next_at
        .lock()
        .await
        .get(&completa.site)
        .copied()
        .expect("site agendado");
    assert!(
        alvo - antes >= 3_500_000,
        "rodada completa espera o intervalo cheio ({} ms)",
        alvo - antes
    );
}

#[tokio::test]
async fn erro_do_site_nao_derruba_o_tick() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Err("índice ilegível".to_string())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    assert!(
        motor.discover_once().await.is_none(),
        "rodada sem resultado não vira tick"
    );
    let alvo = motor
        .discover_next_at
        .lock()
        .await
        .get(PRIMEIRO)
        .copied()
        .expect("o site volta no retry, não fica órfão");
    assert!(alvo > 0);
    assert_eq!(
        motor.status().await.pages_this_hour,
        0,
        "erro antes do fetch de obra não cobra"
    );
}

#[tokio::test]
async fn sem_descoberta_o_motor_nao_descobre() {
    let (_dir, db) = db_temp();
    let motor = CrawlMotor::new(config(&db, "http://127.0.0.1:1"));
    assert!(!motor.discovery_ready());
    assert!(motor.discover_once().await.is_none());
}

// ─── Custo e cursores ───────────────────────────────────────────────────────

#[tokio::test]
async fn custo_da_rodada_entra_no_mesmo_teto_por_hora() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    motor.discover_once().await.expect("rodada");
    assert_eq!(
        motor.status().await.pages_this_hour,
        3,
        "descoberta não é de graça: o teto é de requisições"
    );
}

#[tokio::test]
async fn cursor_so_avanca_com_o_kind_completo() {
    let (_dir, db) = db_temp();
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, "http://127.0.0.1:1", fake);

    let tick = motor.discover_once().await.expect("rodada");
    assert_eq!((tick.urls, tick.added, tick.cost), (2, 2, 3));
    assert!(tick.partial, "houve falha parcial");

    let store = CrawlStore::open(&db).expect("abrir para ler");
    let movie = store.get_state(&tick.site, cursor_key(CrawlPageKind::Movie));
    assert_eq!(
        movie.expect("cursor de filme").as_deref(),
        Some("2026-10-01T00:00:00Z"),
        "filme completo move o cursor"
    );
    let tv = store.get_state(&tick.site, cursor_key(CrawlPageKind::TvShow));
    assert_eq!(
        tv.expect("consulta"),
        None,
        "série parcial NÃO move o cursor"
    );
}

#[tokio::test]
async fn cursor_legado_migra_para_movie_e_vira_corte() {
    let (_dir, db) = db_temp();
    {
        let store = CrawlStore::open(&db).expect("abrir");
        store.migrate().expect("migrar");
        store
            .set_state(PRIMEIRO, "cursor", "2026-01-01T00:00:00Z")
            .expect("cursor legado");
    }
    let fake = FakeDiscovery::new(Vec::new());
    let motor = motor(&db, "http://127.0.0.1:1", fake.clone());

    motor.discover_once().await.expect("rodada");
    let call = fake.calls().remove(0);
    assert_eq!(
        call.opts.since_movie.as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "o cursor legado é o corte do filme"
    );
    assert_eq!(call.opts.since_tv_show, None);

    let store = CrawlStore::open(&db).expect("abrir para ler");
    let migrado = store.get_state(PRIMEIRO, cursor_key(CrawlPageKind::Movie));
    assert_eq!(
        migrado.expect("cursor migrado").as_deref(),
        Some("2026-01-01T00:00:00Z"),
        "a migração grava cursor:movie uma vez"
    );
}

// ─── A costura dentro do tick ───────────────────────────────────────────────

/// Engine que sempre falha: só prova que a fila FOI alimentada pela descoberta.
struct EngineFalha;

impl PageEngine for EngineFalha {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, _row: &'a UrlRow) -> PageFuture<'a> {
        Box::pin(async { PageOutcome::Failed("sem parser no teste".into()) })
    }
}

#[tokio::test]
async fn tick_descobre_antes_de_reivindicar() {
    let (_dir, db) = db_temp();
    let node = node(false).await;
    let fake = FakeDiscovery::new(vec![Ok(report_parcial())]);
    let motor = motor(&db, &node, fake.clone())
        .with_page_engine(Arc::new(EngineFalha))
        .with_ingest(Arc::new(FakeIngest::delivered()));

    match motor.tick_once().await.expect("tick") {
        TickOutcome::Processed { claimed, .. } => {
            assert_eq!(claimed, 1, "a fila veio da descoberta, não estava vazia");
        }
        outro => panic!("esperava lote: {outro:?}"),
    }
    assert_eq!(fake.calls().len(), 1, "a descoberta rodou dentro do tick");
}
