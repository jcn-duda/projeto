//! Testes do journal de execução e da outbox de invalidação (T1-B2).
//!
//! Dono do arquivo: `journal.rs`. A outbox entra aqui porque os dois são o
//! estado do MESMO drain — um segundo arquivo de teste só gastaria a catraca.

use adom_core::prefix;

use crate::journal::{journal_key, JOURNAL_PREFIX, JOURNAL_TTL_SECONDS};
use crate::outbox::{OUTBOX_DEAD_KEY, OUTBOX_KEY, OUTBOX_MAX_TRIES, OUTBOX_TTL_SECONDS};
use crate::queue::HARVEST_NAMESPACE;
use crate::store::HarvestStore;

#[test]
fn journal_guarda_um_estado_final_por_run_e_sobrescreve_o_anterior() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    store.journal_finish("run-1", "done", 1_200).unwrap();
    let run = store.journal_get("run-1", 1_300).unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(run.steps, vec!["index".to_string()]);
    assert_eq!(store.journal_keys(1_300).unwrap().len(), 1);
}

#[test]
fn journal_fail_grava_o_motivo_e_finish_o_limpa() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_fail("run-1", "preempted", 1_100).unwrap();
    let run = store.journal_get("run-1", 1_200).unwrap().unwrap();
    assert_eq!(run.status, "failed");
    assert_eq!(run.reason.as_deref(), Some("preempted"));
    assert_eq!(run.finished_ms, Some(1_100));

    // O último veredito é o que vale: um fechamento posterior não arrasta o
    // motivo do `fail`.
    store.journal_finish("run-1", "done", 1_300).unwrap();
    let run = store.journal_get("run-1", 1_400).unwrap().unwrap();
    assert_eq!(run.status, "done");
    assert_eq!(run.reason, None);
}

#[test]
fn outbox_sobrevive_e_entrega_uma_vez() {
    let store = HarvestStore::open_memory().unwrap();
    store.outbox_push("obra:tt1", 1_000).unwrap();
    store.outbox_push("obra:tt1", 1_001).unwrap();
    let lote = store.outbox_take(10, 1_002).unwrap();
    assert_eq!(lote.len(), 1, "dedupe por alvo");
    store.outbox_ack(&lote, 1_003).unwrap();
    assert!(store.outbox_take(10, 1_004).unwrap().is_empty());
}

#[test]
fn journal_step_nao_duplica_e_preserva_ordem() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    store.journal_step("run-1", "invalidated", 1_200).unwrap();
    store.journal_step("run-1", "index", 1_300).unwrap();
    let run = store.journal_get("run-1", 1_400).unwrap().unwrap();
    assert_eq!(
        run.steps,
        vec!["index".to_string(), "invalidated".to_string()]
    );
}

#[test]
fn journal_begin_idempotente_nao_apaga_steps() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_step("run-1", "index", 1_100).unwrap();
    store.journal_begin("run-1", "tt2", 1_200).unwrap();
    let run = store.journal_get("run-1", 1_300).unwrap().unwrap();
    assert_eq!(run.steps, vec!["index".to_string()], "step preservado");
    assert_eq!(run.started_ms, 1_000, "começo é o do primeiro begin");
    assert_eq!(run.obra, "tt1", "o segundo begin não sobrescreve o run");
    assert_eq!(run.status, "running");
    assert_eq!(run.finished_ms, None);
}

#[test]
fn journal_run_expirado_some_da_lista() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    // TTL de 24 h a partir do begin: 1 ms além já não é run vivo.
    let depois = 1_000 + 86_401_000;
    assert!(store.journal_keys(depois).unwrap().is_empty());
    assert_eq!(store.journal_get("run-1", depois).unwrap(), None);
    assert!(store.journal_keys(depois).unwrap().is_empty());
}

#[test]
fn journal_sem_run_nao_cria_nada() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_step("sumiu", "index", 1_000).unwrap();
    store.journal_finish("sumiu", "done", 1_100).unwrap();
    assert_eq!(store.journal_get("sumiu", 1_200).unwrap(), None);
    assert!(store.journal_keys(1_200).unwrap().is_empty());
}

