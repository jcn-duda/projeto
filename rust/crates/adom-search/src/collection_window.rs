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

use adom_core::{compute_collection_budget, compute_priority_grace};

/// Valores de config que governam a janela.
///
/// Defaults = os do `src/config/search.ts`: `REPLY_DEADLINE_MS` 9200,
/// `DEBRID_RESERVE_MS` 4500, `DEBRID_CHECK_FLOOR_MS` 1500,
/// `BR_PARTIAL_GRACE_MS` 1500 e `SEARCH_TIMEOUT_MS` 8000 (total próprio de
/// cada tarefa BR).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectBudgets {
    /// Prazo de resposta deste cliente (`reply_deadline_ms` já escolheu).
    pub reply_deadline_ms: i64,
    /// Reserva da checagem de debrid (`DEBRID_RESERVE_MS`): sai do prazo ANTES
    /// de se calcular o orçamento de coleta.
    pub debrid_reserve_ms: i64,
    /// Piso que a graça BR nunca pode invadir (`DEBRID_CHECK_FLOOR_MS`).
    pub debrid_check_floor_ms: i64,
    /// Janela extra da primeira fonte BR (`BR_PARTIAL_GRACE_MS`).
    pub br_partial_grace_ms: i64,
    /// Total PRÓPRIO de cada tarefa BR (`SEARCH_TIMEOUT_MS`): fonte BR não
    /// compete com os globais pelo orçamento da resposta.
    pub br_total_ms: i64,
}

impl Default for CollectBudgets {
    fn default() -> Self {
        CollectBudgets {
            reply_deadline_ms: 9200,
            debrid_reserve_ms: 4500,
            debrid_check_floor_ms: 1500,
            br_partial_grace_ms: 1500,
            br_total_ms: 8000,
        }
    }
}

impl CollectBudgets {
    /// Orçamento de coleta dentro do prazo da resposta — fórmula única no
    /// núcleo (`adom_core::collection_budget`), com piso 500ms (com prazo) /
    /// 1000ms (sem prazo). O `DEBRID_RESERVE_MS` já foi subtraído aqui: a
    /// coleta NUNCA come o tempo da checagem de debrid.
    pub fn collection_budget(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        compute_collection_budget(
            deadline_at,
            now,
            self.reply_deadline_ms,
            self.debrid_reserve_ms,
        )
    }

    /// Graça da primeira fonte BR, recortada de dentro da reserva e nunca
    /// abaixo do piso do debrid — fórmula do núcleo.
    pub fn priority_grace(&self) -> i64 {
        compute_priority_grace(
            self.br_partial_grace_ms,
            self.debrid_reserve_ms,
            self.debrid_check_floor_ms,
        )
    }

    /// Prazo ABSOLUTO (relógio, ms desde a época) de uma tarefa BR: total
    /// próprio (`searchTimeout`), cortado pelo prazo da resposta quando este
    /// vence antes. Fonte BR não usa o orçamento dos globais — o corte dela é
    /// `min(deadline, now + br_total)`, exatamente o padrão de
    /// `search-multiwork.ts` (`TMDB_COLLECTION_TIMEOUT_MS`).
    pub fn br_deadline(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        let own = now.saturating_add(self.br_total_ms);
        match deadline_at {
            Some(d) => d.min(own),
            None => own,
        }
    }

    /// Milissegundos que a tarefa BR ainda tem a partir de `now`.
    pub fn br_budget_ms(&self, deadline_at: Option<i64>, now: i64) -> i64 {
        self.br_deadline(deadline_at, now)
            .saturating_sub(now)
            .max(0)
    }
}

