//! Porte da JANELA DE COLETA (`src/providers/collection-window.ts`) e dos
//! orçamentos que a governam (`collection-budget.ts` + config de busca).
//!
//! Este módulo é o lado de execução da coleta — o PLANO (quem vira tarefa) já
//! mora em `adom_core::search_plan` e a FÓRMULA pura do orçamento em
//! `adom_core::collection_budget`; aqui vive o que o TS faz com Promise e o
//! tokio faz com tasks:
//!
//! - **orçamentos com config**: `CollectBudgets` carrega os valores do operador
//!   (o TS lê `config.*` dentro das funções; aqui quem lê é o chamador) e
//!   delega a fórmula ao núcleo;
//! - **orçamento BR separado dos globais**: indexers globais cabem no orçamento
//!   da resposta; BR não — têm total próprio (`SEARCH_TIMEOUT_MS`) e só podem
//!   ser limitados pelo prazo ABSOLUTO da resposta, nunca pela fatia global;
//! - **saltos com deadline absoluto**: os degraus sequenciais de cascata
//!   (fallback EN, variante arábica, franquia, multiobra, original) precisam
//!   caber dentro do prazo original da tarefa — `jump_deadline` devolve o teto
//!   `min(prazo_da_resposta, agora + cap)`, o padrão de `search-multiwork.ts`;
//! - **reserva de debrid**: `DEBRID_RESERVE_MS` sai do prazo ANTES da coleta
//!   (o resto é da checagem de cache), e a graça da primeira fonte BR é
//!   recortada DE DENTRO da reserva sem invadir o piso do debrid;
//! - **janela**: `collect_within_window` coleta as tarefas até o orçamento,
//!   com parada antecipada (`stop_when`, fast-path da conta) e graça para a
//!   primeira fonte BR quando só globais chegaram. O que não assentou continua
//!   em fundo: o `completion` devolve depois a lista COMPLETA — quem a consome
//!   é o passe tardio (recache), igual ao `Promise` de completion do TS.

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "collection_window_budgets.rs"]
mod collection_window_budgets;
pub use collection_window_budgets::*;

fn ms_dur(ms: i64) -> Duration {
    Duration::from_millis(ms.max(0) as u64)
}

/// Metadado do lote, espelhando o objeto `{ priority, source }` do TS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchMeta {
    /// Tarefa prioritária = fonte BR.
    pub priority: bool,
    /// Identificação da fonte (`account` é neutra na instrumentação I0).
    pub source: Option<String>,
}

/// Uma tarefa de coleta: o futuro que devolve o lote (ou o motivo da falha —
/// falha de rede NUNCA derruba a busca), se é prioritária (BR) e a fonte.
pub struct CollectTask<T> {
    pub fut: std::pin::Pin<Box<dyn Future<Output = Result<Vec<T>, String>> + Send>>,
    pub priority: bool,
    pub source: Option<String>,
}

impl<T> CollectTask<T> {
    /// Atalho para o caso comum: fonte global, sem nome.
    pub fn global(
        fut: impl Future<Output = Result<Vec<T>, String>> + Send + 'static,
    ) -> CollectTask<T> {
        CollectTask {
            fut: Box::pin(fut),
            priority: false,
            source: None,
        }
    }

    /// Tarefa BR (prioritária): entra na graça, não no orçamento global.
    pub fn br(
        fut: impl Future<Output = Result<Vec<T>, String>> + Send + 'static,
    ) -> CollectTask<T> {
        CollectTask {
            fut: Box::pin(fut),
            priority: true,
            source: None,
        }
    }
}

