use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;

use super::*;

fn base() -> SearchMeta {
    let mut meta = SearchMeta::from_id("tt1");
    meta.name = "Filme Teste".into();
    meta.names = vec!["Filme Teste".into()];
    meta.year = json!("2024");
    meta.query = "Filme Teste 2024".into();
    meta
}

fn query() -> MetaQuery {
    MetaQuery {
        encoded: "e30".into(),
        kind: "movie".into(),
        id: "tt1".into(),
        include_multiwork: false,
        include_home_release: false,
        deadline_at_ms: None,
    }
}

struct Stub {
    result: Result<SearchMeta, String>,
    delay_ms: u64,
    calls: AtomicUsize,
}

impl Stub {
    fn ok(meta: SearchMeta) -> Arc<Self> {
        Arc::new(Self {
            result: Ok(meta),
            delay_ms: 0,
            calls: AtomicUsize::new(0),
        })
    }

    fn err() -> Arc<Self> {
        Arc::new(Self {
            result: Err("referência fora".into()),
            delay_ms: 0,
            calls: AtomicUsize::new(0),
        })
    }

    fn with_delay(meta: SearchMeta, delay_ms: u64) -> Arc<Self> {
        Arc::new(Self {
            result: Ok(meta),
            delay_ms,
            calls: AtomicUsize::new(0),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl MetaSource for Stub {
    fn resolve<'a>(&'a self, _req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            }
            self.result.clone()
        })
    }
}

fn shadow(
    primary: Arc<Stub>,
    reference: Arc<Stub>,
    percent: u8,
    timeout_ms: i64,
) -> (MetaShadowSource, MetaShadowMetrics) {
    let metrics = MetaShadowMetrics::new();
    (
        MetaShadowSource {
            primary: primary as Arc<dyn MetaSource>,
            reference: reference as Arc<dyn MetaSource>,
            metrics: metrics.clone(),
            percent,
            timeout_ms,
        },
        metrics,
    )
}

async fn settle() {
    // A comparação roda em `tokio::spawn`; o sleep cobre o agendamento mesmo
    // com a suíte em paralelo.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
}

#[tokio::test]
async fn igual_nao_conta_divergencia() {
    let primary = Stub::ok(base());
    let reference = Stub::ok(base());
    let (source, metrics) = shadow(primary, reference, 100, 500);
    source.resolve(query()).await.expect("primário");
    settle().await;
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 0);
    assert_eq!(metrics.get(DIVERGENCE_FIELDS), 0);
    assert_eq!(metrics.get(NAME_DIVERGENCE), 0);
    assert_eq!(metrics.get(SKIPPED_SAMPLE), 0);
}

#[tokio::test]
async fn divergencia_conta_campo_a_campo() {
    let primary = Stub::ok(base());
    let mut outro = base();
    outro.name = "Outro Nome".into();
    outro.names = vec!["Outro Nome".into()];
    outro.year = json!("2025");
    outro.multi_work_root = Some("colecao".into());
    outro.multi_work_query = Some("colecao".into());
    outro.home_release_at = Some(42);
    outro.episode_aired_at_ms = Some(7);
    let reference = Stub::ok(outro);
    let (source, metrics) = shadow(primary, reference, 100, 500);
    source.resolve(query()).await.expect("primário");
    settle().await;
    assert_eq!(metrics.get(COMPARED), 1);
    assert_eq!(metrics.get(DIVERGENCE), 1);
    assert_eq!(metrics.get(DIVERGENCE_FIELDS), 6);
    assert_eq!(metrics.get(NAME_DIVERGENCE), 1);
    assert_eq!(metrics.get(NAMES_DIVERGENCE), 1);
    assert_eq!(metrics.get(YEAR_DIVERGENCE), 1);
    assert_eq!(metrics.get(COLLECTION_DIVERGENCE), 1);
    assert_eq!(metrics.get(HOME_RELEASE_DIVERGENCE), 1);
    assert_eq!(metrics.get(EPISODE_AIRED_DIVERGENCE), 1);
    assert_eq!(metrics.get(PT_QUERY_DIVERGENCE), 0);
}

#[tokio::test]
async fn fora_da_amostra_pula_sem_chamar_a_referencia() {
    let primary = Stub::ok(base());
    let reference = Stub::ok(base());
    let (source, metrics) = shadow(primary, reference.clone(), 0, 500);
    source.resolve(query()).await.expect("primário");
    settle().await;
    assert_eq!(reference.calls(), 0);
    assert_eq!(metrics.get(SKIPPED_SAMPLE), 1);
    assert_eq!(metrics.get(COMPARED), 0);
}