/// Deadline ABSOLUTO de um salto (degrau sequencial de cascata: fallback EN,
/// variante arábica, franquia, multiobra, original). O degrau herda o teto da
/// tarefa: `min(deadline_at, now + cap_ms)`. Sem teto (`None`), vale só o cap.
///
/// O salto nunca ESTICA a tarefa: quando `deadline_at` vence antes do cap, o
/// prazo absoluto é o da resposta — quem executa corta no relógio e devolve o
/// que deu tempo de coletar (devolução parcial).
pub fn jump_deadline(deadline_at: Option<i64>, now: i64, cap_ms: i64) -> Option<i64> {
    let capped = now.saturating_add(cap_ms);
    Some(match deadline_at {
        Some(d) => d.min(capped),
        None => capped,
    })
}

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
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::*;

    fn sleep_ms(ms: u64) -> impl Future<Output = Result<Vec<String>, String>> + Send {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(vec![format!("após {ms}ms")])
        })
    }

    fn ok_items(items: &[&str]) -> impl Future<Output = Result<Vec<String>, String>> + Send {
        let owned: Vec<String> = items.iter().map(|s| s.to_string()).collect();
        async move { Ok(owned) }
    }

    fn any_batch(batch: &[String]) -> bool {
        !batch.is_empty()
    }

    // --- Orçamento global vs BR -------------------------------------------

    #[test]
    fn orcamento_global_subtrai_reserva_de_debrid_com_piso() {
        let budgets = CollectBudgets {
            reply_deadline_ms: 9200,
            debrid_reserve_ms: 4500,
            ..CollectBudgets::default()
        };
        // Sem prazo: replyDeadline - debridReserve, piso 1000ms.
        assert_eq!(budgets.collection_budget(None, 0), 9200 - 4500);
        // Com prazo vencido: piso 500ms, nunca 0 (tentativa real > known:false).
        assert_eq!(budgets.collection_budget(Some(100), 500), 500);
        // Com prazo: (deadline - now) - reserva.
        assert_eq!(
            budgets.collection_budget(Some(9000), 300),
            9000 - 300 - 4500
        );
        // Reserva corroe o prazo: piso entra em vez de negativo.
        assert_eq!(budgets.collection_budget(Some(1000), 9000), 500);
    }

    #[test]
    fn br_tem_orcamento_proprio_fora_do_global() {
        let budgets = CollectBudgets {
            reply_deadline_ms: 9200,
            debrid_reserve_ms: 4500,
            br_total_ms: 8000,
            ..CollectBudgets::default()
        };
        let now = 1_000_000;
        // O global sofre a reserva; o BR não: total próprio cheio.
        assert_eq!(budgets.collection_budget(None, now), 4700);
        assert_eq!(budgets.br_budget_ms(None, now), 8000);
        // Prazo absoluto da resposta corta o total próprio do BR.
        assert_eq!(budgets.br_deadline(Some(now + 3000), now), now + 3000);
        // Total próprio vence antes do prazo: vale o total.
        assert_eq!(budgets.br_deadline(Some(now + 9000), now), now + 8000);
        // Sem prazo de resposta, o BR não tem teto além do próprio.
        assert_eq!(budgets.br_deadline(None, now), now + 8000);
    }

    // --- Deadline absoluto por salto ---------------------------------------

    #[test]
    fn salto_hereda_o_teto_absoluto_da_tarefa() {
        let now = 10_000;
        // Cap maior que o prazo: vence o prazo (o salto não estica a tarefa).
        assert_eq!(jump_deadline(Some(now + 2000), now, 5000), Some(now + 2000));
        // Cap menor: vale o cap.
        assert_eq!(jump_deadline(Some(now + 9000), now, 1200), Some(now + 1200));
        // Sem teto: só o cap.
        assert_eq!(jump_deadline(None, now, 700), Some(now + 700));
        // Prazo já vencido: o salto devolve o passado e quem executa corta já.
        assert_eq!(jump_deadline(Some(now - 50), now, 500), Some(now - 50));
    }

    // --- Reserva de debrid --------------------------------------------------

    #[test]
    fn graca_br_e_recortada_da_reserva_sem_invadir_o_piso() {
        // Caso real: graça 1500, reserva 4500, piso 1500 → graça integral.
        let budgets = CollectBudgets::default();
        assert_eq!(budgets.priority_grace(), 1500);
        // Reserva apertada: graça encolhe para reserva - piso.
        let apertada = CollectBudgets {
            debrid_reserve_ms: 2000,
            debrid_check_floor_ms: 1500,
            br_partial_grace_ms: 1500,
            ..CollectBudgets::default()
        };
        assert_eq!(apertada.priority_grace(), 500);
        // Reserva menor que o piso: graça 0 (o debrid tem sempre o dele).
        let minima = CollectBudgets {
            debrid_reserve_ms: 1000,
            debrid_check_floor_ms: 1500,
            br_partial_grace_ms: 1500,
            ..CollectBudgets::default()
        };
        assert_eq!(minima.priority_grace(), 0);
    }

    // --- Janela: corte por prazo com devolução parcial ----------------------

    #[tokio::test]
    async fn orcamento_estourado_devolve_parcial_e_o_resto_chega_no_completion() {
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["rápido"])),
                CollectTask::global(sleep_ms(200)),
            ],
            CollectWindowOptions::new(30, Box::new(any_batch)),
        )
        .await;

        assert!(!window.done, "a lenta não assentou dentro do orçamento");
        assert_eq!(window.items, vec!["rápido".to_string()]);

        // O passe tardio recebe a lista COMPLETA (devolução parcial + fundo).
        let full = window.completion.await.expect("completion não pode falhar");
        assert_eq!(full.len(), 2);
        assert!(full.contains(&"rápido".to_string()));
        assert!(full.contains(&"após 200ms".to_string()));
    }

    #[tokio::test]
    async fn tudo_dentro_do_prazo_e_resposta_completa() {
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["a"])),
                CollectTask::global(ok_items(&["b"])),
            ],
            CollectWindowOptions::new(100, Box::new(any_batch)),
        )
        .await;

        assert!(window.done);
        assert_eq!(window.items.len(), 2);
        assert_eq!(window.completion.await.expect("completion").len(), 2);
    }

    #[tokio::test]
    async fn falha_de_provider_nao_derruba_a_janela() {
        let window = collect_within_window(
            vec![
                CollectTask::global(async { Err("indexer caiu".to_string()) }),
                CollectTask::global(ok_items(&["vivo"])),
            ],
            CollectWindowOptions::new(100, Box::new(any_batch)),
        )
        .await;

        assert!(window.done);
        assert_eq!(window.items, vec!["vivo".to_string()]);
    }

    // --- Graça da primeira fonte BR -----------------------------------------

    #[tokio::test]
    async fn graca_inclui_a_primeira_fonte_br_que_chega_depois_do_orcamento() {
        // Global rápido; BR prioritário chega depois do orçamento, dentro da
        // graça — tem de entrar na primeira resposta (é o caso Disclosure Day).
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["global"])),
                CollectTask::br(sleep_ms(80)),
            ],
            CollectWindowOptions {
                budget_ms: 30,
                priority_grace_ms: 300,
                grace_requires_items: false,
                is_priority: Box::new(|batch: &[String]| {
                    batch.iter().any(|i| i.starts_with("após"))
                }),
                stop_when: None,
                on_batch: None,
                on_error: None,
            },
        )
        .await;

        assert!(!window.done);
        assert!(window.priority_seen, "a BR chegou dentro da graça");
        assert_eq!(window.items.len(), 2, "global + BR na mesma resposta");
    }

    #[tokio::test]
    async fn graca_estoura_sem_br_e_a_resposta_sai_mesmo_assim() {
        let started = tokio::time::Instant::now();
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["global"])),
                CollectTask::br(sleep_ms(5000)),
            ],
            CollectWindowOptions {
                budget_ms: 20,
                priority_grace_ms: 40,
                grace_requires_items: false,
                is_priority: Box::new(|_: &[String]| false),
                stop_when: None,
                on_batch: None,
                on_error: None,
            },
        )
        .await;

        assert!(!window.done);
        assert!(!window.priority_seen);
        assert_eq!(window.items, vec!["global".to_string()]);
        // Orçamento + graça, não os 5s da BR.
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[tokio::test]
    async fn graca_com_exigencia_de_itens_nao_vale_para_balde_vazio() {
        // Série com fallback de pack: balde vazio não pode gastar a graça
        // esperando BR — a espera sairia do tempo do pack.
        let started = tokio::time::Instant::now();
        let window = collect_within_window(
            vec![CollectTask::br(sleep_ms(2000))],
            CollectWindowOptions {
                budget_ms: 20,
                priority_grace_ms: 500,
                grace_requires_items: true,
                is_priority: Box::new(|_: &[String]| true),
                stop_when: None,
                on_batch: None,
                on_error: None,
            },
        )
        .await;

        assert!(!window.priority_seen);
        assert!(started.elapsed() < Duration::from_millis(400));
    }

    // --- Parada antecipada (fast-path da conta) ------------------------------

    #[tokio::test]
    async fn stop_when_antecipa_a_resposta_e_o_resto_vai_para_o_fundo() {
        let batches_seen = Arc::new(AtomicUsize::new(0));
        let seen = batches_seen.clone();
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["conta-1", "conta-2", "conta-3"])),
                CollectTask::global(sleep_ms(300)),
            ],
            CollectWindowOptions {
                budget_ms: 5000,
                priority_grace_ms: 0,
                grace_requires_items: false,
                is_priority: Box::new(|_: &[String]| false),
                stop_when: Some(Box::new(
                    move |batch: &[String], _: &[String], meta: &BatchMeta| {
                        seen.fetch_add(1, Ordering::SeqCst);
                        meta.source.is_none() && batch.len() >= 3
                    },
                )),
                on_batch: None,
                on_error: None,
            },
        )
        .await;

        assert!(window.stopped_early, "fast-path disparou");
        assert!(!window.done);
        assert_eq!(window.items.len(), 3);
        let full = window.completion.await.expect("completion");
        assert_eq!(full.len(), 4, "a lenta chegou no fundo");
        assert!(batches_seen.load(Ordering::SeqCst) >= 1);
    }

    #[tokio::test]
    async fn on_batch_observa_lotes_com_o_balde_acumulado() {
        // O lote entra no balde antes da mensagem: a ordem entre os callbacks
        // não é determinística, então o teste é agnóstico — dois callbacks,
        // cada um vendo entre 1 e 2 itens.
        let calls = Arc::new(AtomicUsize::new(0));
        let seen_lens = Arc::new(Mutex::new(Vec::<usize>::new()));
        let (c, lens) = (calls.clone(), seen_lens.clone());
        let window = collect_within_window(
            vec![
                CollectTask::global(ok_items(&["a"])),
                CollectTask::global(ok_items(&["b"])),
            ],
            CollectWindowOptions {
                budget_ms: 100,
                priority_grace_ms: 0,
                grace_requires_items: false,
                is_priority: Box::new(|_: &[String]| false),
                stop_when: None,
                on_batch: Some(Box::new(
                    move |_: &[String], all: &[String], _: &BatchMeta| {
                        c.fetch_add(1, Ordering::SeqCst);
                        lens.lock().expect("lens").push(all.len());
                    },
                )),
                on_error: None,
            },
        )
        .await;

        assert!(window.done);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        for len in seen_lens.lock().expect("lens").iter() {
            assert!((1..=2).contains(len), "balde acumulado visto: {len}");
        }
    }
}
