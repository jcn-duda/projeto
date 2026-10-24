use super::*;
use crate::types::HarvestMediaType;

fn clock_fixed() -> i64 {
    1_700_000_000_000
}

fn q(max: usize) -> HarvestQueue {
    HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: max,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    )
}

#[test]
fn chave_canonica_bate_com_ts() {
    assert_eq!(queue_key(), QUEUE_KEY);
    assert_eq!(QUEUE_KEY, "harvest:v1:q");
}

#[test]
fn enqueue_e_take_head_fifo() {
    let mut queue = q(10);
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .accepted
    );
    assert!(
        queue
            .enqueue(HarvestRequest::movie("tt0068646", "miss"))
            .accepted
    );
    assert_eq!(queue.depth(), 2);
    let head = queue.take_head().expect("cabeça");
    assert_eq!(head.imdb_id, "tt0111161");
    assert_eq!(queue.depth(), 1);
}

#[test]
fn rejeita_desligado_e_imdb_invalido() {
    let mut queue = q(10);
    queue.set_enabled(false);
    let off = queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    assert!(!off.accepted);
    assert_eq!(off.reason, EnqueueReason::Disabled);

    queue.set_enabled(true);
    let bad = queue.enqueue(HarvestRequest::movie("nope", "miss"));
    assert!(!bad.accepted);
    assert_eq!(bad.reason, EnqueueReason::Invalid);
}

#[test]
fn promocao_nao_duplica_nem_reseta_enqueued_at() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    let first_at = queue.preview(1)[0].enqueued_at;

    let out = queue.enqueue(HarvestRequest::movie("tt0111161", "br-gap"));
    assert_eq!(out.reason, EnqueueReason::Promoted);
    assert_eq!(queue.depth(), 1);
    let e = &queue.preview(1)[0];
    assert_eq!(e.reason, "br-gap");
    assert_eq!(e.enqueued_at, first_at);
    assert_eq!(e.priority_at, Some(clock_fixed()));
}

#[test]
fn duplicata_simples() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
    let out = queue.enqueue(HarvestRequest::movie("tt0111161", "popular"));
    assert!(out.accepted);
    assert_eq!(out.reason, EnqueueReason::Duplicate);
    assert_eq!(queue.depth(), 1);
}

#[test]
fn teto_sem_br_first_descarta_menor_enqueued_at() {
    let mut queue = HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: 2,
            br_first: false,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    );
    queue.enqueue(HarvestRequest::movie("tt0000001", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0000002", "miss"));
    queue.enqueue(HarvestRequest::movie("tt0000003", "miss"));
    assert_eq!(queue.depth(), 2);
    let ids: Vec<_> = queue.preview(2).into_iter().map(|e| e.imdb_id).collect();
    assert_eq!(ids, ["tt0000002", "tt0000003"]);
}

#[test]
fn teto_com_br_first_descarta_cauda_priorizada() {
    use crate::prioritize::StubBrEvidence;
    let mut ev = StubBrEvidence::new();
    ev.insert("tt0000001", None, None);
    ev.insert("tt0000002", None, None);
    let mut queue = q(2);
    queue.enqueue_with_evidence(HarvestRequest::movie("tt0000001", "miss"), Some(&ev));
    queue.enqueue_with_evidence(HarvestRequest::movie("tt0000002", "miss"), Some(&ev));
    // Sem evidência na foto: a nova cai na cauda e é evictada — sem aceite,
    // para o dedupe de 12 h não trancar uma obra que não ficou na fila.
    let out = queue.enqueue_with_evidence(HarvestRequest::movie("tt0000003", "miss"), Some(&ev));
    assert!(!out.accepted);
    assert_eq!(out.reason, EnqueueReason::Capacity);
    assert_eq!(queue.depth(), 2);
    let ids: Vec<_> = queue.preview(2).into_iter().map(|e| e.imdb_id).collect();
    assert_eq!(ids, ["tt0000001", "tt0000002"]);
}

#[test]
fn teto_reduzido_evicta_mais_de_uma_no_proximo_ingresso() {
    let mut queue = HarvestQueue::with_clock(
        HarvestQueueConfig {
            queue_max: 4,
            br_first: false,
            ..HarvestQueueConfig::default()
        },
        clock_fixed,
    );
    for n in 1..=4 {
        queue.enqueue(HarvestRequest::movie(format!("tt000000{n}"), "miss"));
    }
    queue.set_config(HarvestQueueConfig {
        queue_max: 2,
        br_first: false,
        ..HarvestQueueConfig::default()
    });
    assert_eq!(queue.depth(), 4, "reduzir teto não corta sozinho");
    queue.enqueue(HarvestRequest::movie("tt0000005", "miss"));
    assert_eq!(queue.depth(), 2);
    let ids: Vec<_> = queue.preview(2).into_iter().map(|e| e.imdb_id).collect();
    assert_eq!(ids, ["tt0000004", "tt0000005"]);
}

#[test]
fn enqueue_concorrente_durante_snapshot_fica_neutro() {
    use crate::prioritize::StubBrEvidence;
    use std::sync::{Arc, Mutex};
    use std::thread;

    let mut ev = StubBrEvidence::new();
    ev.insert("tt7100001", None, None);
    let ev = Arc::new(ev);
    let queue = Arc::new(Mutex::new(q(10)));
    {
        let mut locked = queue.lock().unwrap();
        locked.enqueue_with_evidence(HarvestRequest::movie("tt7100001", "miss"), Some(&*ev));
    }
    let queue_t = queue.clone();
    let ev_t = ev.clone();
    thread::spawn(move || {
        let mut locked = queue_t.lock().unwrap();
        locked.enqueue_with_evidence(HarvestRequest::movie("tt7100002", "miss"), Some(&*ev_t));
    })
    .join()
    .unwrap();

    let locked = queue.lock().unwrap();
    assert_eq!(locked.depth(), 2);
    assert_eq!(locked.preview(2)[0].imdb_id, "tt7100001");
    assert_eq!(locked.preview(2)[1].imdb_id, "tt7100002");
}

#[test]
fn take_probe_fora_de_turno() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::movie("tt0000001", "next-episode"));
    let mut probe = HarvestRequest::movie("tt0000002", "br-gap");
    probe.br_probe = true;
    queue.enqueue(probe);
    assert!(queue.has_probe());
    let got = queue.take_probe().expect("probe");
    assert_eq!(got.imdb_id, "tt0000002");
    assert!(got.br_probe);
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].imdb_id, "tt0000001");
}