/// Opções da janela, espelhando `CollectWindowOptions` do TS.
pub struct CollectWindowOptions<T> {
    /// Orçamento normal da coleta (ms). Obrigatório na prática; o default 0
    /// só existe para chamadas vazias.
    pub budget_ms: i64,
    /// Janela extra para a primeira fonte BR.
    pub priority_grace_ms: i64,
    /// A graça só vale com itens no balde: quem tem fallback de pack (série)
    /// não pode gastá-la esperando fonte BR numa busca que não trouxe nada.
    pub grace_requires_items: bool,
    /// `isPriority` do TS: um lote recém-chegado é da fonte prioritária? O
    /// default do TS é `items.some(isBr)`; aqui quem decide é o chamador.
    pub is_priority: PriorityCheck<T>,
    /// Parada antecipada: devolvendo `true` para um lote, a resposta sai NA
    /// HORA com o que há no balde (fast-path da conta) e o resto segue em fundo.
    pub stop_when: Option<StopCheck<T>>,
    /// Observador de lote (`onBatch`): recache intermediário do passe tardio.
    pub on_batch: Option<BatchObserver<T>>,
    /// Falha de provider (`onError`): log, nunca pânico.
    pub on_error: Option<ErrorObserver>,
}

impl<T> CollectWindowOptions<T> {
    /// Só o obrigatório; o resto igual ao default do TS.
    pub fn new(budget_ms: i64, is_priority: PriorityCheck<T>) -> Self {
        CollectWindowOptions {
            budget_ms,
            priority_grace_ms: 0,
            grace_requires_items: false,
            is_priority,
            stop_when: None,
            on_batch: None,
            on_error: None,
        }
    }
}

enum Msg<T> {
    Batch { batch: Vec<T>, meta: BatchMeta },
    PriorityTaskDone,
    Failed(String),
}

/// Aliases dos callbacks da janela (só para ler as assinaturas).
type PriorityCheck<T> = Box<dyn Fn(&[T]) -> bool + Send>;
type StopCheck<T> = Box<dyn Fn(&[T], &[T], &BatchMeta) -> bool + Send>;
type BatchObserver<T> = Box<dyn Fn(&[T], &[T], &BatchMeta) + Send>;
type ErrorObserver = Box<dyn Fn(&str) + Send>;

/// Resultado da janela, espelhando o retorno de `collectWithinWindow`.
///
/// `items` é o balde NO MOMENTO do retorno; `completion` aguarda o resto em
/// fundo e devolve a lista COMPLETA — é o que o passe tardio recacheia.
/// `done = true` significa que todas as tarefas assentaram dentro da janela
/// (resposta completa, cacheável).
pub struct CollectWindow<T> {
    pub items: Vec<T>,
    pub done: bool,
    pub completion: tokio::task::JoinHandle<Vec<T>>,
    pub priority_seen: bool,
    pub stopped_early: bool,
}

