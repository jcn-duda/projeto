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
            is_priority: Box::new(|batch: &[String]| batch.iter().any(|i| i.starts_with("após"))),
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
