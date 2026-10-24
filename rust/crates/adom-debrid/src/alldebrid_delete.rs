//! Fila de `/magnet/delete` da limpeza nativa da AllDebrid — porte de
//! `deleteMagnetsNow` (`src/debrid/alldebrid-cleanup.ts`).
//!
//! Disparar ~50 deletes em paralelo fazia a AllDebrid devolver 503 em parte
//! deles (medido no Node: 13 de 45 numa busca), e cada falha deixava um magnet
//! na conta para sempre. Aqui:
//!
//! - **gate por conta**: uma execução em voo por conta (a chave é o
//!   `accountScope`, sem segredo); as demais esperam, como o `enqueueDelete`;
//! - **4 workers** dentro da execução, backoff 400 → 800 → 1600 ms e UMA
//!   segunda rodada para o que falhou (a rajada já passou);
//! - **quota/auth** param a execução inteira ([`DeleteStop`]) — insistir num
//!   `MAGNET_TOO_MANY` só gasta o teto; rate limit NÃO é terminal e usa o
//!   `Retry-After` quando vem;
//! - **kill-switch** `DEBRID_AL_CLEANUP_KILL` é relido a cada tentativa.
//!
//! A fila é sempre fire-and-forget no chamador: nunca segura a resposta do
//! `/stream` (o Node também não espera). Falha some no log, nunca no veredito.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinSet;

use crate::alldebrid::AllDebrid;
use crate::alldebrid_cleanup::{
    account_scope, bump, kill_switch_on, METRIC_FAILED, METRIC_REMOVED, METRIC_STOPPED,
};

pub const BACKOFF_ENV: &str = "DEBRID_AL_CLEANUP_BACKOFF_MS";
pub const CONCURRENCY_ENV: &str = "DEBRID_AL_CLEANUP_CONCURRENCY";
/// Teto do `Retry-After`: um header absurdo não prende a fila por minutos.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteStop {
    /// Conta sem vaga (`MAGNET_TOO_MANY*`): parar tudo.
    Quota,
    /// Chave recusada: parar tudo.
    Auth,
    /// `DEBRID_AL_CLEANUP_KILL` ligou no meio da execução.
    KillSwitch,
}

impl DeleteStop {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Auth => "auth",
            Self::KillSwitch => "kill_switch",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DeleteReport {
    /// Ids que SAÍRAM de verdade (prova para o `adrm`/purga futuros).
    pub removed: Vec<String>,
    /// Ids que continuam na conta depois de todas as rodadas.
    pub failed: Vec<String>,
    pub stopped: Option<DeleteStop>,
    /// Chamadas HTTP feitas (inclui retentativas).
    pub attempts: usize,
}

#[derive(Debug, Clone)]
pub struct DeleteConfig {
    pub delays: Vec<Duration>,
    pub concurrency: usize,
    pub rounds: usize,
    /// Override do kill-switch (`None` = lê `DEBRID_AL_CLEANUP_KILL`). Existe
    /// para os testes não dependerem de env global.
    pub kill: Option<bool>,
}

impl Default for DeleteConfig {
    fn default() -> Self {
        Self {
            delays: vec![
                Duration::from_millis(400),
                Duration::from_millis(800),
                Duration::from_millis(1_600),
            ],
            concurrency: 4,
            rounds: 2,
            kill: None,
        }
    }
}

impl DeleteConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();
        if let Some(delays) = std::env::var(BACKOFF_ENV)
            .ok()
            .and_then(|raw| parse_delays(&raw))
        {
            config.delays = delays;
        }
        if let Ok(raw) = std::env::var(CONCURRENCY_ENV) {
            if let Ok(value) = raw.trim().parse::<usize>() {
                config.concurrency = value.clamp(1, 8);
            }
        }
        config
    }

    /// Sem espera E sem env global: os testes não podem depender do
    /// `DEBRID_AL_CLEANUP_KILL` do processo — outra suíte o liga em paralelo e
    /// a fila voltava vazia (removed=[], stopped=KillSwitch) de forma
    /// intermitente. Quem testa o kill-switch passa `kill` explícito.
    pub fn fast() -> Self {
        Self {
            delays: Vec::new(),
            concurrency: 4,
            rounds: 2,
            kill: Some(false),
        }
    }

    fn killed(&self) -> bool {
        self.kill.unwrap_or_else(kill_switch_on)
    }

    fn attempts(&self) -> usize {
        self.delays.len().max(1)
    }

    fn delay(&self, attempt: usize) -> Duration {
        self.delays
            .get(attempt)
            .or_else(|| self.delays.last())
            .copied()
            .unwrap_or_default()
    }
}

fn parse_delays(raw: &str) -> Option<Vec<Duration>> {
    let values: Vec<u64> = raw
        .split(',')
        .filter_map(|part| part.trim().parse::<u64>().ok())
        .collect();
    // Lista vazia/inválida mantém o default; `0` é espera zero (teste manual).
    (!values.is_empty()).then(|| values.into_iter().map(Duration::from_millis).collect())
}