#[tokio::test]
async fn nao_segura_o_cliente() {
    let primary = Stub::ok(base());
    let reference = Stub::with_delay(base(), 300);
    let (source, metrics) = shadow(primary, reference, 100, 1_000);
    let started = std::time::Instant::now();
    source.resolve(query()).await.expect("primário");
    let decorrido = started.elapsed();
    assert!(
        decorrido < std::time::Duration::from_millis(150),
        "resolve esperou a referência: {decorrido:?}"
    );
    tokio::time::sleep(std::time::Duration::from_millis(350)).await;
    assert_eq!(metrics.get(COMPARED), 1);
}

#[tokio::test]
async fn erro_da_referencia_nao_e_divergencia() {
    let primary = Stub::ok(base());
    let reference = Stub::err();
    let (source, metrics) = shadow(primary, reference, 100, 500);
    source.resolve(query()).await.expect("primário");
    settle().await;
    assert_eq!(metrics.get(ERROR), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

#[tokio::test]
async fn timeout_da_referencia_nao_e_divergencia() {
    let primary = Stub::ok(base());
    let reference = Stub::with_delay(base(), 300);
    let (source, metrics) = shadow(primary, reference, 100, 20);
    source.resolve(query()).await.expect("primário");
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(metrics.get(TIMEOUT), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(metrics.get(DIVERGENCE), 0);
}

#[tokio::test]
async fn primario_com_erro_nao_compara() {
    let primary = Stub::err();
    let reference = Stub::ok(base());
    let (source, metrics) = shadow(primary, reference.clone(), 100, 500);
    assert!(source.resolve(query()).await.is_err());
    settle().await;
    assert_eq!(metrics.get(SKIPPED), 1);
    assert_eq!(metrics.get(COMPARED), 0);
    assert_eq!(reference.calls(), 0);
}

#[test]
fn amostra_e_deterministica_e_respeita_os_extremos() {
    assert!(!sample_includes(0, "movie", "tt1"));
    assert!(sample_includes(100, "movie", "tt1"));
    // Mesma request, mesmo veredito (nada de sorteio por relógio).
    for percent in [1_u8, 25, 50, 99] {
        let primeiro = sample_includes(percent, "series", "tt0944947:8:3");
        for _ in 0..20 {
            assert_eq!(
                sample_includes(percent, "series", "tt0944947:8:3"),
                primeiro
            );
        }
    }
}

#[test]
fn percentual_e_prazo_sao_grampeados() {
    assert_eq!(meta_shadow_percent_from(None), 100);
    assert_eq!(meta_shadow_percent_from(Some("0")), 0);
    assert_eq!(meta_shadow_percent_from(Some("250")), 100);
    assert_eq!(meta_shadow_percent_from(Some("-5")), 0);
    assert_eq!(meta_shadow_percent_from(Some("lixo")), 100);
    assert_eq!(meta_shadow_timeout_ms_from(None), 5_000);
    assert_eq!(meta_shadow_timeout_ms_from(Some("0")), 5_000);
    assert_eq!(meta_shadow_timeout_ms_from(Some("250")), 250);
}

#[test]
fn comparacao_pura_marca_cada_campo() {
    let igual = compare_meta(&base(), &base());
    assert!(!igual.diverged());
    let mut outro = base();
    outro.pt_query = Some("Filme Teste PT 2024".into());
    outro.sweep_query = Some("Filme".into());
    outro.original_query = Some("Test Movie".into());
    outro.alt_year = Some("2020".into());
    let diferente = compare_meta(&base(), &outro);
    assert_eq!(diferente.fields(), 4);
    assert!(diferente.pt_query);
    assert!(diferente.sweep_query);
    assert!(diferente.original_query);
    assert!(diferente.alt_year);
    assert!(!diferente.name);
}

#[test]
fn snapshot_expoe_as_chaves_zeradas() {
    let snapshot = meta_shadow_metrics_snapshot();
    assert!(snapshot.contains_key(COMPARED));
    assert!(snapshot.contains_key(SKIPPED_SAMPLE));
    assert!(snapshot.contains_key(EPISODE_AIRED_DIVERGENCE));
}
