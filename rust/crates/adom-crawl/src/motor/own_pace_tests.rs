//! Testes da lane de RITMO PRÓPRIO no motor (Fase 6 — Mico).
//!
//! O contrato do card: o Mico roda **fora** do teto horário, da janela de
//! ociosidade e das vagas do `CRAWL_MAX_PARALLEL` — o único limitador é o
//! `MICO_CRAWL_MIN_GAP_MS` do adaptador. Aqui isso é provado com os três freios
//! LIGADOS: `max_per_hour = 0`, Node respondendo `recent: true` e
//! `max_parallel = 0`, e a lane ainda descobre, lê e entrega.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::routing::{get, post};
use axum::Json;

use crate::mico::{mico_movie_stream_url, SeriesMeta};
use crate::mico_discovery::MicoCrawlConfig;
use crate::mico_net::api::{MicoApi, MicoFuture};
use crate::mico_net::types::{CatalogPage, CatalogType, MicoError};
use crate::mico_page::{MicoPageEngine, RoutedPageEngine};
use crate::motor::mico_lane::MicoLane;
use crate::motor::r#loop::{CrawlMotor, TickOutcome};
use crate::motor::types::{MotorConfig, PageEngine, PageFuture, PageOutcome};
use crate::store::ops::CrawlStore;
use crate::store::UrlRow;

const BASE: &str = "https://mico.teste";
const TT: &str = "tt0133093";

/// API do Mico falsa: catálogo de UMA página + um stream de filme.
struct FakeApi {
    catalogo: Vec<String>,
    streams: HashMap<String, String>,
    chamadas: Mutex<Vec<String>>,
}

impl FakeApi {
    fn nova() -> Self {
        let url = mico_movie_stream_url(TT, Some(BASE)).expect("url do filme");
        let hash = "b".repeat(40);
        let corpo =
            format!(r#"{{"streams":[{{"infoHash":"{hash}","title":"Matrix 1999 1080p"}}]}}"#);
        Self {
            catalogo: vec![TT.to_string()],
            streams: HashMap::from([(url, corpo)]),
            chamadas: Mutex::new(Vec::new()),
        }
    }

    fn chamadas(&self) -> usize {
        self.chamadas.lock().unwrap().len()
    }
}

impl MicoApi for FakeApi {
    fn catalog_page<'a>(
        &'a self,
        _kind: CatalogType,
        _catalog_id: &'a str,
        skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
        Box::pin(async move {
            self.chamadas
                .lock()
                .unwrap()
                .push(format!("catalog:{skip}"));
            // Só o `skip = 0` tem obra: o resto é o fim do catálogo.
            let ids = if skip == 0 {
                self.catalogo.clone()
            } else {
                Vec::new()
            };
            Ok(CatalogPage {
                count: ids.len(),
                ids,
            })
        })
    }

    fn get_json<'a>(&'a self, url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
        Box::pin(async move {
            self.chamadas.lock().unwrap().push(url.to_string());
            Ok(self.streams.get(url).cloned())
        })
    }

    fn series_meta<'a>(
        &'a self,
        _imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<SeriesMeta>, MicoError>> {
        Box::pin(async move { Ok(None) })
    }
}

/// Config de motor com os freios nos extremos pedidos pelo contrato.
fn config_freada(db_path: &str, node_url: &str) -> MotorConfig {
    MotorConfig {
        db_path: db_path.to_string(),
        node_url: node_url.to_string(),
        admin_token: "token-de-teste".to_string(),
        idle_window_ms: 600_000,
        max_parallel: 0,
        max_per_hour: 0,
        ..Default::default()
    }
}

/// Config da lane enxuta: sem séries e com paginação curta (fim rápido).
fn config_lane() -> MicoCrawlConfig {
    MicoCrawlConfig {
        base_url: BASE.to_string(),
        max_pages: 20,
        empty_retries: 1,
        end_after_empties: 2,
        series_enabled: false,
        ..Default::default()
    }
}

/// Engine HTML que nunca deveria ser chamada: a rota do Mico é a engine dele.
struct EngineProibida;

impl PageEngine for EngineProibida {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, _row: &'a UrlRow) -> PageFuture<'a> {
        // Falha (e não panic) para o teste mostrar o motivo se a rota errar.
        Box::pin(async { PageOutcome::Failed("engine HTML não serve o Mico".into()) })
    }
}

/// Node falso: freio de tráfego com `recent` fixo + contador de entregas.
async fn node(recent: bool, entregas: Arc<AtomicUsize>) -> String {
    let app = axum::Router::new()
        .route(
            "/internal/activity",
            get(move || async move { Json(serde_json::json!({ "recent": recent })) }),
        )
        .route("/internal/crawl-result", post(entrega))
        .with_state(entregas);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind do node falso");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{addr}")
}

