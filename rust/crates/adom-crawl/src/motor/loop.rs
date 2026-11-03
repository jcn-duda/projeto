//! Loop principal do motor do raspador (C4).
//!
//! Liga o `store` (crawl.db), o `sidecar` (entrega ao Node + freio de tráfego)
//! e a costura [`PageEngine`] (fetch+parse, que chega no C5): o loop não conhece
//! parser nenhum, conhece a trait.
//!
//! Um tick: pausa global → auto-pausa → teto por hora (custo REAL) → freio do
//! usuário → parser ligado? → INGESTÃO ligada? → `take_next_batch(max_parallel,
//! sites-em-espera)` → uma `spawn` por linha com `timeout(step_deadline_ms)` →
//! ingestão nativa (T3-L3) → `mark_result`.
//!
//! A página NÃO é mais postada em `/internal/crawl-result`: quem grava é o
//! [`Ingest`](crate::ingest::Ingest) injetado (banco vivo → índice → invalidação),
//! pelo adaptador [`PageIngest`](super::ingest::PageIngest).
//!
//! As regras puras de decisão (backoff, status, esgotamento de `tries`) estão em
//! [`MarkResult::from_work`](crate::store::ops::MarkResult); 429/503 têm desfecho
//! PRÓPRIO (`site_clock::deferred_step`): não entregam, não queimam `tries` e
//! põem o site de molho. Erro de rede nunca derruba o motor.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::time::{interval, Duration, Instant};

use super::ingest::PageIngest;
use super::mico_lane::MicoLane;
use super::site_clock::{deferred_step, delay_efetivo};
use super::types::{
    error_work, now_ms, CrawlResultStatus, MotorConfig, MotorStatus, PageEngine, PageOutcome,
    UnwiredPageEngine,
};
use crate::discovery::SiteDiscovery;
use crate::sidecar::activity::recent_user_traffic;
use crate::sidecar::http_client::SidecarHttpClient;
use crate::store::ops::{CrawlStore, MarkResult, UrlRow};

/// Erro fatal do motor — só persistência. Rede/entrega são log, não erro.
#[derive(Debug)]
pub enum MotorError {
    /// `crawl.db` indisponível (abertura, claim ou escrita).
    StoreError(String),
}

impl std::fmt::Display for MotorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StoreError(msg) => write!(f, "erro no store: {msg}"),
        }
    }
}

impl std::error::Error for MotorError {}

