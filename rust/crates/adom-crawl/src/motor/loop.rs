//! Loop principal do motor do raspador (C4).
//!
//! Liga o `store` (crawl.db), o `sidecar` (entrega ao Node + freio de tráfego)
//! e a costura [`PageEngine`] (fetch+parse, que chega no C5): o loop não conhece
//! parser nenhum, conhece a trait.
//!
//! Um tick: pausa global → auto-pausa → teto por hora (custo REAL) → freio do
//! usuário → parser ligado? → `take_next_batch(max_parallel)` → uma `spawn` por
//! linha com `timeout(step_deadline_ms)` → POST ao Node → `mark_result`.
//!
//! As regras puras de decisão (backoff, status, esgotamento de `tries`) estão em
//! [`MarkResult::from_work`](crate::store::ops::MarkResult), ao lado do
//! `applyResult` do TS. Erro de rede nunca derruba o motor: é logado e o
//! próximo ciclo segue.

use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::Mutex;
use tokio::time::{interval, Duration};

use super::types::{
    error_work, now_ms, MotorConfig, MotorStatus, PageEngine, PageOutcome, SiteStatus,
    UnwiredPageEngine,
};
use crate::sidecar::activity::recent_user_traffic;
use crate::sidecar::http_client::SidecarHttpClient;
use crate::site_profiles::all_site_ids;
use crate::store::ops::{CrawlStore, MarkResult, StoreError, UrlRow};

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

/// Store compartilhado entre o tick e as tasks: `rusqlite::Connection` é `Send`
/// (não `Sync`), então o `Mutex` padrão é o que permite o `spawn_blocking`.
type StoreHandle = Arc<StdMutex<Option<CrawlStore>>>;

/// O que cada task precisa: tudo `Arc`/`Clone` para ir dentro do `spawn`.
#[derive(Clone)]
struct BatchCtx {
    engine: Arc<dyn PageEngine>,
    http: Arc<SidecarHttpClient>,
    store: StoreHandle,
    cfg: MotorConfig,
}

/// Custo e entrega de UMA linha trabalhada.
struct TaskReport {
    cost: u32,
    delivered: bool,
}

/// Uma task = uma URL: engine com prazo duro → POST → `mark_result`.
async fn run_one(ctx: BatchCtx, row: UrlRow) -> TaskReport {
    let deadline = Duration::from_millis(ctx.cfg.step_deadline_ms.max(1_000));
    let outcome = match tokio::time::timeout(deadline, ctx.engine.execute(&row)).await {
        Ok(o) => o,
        // Prazo duro: a geração é invalidada e a linha vira erro retentável.
        Err(_) => PageOutcome::TimedOut,
    };
    let work = match outcome {
        PageOutcome::Work(w) => *w,
        PageOutcome::Failed(msg) => {
            eprintln!("[motor] {} {}: {}", row.site, row.url_key, msg);
            error_work(&row, &msg)
        }
        PageOutcome::TimedOut => {
            eprintln!("[motor] {} {}: step-timeout", row.site, row.url_key);
            error_work(&row, "step-timeout")
        }
    };

    let delivered = match ctx.http.post_crawl_result(&work).await {
        Ok(()) => true,
        // Fail-open: o Node fora do ar não apaga o trabalho da página.
        Err(e) => {
            eprintln!("[motor] entrega recusada {}: {e}", row.url_key);
            false
        }
    };

    let mark = MarkResult::from_work(&row, &work, delivered, &ctx.cfg, now_ms());
    let (site, url_key, cost) = (row.site.clone(), row.url_key.clone(), work.request_cost);
    let alvo = format!("{site} {url_key}");
    if let Err(e) = with_store(ctx.store, move |db| db.mark_result(&site, &url_key, &mark)).await {
        eprintln!("[motor] falha ao marcar {alvo}: {e}");
    }
    TaskReport { cost, delivered }
}

/// Roda uma operação de SQLite fora da thread do runtime async.
async fn with_store<T, F>(store: StoreHandle, f: F) -> Result<T, MotorError>
where
    T: Send + 'static,
    F: FnOnce(&CrawlStore) -> Result<T, StoreError> + Send + 'static,
{
    let dentro = tokio::task::spawn_blocking(move || -> Result<T, MotorError> {
        let guard = store
            .lock()
            .map_err(|e| MotorError::StoreError(format!("lock do store: {e}")))?;
        let db = guard
            .as_ref()
            .ok_or_else(|| MotorError::StoreError("crawl.db não está aberto".into()))?;
        f(db).map_err(|e| MotorError::StoreError(e.to_string()))
    })
    .await
    .map_err(|e| MotorError::StoreError(format!("spawn_blocking: {e}")))?;
    dentro
}