/// Gate único por conta: só UMA execução de delete em voo por conta (o Node
/// chegava a 5 × 4 deletes concorrentes na mesma conta e tomava rajada de 503).
static GATES: LazyLock<Mutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn gate_for(account: &str) -> Arc<AsyncMutex<()>> {
    let mut guard = GATES.lock().unwrap_or_else(|err| err.into_inner());
    guard
        .entry(account.to_string())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

/// Apaga os ids com backoff e segunda rodada. A conta é derivada da `api_key`
/// (nunca logada) e serializa as execuções concorrentes.
pub async fn delete_with_backoff(
    ad: &AllDebrid,
    api_key: &str,
    ids: &[String],
    config: DeleteConfig,
) -> DeleteReport {
    if ids.is_empty() {
        return DeleteReport::default();
    }
    if config.killed() {
        bump(METRIC_STOPPED, 1);
        return DeleteReport {
            failed: ids.to_vec(),
            stopped: Some(DeleteStop::KillSwitch),
            ..DeleteReport::default()
        };
    }
    let gate = gate_for(&account_scope(api_key));
    // Sem preempção: quem chegou depois espera a execução anterior assentar.
    let _guard = gate.lock().await;
    if config.killed() {
        bump(METRIC_STOPPED, 1);
        return DeleteReport {
            failed: ids.to_vec(),
            stopped: Some(DeleteStop::KillSwitch),
            ..DeleteReport::default()
        };
    }

    let mut report = DeleteReport::default();
    let mut pending: Vec<String> = ids.to_vec();
    let rounds = config.rounds.max(1);
    for round in 0..rounds {
        if pending.is_empty() || report.stopped.is_some() {
            break;
        }
        let outcome = run_round(ad, api_key, &pending, &config).await;
        report.removed.extend(outcome.removed);
        report.attempts += outcome.attempts;
        report.stopped = outcome.stopped;
        let last = round + 1 == rounds;
        if report.stopped.is_some() || last {
            report.failed.extend(outcome.failed);
            pending.clear();
        } else {
            // A fila curta drenou e a rajada passou: a segunda rodada é a
            // tentativa séria, como no Node.
            pending = outcome.failed;
        }
    }
    bump(METRIC_REMOVED, report.removed.len() as u64);
    bump(METRIC_FAILED, report.failed.len() as u64);
    if report.stopped.is_some() {
        bump(METRIC_STOPPED, 1);
    }
    report
}

struct RoundOutcome {
    removed: Vec<String>,
    failed: Vec<String>,
    stopped: Option<DeleteStop>,
    attempts: usize,
}

#[derive(Default)]
struct WorkerReport {
    removed: Vec<String>,
    failed: Vec<String>,
}

async fn run_round(
    ad: &AllDebrid,
    api_key: &str,
    ids: &[String],
    config: &DeleteConfig,
) -> RoundOutcome {
    let queue = Arc::new(Mutex::new(VecDeque::from(ids.to_vec())));
    let stopped: Arc<Mutex<Option<DeleteStop>>> = Arc::new(Mutex::new(None));
    let attempts = Arc::new(AtomicUsize::new(0));
    let workers = config.concurrency.max(1).min(ids.len());
    let mut set = JoinSet::new();
    for _ in 0..workers {
        set.spawn(worker(
            ad.clone(),
            api_key.to_string(),
            queue.clone(),
            stopped.clone(),
            attempts.clone(),
            config.clone(),
        ));
    }
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(report) => {
                removed.extend(report.removed);
                failed.extend(report.failed);
            }
            // Panic de worker não pode derrubar a execução; o id que estava na
            // mão dele fica sem prova, o resto da fila é drenado abaixo.
            Err(_) => eprintln!("[alldebrid] worker da fila de delete abortou"),
        }
    }
    // Execução interrompida (quota/auth/kill) deixa ids na fila: eles NÃO
    // saíram da conta e precisam aparecer como falha, nunca sumir.
    failed.extend(
        queue
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .drain(..),
    );
    let stopped = *stopped.lock().unwrap_or_else(|err| err.into_inner());
    RoundOutcome {
        removed,
        failed,
        stopped,
        attempts: attempts.load(Ordering::Relaxed),
    }
}

async fn worker(
    ad: AllDebrid,
    api_key: String,
    queue: Arc<Mutex<VecDeque<String>>>,
    stopped: Arc<Mutex<Option<DeleteStop>>>,
    attempts: Arc<AtomicUsize>,
    config: DeleteConfig,
) -> WorkerReport {
    let mut report = WorkerReport::default();
    loop {
        if stopped
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .is_some()
        {
            break;
        }
        let Some(id) = queue
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .pop_front()
        else {
            break;
        };
        let mut removed = false;
        for attempt in 0..config.attempts() {
            if config.killed() {
                *stopped.lock().unwrap_or_else(|err| err.into_inner()) =
                    Some(DeleteStop::KillSwitch);
                break;
            }
            attempts.fetch_add(1, Ordering::Relaxed);
            match ad.delete_ids(&api_key, std::slice::from_ref(&id)).await {
                Ok(()) => {
                    removed = true;
                    report.removed.push(id.clone());
                    break;
                }
                Err(err) => {
                    match err.kind() {
                        // Terminal: o teto da conta derruba até o delete.
                        "quota" => {
                            *stopped.lock().unwrap_or_else(|err| err.into_inner()) =
                                Some(DeleteStop::Quota);
                            break;
                        }
                        "auth" => {
                            *stopped.lock().unwrap_or_else(|err| err.into_inner()) =
                                Some(DeleteStop::Auth);
                            break;
                        }
                        // Transitório: respeita o Retry-After (se veio) ou usa o
                        // backoff da rodada. NUNCA vira `unusable` da checagem.
                        "rate_limit" => {
                            let wait = err
                                .retry_after_ms()
                                .map(|ms| Duration::from_millis(ms).min(MAX_RETRY_AFTER))
                                .unwrap_or_else(|| config.delay(attempt));
                            sleep(wait).await;
                        }
                        // 503 em rajada/erro de rede: espera e tenta de novo.
                        _ => sleep(config.delay(attempt)).await,
                    }
                }
            }
        }
        if !removed {
            report.failed.push(id);
        }
    }
    report
}

async fn sleep(wait: Duration) {
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}