async fn entrega(
    State(entregas): State<Arc<AtomicUsize>>,
    Json(_body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    entregas.fetch_add(1, Ordering::SeqCst);
    Json(serde_json::json!({ "ok": true, "kept": 0, "added": 0 }))
}

/// Monta o motor com a lane ligada e o roteador own_pace → engine do Mico.
fn motor_com_lane(cfg_motor: MotorConfig, api: Arc<FakeApi>) -> CrawlMotor {
    let lane_cfg = config_lane();
    let page = Arc::new(MicoPageEngine::new(api.clone(), &lane_cfg));
    let engine = RoutedPageEngine::new(Arc::new(EngineProibida), page);
    CrawlMotor::new(cfg_motor)
        .with_page_engine(Arc::new(engine))
        .with_mico(Arc::new(MicoLane::new(api, lane_cfg)))
}

/// Lê `(status, releases)` de uma linha da fila.
fn linha(db: &str, site: &str, key: &str) -> (String, u32) {
    let store = CrawlStore::open(db).expect("abrir para ler");
    store
        .conn()
        .query_row(
            "SELECT status, releases FROM crawl_url WHERE site = ?1 AND url_key = ?2",
            rusqlite::params![site, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("linha presente")
}

/// O contrato do card, num teste só: com teto horário ZERO, usuário ATIVO e
/// zero vagas de paralelismo, a lane ainda descobre, reivindica, lê e entrega.
#[tokio::test]
async fn own_pace_ignora_teto_ociosidade_e_vagas() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let entregas = Arc::new(AtomicUsize::new(0));
    let node = node(true, entregas.clone()).await;

    let api = Arc::new(FakeApi::nova());
    let motor = motor_com_lane(config_freada(caminho, &node), api.clone());
    assert!(motor.own_pace_ready());

    // Banco vazio: a descoberta nativa enfileira e o MESMO passo já trabalha.
    let rel = motor
        .own_pace_once()
        .await
        .expect("lane sem erro")
        .expect("lane ligada");
    assert_eq!(rel.discovered, 1, "catálogo com uma obra virou uma URL");
    assert_eq!(rel.claimed, 1, "a linha foi reivindicada no mesmo passo");
    assert_eq!(rel.delivered, 1, "o Node aceitou a entrega");
    assert_eq!(entregas.load(Ordering::SeqCst), 1);

    let (status, releases) = linha(caminho, "mico", "/crawl/movie/tt0133093");
    assert_eq!(status, "done");
    assert_eq!(releases, 1, "o stream do filme virou release");

    // Os freios continuam valendo para o lote HTML: teto zero barra o tick.
    assert_eq!(
        motor.tick_once().await.expect("tick"),
        TickOutcome::Skipped("teto-horario")
    );

    // Passo seguinte, sem descoberta vencida e sem fila: nada é refeito.
    let rel2 = motor.own_pace_once().await.expect("lane").expect("ligada");
    assert_eq!((rel2.discovered, rel2.claimed), (0, 0));
    assert_eq!(entregas.load(Ordering::SeqCst), 1, "nada reentregue");
}

/// A descoberta respeita o intervalo: só a primeira rodada gasta catálogo.
#[tokio::test]
async fn descoberta_nao_repete_dentro_do_intervalo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let node = node(false, Arc::new(AtomicUsize::new(0))).await;
    let api = Arc::new(FakeApi::nova());
    let motor = motor_com_lane(config_freada(caminho, &node), api.clone());

    motor.own_pace_once().await.expect("1º passo");
    let depois_da_descoberta = api.chamadas();
    assert!(depois_da_descoberta >= 2, "catálogo + stream do filme");

    motor.own_pace_once().await.expect("2º passo");
    assert_eq!(
        api.chamadas(),
        depois_da_descoberta,
        "sem rede quando a descoberta não venceu e a fila está vazia"
    );
}

/// A lane tem dono único: um passo em curso não é atropelado pelo tick.
#[tokio::test]
async fn passo_em_curso_bloqueia_outro_passo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let node = node(false, Arc::new(AtomicUsize::new(0))).await;
    let lane = Arc::new(MicoLane::new(Arc::new(FakeApi::nova()), config_lane()));
    let motor = CrawlMotor::new(config_freada(caminho, &node)).with_mico(lane.clone());
    assert!(motor.own_pace_ready());

    assert!(lane.try_enter(), "primeira reserva");
    assert!(!lane.try_enter(), "segundo passo é recusado enquanto roda");
    lane.leave();
    assert!(lane.try_enter(), "liberou: pode voltar a rodar");
    lane.leave();
}

/// Sem lane ligada o motor não trabalha own_pace — e diz isso no diagnóstico.
#[tokio::test]
async fn sem_lane_nao_ha_passo_own_pace() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let motor = CrawlMotor::new(config_freada(caminho, "http://127.0.0.1:1"));
    assert!(!motor.own_pace_ready());
    assert!(motor.own_pace_once().await.expect("sem erro").is_none());
}

/// O catálogo de SÉRIE usa a mesma máquina: um id vira URL sintética de série.
#[tokio::test]
async fn descoberta_de_serie_vira_url_de_serie() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    let node = node(false, Arc::new(AtomicUsize::new(0))).await;
    let api = Arc::new(FakeApi::nova());
    let mut cfg = config_lane();
    cfg.series_enabled = true;
    let page = Arc::new(MicoPageEngine::new(api.clone(), &cfg));
    let engine = RoutedPageEngine::new(Arc::new(EngineProibida), page);
    let motor = CrawlMotor::new(config_freada(caminho, &node))
        .with_page_engine(Arc::new(engine))
        .with_mico(Arc::new(MicoLane::new(api.clone(), cfg)));

    // A série é descoberta; o passe a lê (meta ausente = erro retentável, sem
    // tocar em `no-torrent`), então o que importa aqui é a URL enfileirada.
    let _ = motor.own_pace_once().await.expect("passo");
    let store = CrawlStore::open(caminho).expect("abrir");
    let kind: String = store
        .conn()
        .query_row(
            "SELECT kind FROM crawl_url WHERE site = 'mico' AND url_key = ?1",
            ["/crawl/series/tt0133093"],
            |r| r.get(0),
        )
        .expect("série na fila");
    assert_eq!(kind, "tv_show", "descoberta de série usa tv_show na fila");
}