/// Motor do raspador — loop principal.
pub struct CrawlMotor {
    config: MotorConfig,
    http: Arc<SidecarHttpClient>,
    engine: Arc<dyn PageEngine>,
    store: StoreHandle,
    running: Arc<Mutex<bool>>,
    global_paused: Arc<Mutex<bool>>,
    pages_this_hour: Arc<Mutex<u32>>,
    hour_started_at: Arc<Mutex<i64>>,
    pause_until: Arc<Mutex<i64>>,
    failure_streak: Arc<Mutex<u32>>,
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
            store: Arc::new(StdMutex::new(None)),
            running: Arc::new(Mutex::new(false)),
            global_paused: Arc::new(Mutex::new(false)),
            pages_this_hour: Arc::new(Mutex::new(0)),
            hour_started_at: Arc::new(Mutex::new(0)),
            pause_until: Arc::new(Mutex::new(0)),
            failure_streak: Arc::new(Mutex::new(0)),
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

        self.ensure_store()?;
        let limit = self.config.max_parallel.max(1);
        let batch = with_store(self.store.clone(), move |db| db.take_next_batch(limit)).await?;
        if batch.is_empty() {
            return Ok(TickOutcome::Skipped("sem-fila"));
        }

        let ctx = BatchCtx {
            engine: self.engine.clone(),
            http: self.http.clone(),
            store: self.store.clone(),
            cfg: self.config.clone(),
        };
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
        }
    }

    /// Abre e migra o `crawl.db` na primeira necessidade.
    fn ensure_store(&self) -> Result<(), MotorError> {
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

    /// Crash recovery: URLs presas em `inflight` voltam para a fila.
    async fn requeue_inflight_on_boot(&self) {
        let handle = self.store.clone();
        let sites = all_site_ids();
        let total = with_store(handle, move |db| {
            sites
                .iter()
                .try_fold(0u32, |acc, id| db.requeue_inflight(id).map(|n| acc + n))
        })
        .await
        .unwrap_or(0);
        if total > 0 {
            eprintln!("[motor] recovery: {total} URLs inflight voltaram para a fila");
        }
    }

    /// Fecha a janela de uma hora e zera o custo quando ela vence.
    async fn roll_hour_window(&self, now: i64) {
        let mut start = self.hour_started_at.lock().await;
        if *start == 0 || now - *start >= self.config.hour_window_ms as i64 {
            *start = now;
            *self.pages_this_hour.lock().await = 0;
        }
    }

    /// Cobra o custo real do lote e auto-pausa após lotes sem entrega.
    async fn settle_budget(&self, cost: u32, delivered: usize) {
        if cost > 0 {
            let mut spent = self.pages_this_hour.lock().await;
            *spent = spent.saturating_add(cost);
        }
        if delivered > 0 {
            *self.failure_streak.lock().await = 0;
            return;
        }
        let mut streak = self.failure_streak.lock().await;
        *streak = streak.saturating_add(1);
        if *streak >= self.config.error_pause_streak.max(1) {
            // Lotes inteiros sem entrega = Node fora do ar: dorme a janela.
            *self.pause_until.lock().await = now_ms() + self.config.hour_window_ms as i64;
            eprintln!("[motor] {streak} lotes sem entrega; auto-pausando a raspagem");
            *streak = 0;
        }
    }

    /// Contadores por site para o painel — uma única ida ao thread blocking.
    async fn snapshot_sites(&self) -> Vec<SiteStatus> {
        if self.ensure_store().is_err() {
            return Vec::new();
        }
        let ids = all_site_ids();
        with_store(self.store.clone(), move |db| {
            Ok(ids
                .iter()
                .filter_map(|id| {
                    let c = db.counters(id).ok()?;
                    Some(SiteStatus {
                        site_id: (*id).to_string(),
                        pending: c.pending,
                        done: c.done,
                        no_torrent: c.no_torrent,
                        error: c.error,
                        inflight: c.inflight,
                        releases: db.sum_releases(id).unwrap_or(0),
                    })
                })
                .collect())
        })
        .await
        .unwrap_or_default()
    }
}
