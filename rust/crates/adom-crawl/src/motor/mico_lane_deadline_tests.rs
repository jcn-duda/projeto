//! Prazos da descoberta do Mico (2026-10-26: a lane ficou ~18 h presa num
//! passo só, sem ler página). A descoberta roda DENTRO do passo da lane, então
//! o prazo dela é o que garante que a leitura volta.
//!
//! - prazo MACIO: catálogo infinito e lento → a rodada para entre páginas,
//!   grava o que leu, NÃO marca varredura completa e o MESMO passo lê;
//! - prazo DURO: catálogo que nunca responde → o passo termina mesmo assim.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tokio::time::{Duration, Instant};

use crate::mico::SeriesMeta;
use crate::mico_discovery::MicoCrawlConfig;
use crate::mico_net::api::{MicoApi, MicoFuture};
use crate::mico_net::types::{CatalogPage, CatalogType, MicoError};
use crate::mico_page::{MicoPageEngine, RoutedPageEngine};
use crate::motor::ingest::test_support::FakeIngest;
use crate::motor::mico_lane::MicoLane;
use crate::motor::r#loop::CrawlMotor;
use crate::motor::types::{MotorConfig, PageEngine, PageFuture, PageOutcome};
use crate::store::ops::CrawlStore;
use crate::store::UrlRow;

/// `Some(atraso)`: catálogo sem fim, uma obra nova por página. `None`: trava.
struct CatalogoFalso {
    atraso: Option<Duration>,
    paginas: AtomicUsize,
}

impl MicoApi for CatalogoFalso {
    fn catalog_page<'a>(
        &'a self,
        _kind: CatalogType,
        _catalog_id: &'a str,
        skip: usize,
    ) -> MicoFuture<'a, Result<CatalogPage, MicoError>> {
        Box::pin(async move {
            self.paginas.fetch_add(1, Ordering::SeqCst);
            let Some(atraso) = self.atraso else {
                return std::future::pending().await;
            };
            tokio::time::sleep(atraso).await;
            let ids = vec![format!("tt{}", 9_000_000 + skip)];
            Ok(CatalogPage { count: 1, ids })
        })
    }

    fn get_json<'a>(&'a self, _url: &'a str) -> MicoFuture<'a, Result<Option<String>, MicoError>> {
        Box::pin(async { Ok(None) })
    }

    fn series_meta<'a>(
        &'a self,
        _imdb: &'a str,
    ) -> MicoFuture<'a, Result<Option<SeriesMeta>, MicoError>> {
        Box::pin(async { Ok(None) })
    }
}

struct EngineProibida;

impl PageEngine for EngineProibida {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, _row: &'a UrlRow) -> PageFuture<'a> {
        Box::pin(async { PageOutcome::Failed("engine HTML não serve o Mico".into()) })
    }
}

fn motor(caminho: &str, api: Arc<CatalogoFalso>, prazo_ms: i64, folga: Duration) -> CrawlMotor {
    let cfg = MicoCrawlConfig {
        base_url: "https://mico.teste".to_string(),
        max_pages: 700,
        series_enabled: false,
        discovery_deadline_ms: prazo_ms,
        ..Default::default()
    };
    let page = Arc::new(MicoPageEngine::new(api.clone(), &cfg));
    let engine = RoutedPageEngine::new(Arc::new(EngineProibida), page);
    let motor_cfg = MotorConfig {
        db_path: caminho.to_string(),
        node_url: "http://127.0.0.1:1".to_string(),
        ..Default::default()
    };
    CrawlMotor::new(motor_cfg)
        .with_page_engine(Arc::new(engine))
        .with_ingest(Arc::new(FakeIngest::delivered()))
        .with_mico(Arc::new(MicoLane::new(api, cfg).with_hard_grace(folga)))
}

#[tokio::test]
async fn prazo_macio_corta_catalogo_infinito_e_o_passo_le() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    let api = Arc::new(CatalogoFalso {
        atraso: Some(Duration::from_millis(20)),
        paginas: AtomicUsize::new(0),
    });
    let motor = motor(&caminho, api.clone(), 200, Duration::from_secs(60));

    let inicio = Instant::now();
    let rel = motor.own_pace_once().await.expect("passo").expect("lane");
    assert!(
        inicio.elapsed() < Duration::from_secs(5),
        "o prazo soltou a lane"
    );
    let paginas = api.paginas.load(Ordering::SeqCst);
    assert!(
        paginas > 0 && paginas < 700,
        "parou no prazo, não no teto: {paginas}"
    );
    assert_eq!(
        rel.discovered as usize, paginas,
        "o que leu antes do prazo entrou na fila"
    );
    assert_eq!(rel.claimed, 1, "o MESMO passo voltou a ler página");

    let store = CrawlStore::open(&caminho).expect("abrir");
    let marcador = store.get_state("mico", "full-sweep:movie").expect("state");
    assert!(
        marcador.is_none(),
        "rodada cortada não prova o fim do catálogo"
    );
}

#[tokio::test]
async fn prazo_duro_solta_a_lane_com_catalogo_travado() {
    let dir = tempfile::tempdir().expect("tempdir");
    let caminho = dir.path().join("crawl.db").to_str().unwrap().to_string();
    let api = Arc::new(CatalogoFalso {
        atraso: None,
        paginas: AtomicUsize::new(0),
    });
    let motor = motor(&caminho, api.clone(), 50, Duration::from_millis(50));

    let inicio = Instant::now();
    let rel = motor.own_pace_once().await.expect("passo").expect("lane");
    assert!(
        inicio.elapsed() < Duration::from_secs(5),
        "o passo não ficou preso"
    );
    assert_eq!(
        api.paginas.load(Ordering::SeqCst),
        1,
        "a primeira página travou"
    );
    assert_eq!(rel.discovered, 0, "rodada estourada não grava nada");
}