#[test]
fn head_e_tail_nao_duplicam() {
    let mut queue = q(10);
    queue.enqueue(HarvestRequest::series("tt0903747", 1, Some(1), "miss"));
    let entry = HarvestEntry {
        imdb_id: "tt0903747".into(),
        media_type: HarvestMediaType::Series,
        season: Some(1),
        episode: Some(1),
        reason: "next-episode".into(),
        enqueued_at: clock_fixed(),
        priority_at: None,
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    };
    queue.head(entry.clone());
    assert_eq!(queue.depth(), 1);
    assert_eq!(queue.preview(1)[0].reason, "next-episode");

    queue.tail(entry);
    assert_eq!(queue.depth(), 1);
}

#[test]
fn fora_do_caminho_stream_documentado() {
    // Invariante de desenho: este módulo não importa nada de busca/stream.
    // O teste só trava a chave e o namespace — o gateway NÃO deve chamar
    // HarvestQueue no hot path.
    assert_eq!(HARVEST_NAMESPACE, "harvest");
    assert!(!QUEUE_KEY.contains("stream"));
}

#[test]
fn load_from_prioriza_quando_evidence_fornecida() {
    use crate::prioritize::StubBrEvidence;
    use crate::store::HarvestStore;

    let store = HarvestStore::open_memory().unwrap();
    let mut writer = q(10);
    writer.enqueue(HarvestRequest::movie("tt5000001", "miss"));
    writer.enqueue(HarvestRequest::movie("tt5000002", "miss"));
    writer
        .save_to(
            &store,
            crate::store::DEFAULT_ENTRY_TTL_SECONDS,
            clock_fixed(),
        )
        .unwrap();

    let mut ev = StubBrEvidence::new();
    ev.insert("tt5000002", None, None);

    let mut reader = q(10);
    reader.load_from(&store, clock_fixed(), Some(&ev)).unwrap();
    assert_eq!(reader.preview(2)[0].imdb_id, "tt5000002");

    let mut plain = q(10);
    plain.load_from(&store, clock_fixed(), None).unwrap();
    assert_eq!(plain.preview(2)[0].imdb_id, "tt5000001");
}

#[test]
fn enqueue_em_voo_coalesce_sem_criar_entrada() {
    let mut queue = q(10);
    let entry = match queue.enqueue(HarvestRequest::movie("tt0111161", "miss")) {
        EnqueueOutcome { accepted: true, .. } => queue.take_head().unwrap(),
        other => panic!("esperado aceite, got {other:?}"),
    };

    let identity = crate::reason::entry_identity(&entry);
    queue
        .inflight_mut()
        .begin(&identity, HarvestIntent::from_entry(&entry));
    let out = queue.enqueue(HarvestRequest::movie("tt0111161", "br-gap"));
    assert_eq!(out.reason, EnqueueReason::Coalesced);
    assert_eq!(queue.depth(), 0);

    // A intenção mais forte foi fundida no slot em voo.
    let pending = queue.inflight().pending(&identity).unwrap();
    assert_eq!(pending.reason, "br-gap");

    // Outra obra não coalesce e entra na fila normalmente.
    queue.inflight_mut().end(&identity);
    let other = queue.enqueue(HarvestRequest::movie("tt0068646", "miss"));
    assert_eq!(other.reason, EnqueueReason::Queued);
    assert_eq!(queue.depth(), 1);
}