/// O que um tick fez (motivo legível, como o `skipReason` do painel TS).
#[derive(Debug, Clone, PartialEq)]
pub enum TickOutcome {
    /// Tick pulado, com o motivo.
    Skipped(&'static str),
    /// Lote reivindicado; `delivered` é o que o Node aceitou.
    Processed { claimed: usize, delivered: usize },
}

/// Store compartilhado entre o tick e as tasks; o tipo e o acesso vivem em
/// `store_handle.rs` (catraca) e são reexportados aos módulos irmãos.
pub(super) use super::store_handle::{with_store, StoreHandle};

/// O que cada task precisa: tudo `Arc`/`Clone` para ir dentro do `spawn`.
#[derive(Clone)]
pub(super) struct BatchCtx {
    pub(super) engine: Arc<dyn PageEngine>,
    /// Quem grava a página concluída no processo. Montado UMA vez pela fiação.
    pub(super) ingest: Option<Arc<dyn PageIngest>>,
    pub(super) store: StoreHandle,
    pub(super) cfg: MotorConfig,
}

/// Custo e entrega de UMA linha trabalhada.
pub(super) struct TaskReport {
    pub(super) cost: u32,
    pub(super) delivered: bool,
}

/// Uma task = uma URL: engine com prazo duro → ingestão → `mark_result`.
pub(super) async fn run_one(ctx: BatchCtx, row: UrlRow) -> TaskReport {
    let deadline = Duration::from_millis(ctx.cfg.step_deadline_ms.max(1_000));
    // A MESMA cerca vale para as duas metades do passo: a engine para de ler e
    // a ingestão para de gravar quando o prazo estoura.
    let deadline_at = Instant::now() + deadline;
    let outcome = match tokio::time::timeout_at(deadline_at, ctx.engine.execute(&row)).await {
        Ok(o) => o,
        // Prazo duro: a geração é invalidada e a linha vira erro retentável.
        Err(_) => PageOutcome::TimedOut,
    };
    let mut work = match outcome {
        PageOutcome::Work(w) => *w,
        // 429/503 (Fase 0): desfecho ADIÁVEL — não entrega, não loga erro,
        // não queima `tries`; o site inteiro descansa o prazo pedido.
        PageOutcome::Deferred {
            retry_after_ms,
            label,
        } => {
            return deferred_step(&ctx, &row, retry_after_ms, &label).await;
        }
        PageOutcome::Failed(msg) => {
            eprintln!("[motor] {} {}: {}", row.site, row.url_key, msg);
            error_work(&row, &msg)
        }
        PageOutcome::TimedOut => {
            eprintln!("[motor] {} {}: step-timeout", row.site, row.url_key);
            error_work(&row, "step-timeout")
        }
    };

    // Ritmo por site (Fase 0): a página saiu (feita, falha ou prazo) e o
    // site descansa o delay efetivo antes da próxima. Antes do branch do
    // portão para valer para TODO desfecho — o gate-pending também leu o site.
    ctx.cfg.site_clock.wait(
        &row.site,
        now_ms().saturating_add(delay_efetivo(&row.site, ctx.cfg.delay_ms) as i64),
    );

    // Post pendente de portão (BLUDV): NADA a entregar ao Node ainda — a
    // gravação no acervo acontece quando o executor de fundo pagar o portão
    // (fora do passo, fora deste prazo). O fluxo inteiro (gravação sem
    // queimar tentativa + fallback de erro retentável sem href) vive em
    // `gate_pending.rs` (catraca de 400 linhas).
    if matches!(work.status, CrawlResultStatus::GatePending) {
        return super::gate_pending::handle_gate_pending(&ctx, &row, &work).await;
    }

    // Substitui o `POST /internal/crawl-result`: gravar nos dois caminhos
    // duplicaria a página. `delivered` mantém a semântica antiga (retentável →
    // backoff).
    let delivered = super::deliver::deliver_page(&ctx, &row.site, &mut work, deadline_at).await;

    let mark = MarkResult::from_work(&row, &work, delivered, &ctx.cfg, now_ms());
    let (site, url_key, cost) = (row.site.clone(), row.url_key.clone(), work.request_cost);
    let alvo = format!("{site} {url_key}");
    if let Err(e) = with_store(ctx.store, move |db| db.mark_result(&site, &url_key, &mark)).await {
        eprintln!("[motor] falha ao marcar {alvo}: {e}");
    }
    TaskReport { cost, delivered }
}

/// Motor do raspador — loop principal. O `Clone` compartilha o estado (tudo em
/// `Arc`): é como a descoberta vai para a task própria.
#[derive(Clone)]
pub struct CrawlMotor {
    pub(super) config: MotorConfig,
    pub(super) http: Arc<SidecarHttpClient>,
    pub(super) engine: Arc<dyn PageEngine>,
    pub(super) store: StoreHandle,
    /// Ingestão nativa plugada pela fiação. `None` = tick não reivindica URL.
    pub(super) ingest: Option<Arc<dyn PageIngest>>,
    running: Arc<Mutex<bool>>,
    global_paused: Arc<Mutex<bool>>,
    pub(super) pages_this_hour: Arc<Mutex<u32>>,
    pub(super) hour_started_at: Arc<Mutex<i64>>,
    pub(super) pause_until: Arc<Mutex<i64>>,
    pub(super) failure_streak: Arc<Mutex<u32>>,
    /// Lane de ritmo próprio (Mico). `None` = nenhum site own_pace trabalhado.
    pub(super) mico: Option<Arc<MicoLane>>,
    /// Descoberta de sitemap plugada pela fiação. `None` = tick não descobre
    /// e a fila só anda pelo que já estava nela.
    pub(super) discovery: Option<Arc<dyn SiteDiscovery>>,
    /// Relógio POR SITE da próxima rodada de descoberta (memória: restart
    /// descobre uma vez, que é o comportamento correto depois de um deploy).
    pub(super) discover_next_at: super::discovery_tick::DiscoverClock,
    /// Rodízio entre os sites que descobrem (um site faminto não pode ser
    /// preterido por outro com fila grande).
    pub(super) discover_cursor: Arc<Mutex<usize>>,
    /// Há rodada de descoberta em curso? Uma de cada vez, em task própria.
    pub(super) discovery_busy: Arc<AtomicBool>,
}

impl CrawlMotor {
    /// Cria o motor com a engine padrão (parser não integrado → o loop espera).
    pub fn new(config: MotorConfig) -> Self {
        let http = Arc::new(SidecarHttpClient::new(
            config.node_url.clone(),
            config.admin_token.clone(),
        ));
        Self {
            config,
            http,
            engine: Arc::new(UnwiredPageEngine),
            ingest: None,
            store: Arc::new(StdMutex::new(None)),
            running: Arc::new(Mutex::new(false)),
            global_paused: Arc::new(Mutex::new(false)),
            pages_this_hour: Arc::new(Mutex::new(0)),
            hour_started_at: Arc::new(Mutex::new(0)),
            pause_until: Arc::new(Mutex::new(0)),
            failure_streak: Arc::new(Mutex::new(0)),
            mico: None,
            discovery: None,
            discover_next_at: Arc::new(Mutex::new(HashMap::new())),
            discover_cursor: Arc::new(Mutex::new(0)),
            discovery_busy: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Injeta o parser (C5). Sem isto o motor não reivindica nenhuma URL.
    pub fn with_page_engine(mut self, engine: Arc<dyn PageEngine>) -> Self {
        self.engine = engine;
        self
    }

    /// Pausa/religa o motor pelo painel sem derrubar o processo.
    pub async fn set_paused(&self, paused: bool) {
        *self.global_paused.lock().await = paused;
    }

    /// O parser está plugado? Diagnóstico — `MotorStatus` não muda de forma.
    pub fn parser_ready(&self) -> bool {
        self.engine.is_ready()
    }

    /// Inicia o loop. Retorna quando [`stop()`](Self::stop) é chamado.
    pub async fn run(&self) -> Result<(), MotorError> {
        *self.running.lock().await = true;
        self.ensure_store()?;
        self.requeue_inflight_on_boot().await;

        let mut ticker = interval(Duration::from_millis(self.config.delay_ms.max(1)));
        // O motivo do skip só é logado quando MUDA: um motor travado em
        // `parser-pendente` ficaria mudo e pareceria saudável.
        let mut ultimo_motivo: Option<&str> = None;
        loop {
            ticker.tick().await;
            if !*self.running.lock().await {
                break;
            }
            match self.tick_once().await {
                Ok(TickOutcome::Skipped(motivo)) => {
                    if ultimo_motivo != Some(motivo) {
                        eprintln!("[motor] tick pulado: {motivo}");
                        ultimo_motivo = Some(motivo);
                    }
                }
                Ok(TickOutcome::Processed { .. }) => ultimo_motivo = None,
                // Tick com erro não derruba o motor: o próximo ciclo tenta.
                Err(e) => eprintln!("[motor] erro no tick (continuando): {e}"),
            }
        }
        *self.running.lock().await = false;
        Ok(())
    }

    /// Executa UM tick. Não consulta `running` (quem para o loop é o
    /// [`run()`](Self::run)): assim o painel e os testes forçam um ciclo.
    pub async fn tick_once(&self) -> Result<TickOutcome, MotorError> {
        let now = now_ms();
        if *self.global_paused.lock().await {
            return Ok(TickOutcome::Skipped("pausado"));
        }
        if now < *self.pause_until.lock().await {
            return Ok(TickOutcome::Skipped("auto-pausa"));
        }
        // Ritmo próprio (Mico) ANTES dos freios de site HTML: o adaptador tem o
        // throttle dele (`MICO_CRAWL_MIN_GAP_MS`) e não divide teto nem vaga.
        self.spawn_own_pace();
        self.roll_hour_window(now).await;
        if *self.pages_this_hour.lock().await >= self.config.max_per_hour {
            return Ok(TickOutcome::Skipped("teto-horario"));
        }
        // Freio: app em uso sempre ganha da raspagem.
        if recent_user_traffic(&self.http, self.config.idle_window_ms).await {
            return Ok(TickOutcome::Skipped("usuario-ativo"));
        }
        // Sem parser não se toca na fila: todo `mark_result` consome `tries`.
        if !self.engine.is_ready() && !self.config.degraded_write {
            return Ok(TickOutcome::Skipped("parser-pendente"));
        }
        // Sem ingestão também não se toca na fila: entregar a página sem quem
        // grave queimaria `tries` de toda URL (o POST antigo não existe mais).
        if !self.ingest_ready() {
            return Ok(TickOutcome::Skipped("ingest-pendente"));
        }

        self.ensure_store()?;
        // Em task própria: uma rodada leva minutos e, aqui dentro, parava as
        // páginas de todos os sites (medido em 2026-11-02: ~2 min por página). A
        // fila vazia continua sendo alimentada: o tick seguinte já vê o que entrou.
        self.spawn_discovery();
        let limit = self.config.max_parallel.max(1);
        // Sites de molho não entram no claim (Fase 0): a store pula-os.
        let skip = self.config.site_clock.waiting_sites(now);
        let batch = with_store(self.store.clone(), move |db| {
            db.take_next_batch(limit, &skip)
        })
        .await?;
        if batch.is_empty() {
            return Ok(TickOutcome::Skipped("sem-fila"));
        }

        let ctx = self.batch_ctx();
        let claimed = batch.len();
        let handles: Vec<_> = batch
            .into_iter()
            .map(|row| {
                let ctx = ctx.clone();
                tokio::spawn(async move { run_one(ctx, row).await })
            })
            .collect();

        let (mut cost, mut delivered) = (0u32, 0usize);
        for handle in handles {
            match handle.await {
                Ok(report) => {
                    cost = cost.saturating_add(report.cost);
                    if report.delivered {
                        delivered += 1;
                    }
                }
                Err(e) => eprintln!("[motor] task abortada: {e}"),
            }
        }
        self.settle_budget(cost, delivered).await;
        Ok(TickOutcome::Processed { claimed, delivered })
    }

    /// Para o loop gracioso (termina o passo atual e sai).
    pub async fn stop(&self) {
        *self.running.lock().await = false;
    }

    /// Snapshot do motor para o painel (`GET /status` do sidecar).
    pub async fn status(&self) -> MotorStatus {
        MotorStatus {
            active: *self.running.lock().await,
            sites: self.snapshot_sites().await,
            pages_this_hour: *self.pages_this_hour.lock().await,
            global_paused: *self.global_paused.lock().await,
            // Fase 0: quem está de molho e quantos 429/503 o processo viu.
            holds: self.config.site_clock.holds(now_ms()),
            deferred_count: self.config.site_clock.deferred_count(),
        }
    }

    /// Abre e migra o `crawl.db` na primeira necessidade.
    pub(super) fn ensure_store(&self) -> Result<(), MotorError> {
        let mut guard = self
            .store
            .lock()
            .map_err(|e| MotorError::StoreError(format!("lock do store: {e}")))?;
        if guard.is_some() {
            return Ok(());
        }
        let db = CrawlStore::open(&self.config.db_path)
            .map_err(|e| MotorError::StoreError(format!("abrir {}: {e}", self.config.db_path)))?;
        db.migrate()
            .map_err(|e| MotorError::StoreError(e.to_string()))?;
        *guard = Some(db);
        Ok(())
    }
}

// Crash recovery e a foto por site do painel vivem em `site_snapshot.rs`
// — catraca de 400 linhas.