/// Porte de `collectWithinWindow`: coleta as tarefas até o orçamento; se só
/// chegaram fontes globais, concede a graça curta para a primeira fonte BR.
///
/// Cada tarefa roda numa task tokio própria (quem estoura orçamento NÃO pode
/// compartilhar Future: um NerdFilmes de 7,4s não pode segurar o BLUDV fora do
/// balde). O balde é compartilhado por `Arc<Mutex<Vec<T>>>`: lote que chega
/// depois do retorno entra nele mesmo assim e aparece no `completion`.
pub async fn collect_within_window<T: Clone + Send + 'static>(
    tasks: Vec<CollectTask<T>>,
    opts: CollectWindowOptions<T>,
) -> CollectWindow<T> {
    let total = tasks.len();
    let mut pending_priority = tasks.iter().filter(|t| t.priority).count();
    let shared: Arc<Mutex<Vec<T>>> = Arc::new(Mutex::new(Vec::new()));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Msg<T>>();

    let mut handles = Vec::with_capacity(total);
    for mut task in tasks {
        let tx = tx.clone();
        let shared = shared.clone();
        let priority = task.priority;
        let meta = BatchMeta {
            priority,
            source: task.source.take(),
        };
        handles.push(tokio::spawn(async move {
            // Falha de rede vira aviso + lote vazio; a busca segue.
            let result = task.fut.await;
            let batch = match &result {
                Ok(batch) => batch.clone(),
                Err(err) => {
                    let _ = tx.send(Msg::Failed(err.clone()));
                    Vec::new()
                }
            };
            shared
                .lock()
                .expect("balde da coleta")
                .extend(batch.iter().cloned());
            // Se a janela já devolveu, o canal está fechado: enviar falha e
            // o lote ainda assim está no balde, que o `completion` devolve.
            let _ = tx.send(Msg::Batch { batch, meta });
            if priority {
                let _ = tx.send(Msg::PriorityTaskDone);
            }
        }));
    }
    // Sem clonar tx para o erro (o callback vive nas opts, movidas para baixo):
    // o erro só zera o lote aqui; o log do TS (`onError`) fica por conta do
    // chamador instrumentar via `on_batch`/futuro. Simples e fiel o bastante
    // para a fase: falha NUNCA propaga.
    drop(tx);

    let mut priority_seen = false;
    let mut stopped_early = false;
    let mut done = false;

    // Fase 1 — corrida até o orçamento normal.
    {
        let deadline = tokio::time::Instant::now() + ms_dur(opts.budget_ms);
        loop {
            let budget_left = tokio::time::sleep_until(deadline);
            tokio::select! {
                _ = budget_left => break,
                msg = rx.recv() => match msg {
                    None => { done = true; break; }
                    Some(Msg::PriorityTaskDone) => {
                        pending_priority = pending_priority.saturating_sub(1);
                    }
                    Some(Msg::Failed(err)) => {
                        if let Some(on_error) = &opts.on_error {
                            on_error(&err);
                        }
                    }
                    Some(Msg::Batch { batch, meta }) => {
                        let items_now = shared.lock().expect("balde da coleta").clone();
                        if let Some(on_batch) = &opts.on_batch {
                            on_batch(&batch, &items_now, &meta);
                        }
                        if !priority_seen && (opts.is_priority)(&batch) {
                            priority_seen = true;
                        }
                        if let Some(stop_when) = &opts.stop_when {
                            if (stop_when)(&batch, &items_now, &meta) {
                                stopped_early = true;
                                break;
                            }
                        }
                    }
                },
            }
        }
    }

    // Fase 2 — graça da primeira fonte BR. Mesma condição do TS: sem `done`,
    // sem stop antecipado, nenhum lote prioritário ainda, resta tarefa BR
    // pendente, há graça e (quando exigido) o balde não está vazio.
    if !done
        && !stopped_early
        && !priority_seen
        && pending_priority > 0
        && opts.priority_grace_ms > 0
        && (!opts.grace_requires_items || !shared.lock().expect("balde da coleta").is_empty())
    {
        let deadline = tokio::time::Instant::now() + ms_dur(opts.priority_grace_ms);
        loop {
            let grace_left = tokio::time::sleep_until(deadline);
            tokio::select! {
                _ = grace_left => break,
                msg = rx.recv() => match msg {
                    None => { done = true; break; }
                    Some(Msg::PriorityTaskDone) => {
                        pending_priority = pending_priority.saturating_sub(1);
                        // `priorityDone`: a última prioritária resolve a corrida.
                        if pending_priority == 0 { break; }
                    }
                    Some(Msg::Failed(err)) => {
                        if let Some(on_error) = &opts.on_error {
                            on_error(&err);
                        }
                    }
                    Some(Msg::Batch { batch, meta }) => {
                        let items_now = shared.lock().expect("balde da coleta").clone();
                        if let Some(on_batch) = &opts.on_batch {
                            on_batch(&batch, &items_now, &meta);
                        }
                        // `priority`: a primeira fonte BR resolve a corrida na hora.
                        if !priority_seen && (opts.is_priority)(&batch) {
                            priority_seen = true;
                            break;
                        }
                        if let Some(stop_when) = &opts.stop_when {
                            if (stop_when)(&batch, &items_now, &meta) {
                                stopped_early = true;
                                break;
                            }
                        }
                    }
                },
            }
        }
    }

    // `done` real: se o canal ainda tem emissores, nem tudo assentou. O break
    // por orçamento/stop sai com `done=false`; o `None` do canal marca tudo
    // assentado. (O `done` da fase 2 já cobre a graça.)
    let completion_shared = shared.clone();
    let completion = tokio::spawn(async move {
        for handle in handles {
            let _ = handle.await;
        }
        let mut guard = completion_shared.lock().expect("balde da coleta");
        std::mem::take(&mut *guard)
    });

    let items = shared.lock().expect("balde da coleta").clone();
    CollectWindow {
        items,
        done,
        completion,
        priority_seen,
        stopped_early,
    }
}

#[cfg(test)]
#[path = "collection_window_tests.rs"]
mod tests;
