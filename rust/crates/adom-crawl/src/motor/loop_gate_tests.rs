//! Testes do caminho de pendência de portão no tick do motor (post só-gate
//! do BLUDV). Separados do `loop_tests.rs` pela catraca de 400 linhas; como
//! módulo filho, enxergam os helpers do irmão-pai via `super::*`.

use super::*;

/// Engine que entrega o estado PENDENTE DE PORTÃO (o caminho do post só-gate
/// do BLUDV): o motor grava a pendência e NÃO entrega nada ao Node.
struct EngineGateFake {
    /// `true` entrega o href do portão; `false` simula o parser que não
    /// colheu o botão (pendência órfã → erro retentável).
    sem_href: bool,
}

impl PageEngine for EngineGateFake {
    fn is_ready(&self) -> bool {
        true
    }

    fn execute<'a>(&'a self, row: &'a UrlRow) -> PageFuture<'a> {
        let mut work = CrawlWorkResult::parser_pending(row);
        work.status = CrawlResultStatus::GatePending;
        work.title = Some("Filme X".to_string());
        work.year = Some(2024);
        work.imdb = Some("tt2222222".to_string());
        if self.sem_href {
            work.gate = Some("https://bludvfilmes1.xyz/gate/go/abc123?p=60609".to_string());
        }
        work.request_cost = 1;
        Box::pin(async move { PageOutcome::Work(Box::new(work)) })
    }
}

/// Post só-gate: a linha vira `gate-pending` COM o portão na `crawl_gate`,
/// sem queimar tentativa e SEM entrega ao Node (a gravação no acervo acontece
/// quando o executor de fundo pagar — fora do passo).
#[tokio::test]
async fn post_so_gate_vira_pendencia_sem_entrega_ao_node() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-gate"));

    let posts = Arc::new(AtomicUsize::new(0));
    let node = node_falso(posts.clone()).await;
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(Arc::new(EngineGateFake { sem_href: true }))
        .with_ingest(Arc::new(FakeIngest::delivered()));

    let outcome = motor.tick_once().await.expect("tick");
    assert_eq!(
        outcome,
        TickOutcome::Processed {
            claimed: 1,
            delivered: 1
        },
        "a pendência foi gravada: a rodada considera a linha cuidada"
    );
    assert_eq!(
        posts.load(Ordering::SeqCst),
        0,
        "Node não recebe resultado de pendência"
    );

    let (status, tries, next_at) = ler_linha(caminho, "filme-gate");
    assert_eq!(status, "gate-pending");
    assert_eq!(tries, 0, "pendência de custo não queima tentativa");
    assert_eq!(next_at, 0);

    // O portão está na fila do executor, com os metadados de obra.
    let db = CrawlStore::open(caminho).expect("reabrir");
    let fila = db.take_gate_batch(10).expect("lote");
    assert_eq!(fila.len(), 1);
    assert_eq!(
        fila[0].gate,
        "https://bludvfilmes1.xyz/gate/go/abc123?p=60609"
    );
    assert_eq!(fila[0].title, "Filme X");
    assert_eq!(fila[0].year, 2024);
}

/// Pendente de portão SEM href (parser não colheu o botão): pendência órfã
/// nunca é criada — a linha volta como erro retentável para re-raspar.
#[tokio::test]
async fn gate_pendente_sem_href_vira_erro_retentavel() {
    let dir = tempfile::tempdir().expect("tempdir");
    let db = dir.path().join("crawl.db");
    let caminho = db.to_str().unwrap();
    seed(caminho, linha("filme-sem-gate"));

    let posts = Arc::new(AtomicUsize::new(0));
    let node = node_falso(posts.clone()).await;
    let motor = CrawlMotor::new(config(caminho, &node))
        .with_page_engine(Arc::new(EngineGateFake { sem_href: false }))
        .with_ingest(Arc::new(FakeIngest::delivered()));

    motor.tick_once().await.expect("tick");
    let (status, tries, next_at) = ler_linha(caminho, "filme-sem-gate");
    assert_eq!(status, "pending", "retry: a página é re-raspeada");
    assert_eq!(tries, 1);
    assert!(next_at > now_ms(), "backoff empurra a próxima tentativa");
    let db = CrawlStore::open(caminho).expect("reabrir");
    assert!(
        db.take_gate_batch(10).expect("lote").is_empty(),
        "nenhuma órfã na fila"
    );
}
