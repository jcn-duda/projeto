//! Provas do estado durável do Chupim: dedupe da fila, lease do hash em voo
//! (durável, ao contrário do `Map` do Node), marker só no aceite, suppressed
//! antes da fila e terminal barrando o reenfileiramento até o TTL.

use adom_autofetch::queue::{AutofetchQueue, EnqueueOutcome, Hold};
use adom_autofetch::state::ObraRecord;
use adom_autofetch::suppressed;
use adom_store::kv::NativeKv;

fn queue() -> AutofetchQueue {
    AutofetchQueue::new(NativeKv::open_memory().unwrap())
}

#[test]
fn enfileira_uma_vez_por_obra_e_episodio() {
    let q = queue();
    assert_eq!(
        q.enqueue("tt1", None, 1_000).unwrap(),
        EnqueueOutcome::Enqueued
    );
    assert_eq!(
        q.enqueue("tt1", None, 1_001).unwrap(),
        EnqueueOutcome::Duplicate
    );
    assert_eq!(
        q.enqueue("tt1", Some((1, 2)), 1_002).unwrap(),
        EnqueueOutcome::Enqueued
    );
    assert_eq!(q.len(1_003).unwrap(), 2);
}

#[test]
fn hold_antes_da_checagem_e_marker_so_no_aceite() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    let hold = q.hold("tt1", None, "hash-a", 1_000).unwrap();
    assert!(q.is_held(&hold, 1_001).unwrap());
    q.release(&hold, false, 1_002).unwrap();
    assert!(!q.is_held(&hold, 1_003).unwrap());
    assert!(
        q.marker("hash-a", 1_003).unwrap().is_none(),
        "recusa não marca"
    );

    let hold = q.hold("tt1", None, "hash-b", 1_004).unwrap();
    q.release(&hold, true, 1_005).unwrap();
    let marker = q.marker("hash-b", 1_006).unwrap().expect("aceite marca");
    assert_eq!(marker.source, "autofetch");
    assert_eq!(marker.at, 1_005);
}

#[test]
fn hold_expirado_nao_bloqueia_nova_tentativa() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    let stale = Hold::new("tt1", None, "hash-a", 1_000, 1_000);
    q.put_hold(&stale).unwrap();
    assert!(!q.is_held(&stale, 2_100).unwrap());
}

#[test]
fn suppressed_nao_entra_na_fila_e_sai_por_lista() {
    let q = queue();
    q.suppress("tt7", None, "desistiu", 1_000).unwrap();
    assert_eq!(
        q.enqueue("tt7", None, 1_001).unwrap(),
        EnqueueOutcome::Suppressed
    );
    assert_eq!(q.suppressed_keys(1_002).unwrap().len(), 1);
    q.unsuppress("tt7", None).unwrap();
    assert_eq!(
        q.enqueue("tt7", None, 1_003).unwrap(),
        EnqueueOutcome::Enqueued
    );
}

#[test]
fn hold_e_duravel_e_o_run_antigo_nao_solta_o_lease_alheio() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let stale = {
        let q = AutofetchQueue::new(NativeKv::open(&path).unwrap());
        q.hold("tt1", Some((2, 5)), "hash-a", 1_000).unwrap()
    };

    // Outro processo (mesmo cache.db): o lease em voo não se perde no restart.
    let q = AutofetchQueue::new(NativeKv::open(&path).unwrap());
    let live = q.hold("tt1", Some((2, 5)), "hash-a", 1_001).unwrap();
    assert!(q.is_held(&live, 1_002).unwrap());
    assert!(!q.is_held(&stale, 1_002).unwrap(), "run vencido não vale");
    assert!(
        !q.release(&stale, true, 1_003).unwrap(),
        "soltar o lease alheio é no-op"
    );
    assert!(q.marker("hash-a", 1_004).unwrap().is_none(), "e não marca");
    assert!(q.is_held(&live, 1_004).unwrap(), "o lease vivo continua");
}

#[test]
fn terminal_barra_o_enqueue_so_dentro_do_ttl() {
    let q = queue();
    q.terminate("tt1", None, "dead", 1_000).unwrap();
    assert_eq!(
        q.enqueue("tt1", None, 2_000).unwrap(),
        EnqueueOutcome::Duplicate
    );
    assert!(q.terminal_for("tt1", None, 2_000).unwrap().is_some());
    assert_eq!(
        q.enqueue("tt1", None, 90_000_000).unwrap(),
        EnqueueOutcome::Enqueued,
        "passado o TTL de 24 h a obra volta a ser elegível"
    );
    assert!(q.terminal_for("tt1", None, 90_000_000).unwrap().is_none());
}

#[test]
fn take_tira_o_primeiro_item_e_a_fila_vazia_nao_deixa_chave() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    q.enqueue("tt2", None, 1_001).unwrap();
    let head = q.take(1_002).unwrap().expect("havia item");
    assert_eq!(head.imdb_id, "tt1");
    assert_eq!(q.len(1_003).unwrap(), 1);
    q.take(1_004).unwrap();
    assert!(q.is_empty(1_005).unwrap());
    assert!(q.take(1_006).unwrap().is_none());
}

#[test]
fn obra_do_registro_acompanha_o_enqueue() {
    let q = queue();
    q.enqueue("tt1", None, 1_000).unwrap();
    q.enqueue("tt1", Some((1, 1)), 1_001).unwrap();
    let record: ObraRecord = q.obra("tt1", 1_002).unwrap();
    assert_eq!(record.queued, 2, "cada enfileiramento conta");
    assert_eq!(record.last_at, 1_001);
    assert!(record.terminal.is_none());
}

#[test]
fn identidade_da_obra_nao_colide_entre_obras() {
    let kv = NativeKv::open_memory().unwrap();
    suppressed::suppress(&kv, "tt1", Some((2, 3)), "sem dublado", 1_000).unwrap();
    assert!(suppressed::is_suppressed(&kv, "tt1", Some((2, 3)), 1_001).unwrap());
    assert!(
        !suppressed::is_suppressed(&kv, "tt12", Some((3, 0)), 1_001).unwrap(),
        "obra diferente com S/E parecidos não herda a supressão"
    );
    assert!(
        !suppressed::is_suppressed(&kv, "tt1", None, 1_001).unwrap(),
        "o filme da obra não herda o episódio suprimido"
    );
}