#[test]
fn journal_com_json_podre_conta_como_ausente() {
    let store = HarvestStore::open_memory().unwrap();
    store
        .put_value(&journal_key("run-1"), "{podre", 60, 1_000)
        .unwrap();
    assert_eq!(store.journal_get("run-1", 1_100).unwrap(), None);
    // O begin substitui a linha podre: senão o run ficaria travado sem estado.
    store.journal_begin("run-1", "tt1", 1_200).unwrap();
    let run = store.journal_get("run-1", 1_300).unwrap().unwrap();
    assert_eq!(run.started_ms, 1_200);
}

#[test]
fn journal_forget_apaga_o_run() {
    let store = HarvestStore::open_memory().unwrap();
    store.journal_begin("run-1", "tt1", 1_000).unwrap();
    store.journal_forget("run-1").unwrap();
    store.journal_forget("run-1").unwrap();
    assert!(store.journal_keys(1_100).unwrap().is_empty());
}

#[test]
fn outbox_dead_letter_apos_tentativas() {
    let store = HarvestStore::open_memory().unwrap();
    store.outbox_push("obra:tt1", 1_000).unwrap();
    // Cinco tentativas vivas; a sexta estoura e vai para o cemitério.
    for attempt in 0..OUTBOX_MAX_TRIES {
        let lote = store.outbox_take(10, 1_100 + i64::from(attempt)).unwrap();
        assert_eq!(lote.len(), 1, "tentativa {}", attempt + 1);
        assert_eq!(lote[0].tries, attempt + 1);
    }
    let lote = store
        .outbox_take(10, 1_100 + i64::from(OUTBOX_MAX_TRIES))
        .unwrap();
    assert!(lote.is_empty(), "morto não volta no lote");
    assert!(store.outbox_pending(2_000).unwrap().is_empty());
    let dead = store.outbox_dead(2_000).unwrap();
    assert_eq!(dead.len(), 1, "o alvo não some em silêncio");
    assert_eq!(dead[0].tries, OUTBOX_MAX_TRIES + 1);
    assert!(store.outbox_take(10, 2_100).unwrap().is_empty());
}

#[test]
fn outbox_ack_idempotente() {
    let store = HarvestStore::open_memory().unwrap();
    store.outbox_push("obra:tt1", 1_000).unwrap();
    let lote = store.outbox_take(10, 1_100).unwrap();
    assert_eq!(lote.len(), 1);
    store.outbox_ack(&lote, 1_200).unwrap();
    store.outbox_ack(&lote, 1_300).unwrap();
    assert!(store.outbox_pending(1_400).unwrap().is_empty());
}

#[test]
fn outbox_push_preserva_o_pedido_original_no_dedupe() {
    let store = HarvestStore::open_memory().unwrap();
    store.outbox_push("obra:tt1", 1_000).unwrap();
    let lote = store.outbox_take(10, 1_100).unwrap();
    store.outbox_push("obra:tt1", 1_200).unwrap();
    let vivos = store.outbox_pending(1_300).unwrap();
    assert_eq!(vivos.len(), 1);
    assert_eq!(vivos[0].at_ms, 1_000, "dedupe não renova o pedido");
    assert_eq!(vivos[0].tries, lote[0].tries, "dedupe não zera tentativas");
}

#[test]
fn chaves_batem_com_o_contrato_congelado() {
    assert_eq!(journal_key("run-1"), "harvest:v1:run:run-1");
    assert_eq!(JOURNAL_PREFIX, format!("{}run:", prefix(HARVEST_NAMESPACE)));
    assert_eq!(JOURNAL_TTL_SECONDS, 86_400);
    assert_eq!(OUTBOX_KEY, "harvest:v1:outbox");
    assert_eq!(OUTBOX_DEAD_KEY, format!("{OUTBOX_KEY}:dead"));
    assert_eq!(OUTBOX_TTL_SECONDS, 2_592_000);
}
