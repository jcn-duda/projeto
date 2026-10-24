//! Testes do desfecho SEM rede: requeue de falha, teto de tentativas e a
//! finalização da sonda (`found`/`empty`/`failed`), inclusive quando ela
//! coalesceu em voo numa execução completa.

use adom_harvest::{
    probe_key, BrProbeRecord, BrProbeState, BrProbeWork, HarvestEntry, HarvestMediaType,
    HarvestQueue, HarvestQueueConfig, HarvestStore, PendingIntent, DEFAULT_PROBE_TTL_SECONDS,
};

use super::{Settlement, Settler};

const NOW: i64 = 1_700_000_000_000;

fn settler() -> Settler {
    Settler::new(DEFAULT_PROBE_TTL_SECONDS)
}

fn entry(imdb: &str, br_probe: bool) -> HarvestEntry {
    HarvestEntry {
        imdb_id: imdb.to_string(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".to_string(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe,
        full_base: false,
        full_intent: None,
    }
}

fn queue() -> HarvestQueue {
    HarvestQueue::new(HarvestQueueConfig::default())
}

fn outcome(is_probe: bool, ok: bool, br_found: bool) -> Settlement {
    Settlement {
        intent: is_probe.then(|| PendingIntent {
            reason: "br-gap".into(),
            br_probe: true,
            priority_at: Some(NOW),
            full: None,
        }),
        ok,
        br_found,
    }
}

/// Estado da sonda gravado no L2, lido pela MESMA chave do `br-probe`.
fn probe_state(store: &HarvestStore, imdb: &str) -> Option<BrProbeState> {
    let work = BrProbeWork::movie(imdb);
    let raw = store.get_value(&probe_key(&work), NOW).ok().flatten()?;
    serde_json::from_str::<BrProbeRecord>(&raw)
        .ok()
        .map(|record| record.state)
}

#[test]
fn sucesso_nao_volta_a_fila() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", false),
        outcome(false, true, false),
        NOW,
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn achado_br_finaliza_a_sonda_como_found() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // A obra falhou na gravação, mas achou BR viável: `found` vence (a sonda
    // prova valor mesmo com a passada cortada).
    settler.settle(
        &mut queue,
        &store,
        entry("tt0111161", true),
        outcome(true, false, true),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0111161"), Some(BrProbeState::Found));
    // Falha ainda reenfileira a obra para a próxima tentativa.
    assert_eq!(queue.depth(), 1);
}

#[test]
fn resposta_sem_achado_finaliza_a_sonda_como_empty() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0903747", true),
        outcome(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0903747"), Some(BrProbeState::Empty));
    assert_eq!(queue.depth(), 0);
}

#[test]
fn falha_finaliza_failed_e_sai_da_fila_apos_o_teto() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // Três falhas devolvem a obra ao fim da fila (mesmo teto do TS).
    for round in 1..=3 {
        settler.settle(
            &mut queue,
            &store,
            entry("tt0068646", true),
            outcome(true, false, false),
            NOW,
        );
        assert_eq!(queue.depth(), 1, "rodada {round} deveria reenfileirar");
        queue.take_head();
    }
    assert_eq!(probe_state(&store, "tt0068646"), Some(BrProbeState::Failed));

    // A quarta falha tira a obra da fila: a obra cara não a monopoliza.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0068646", true),
        outcome(true, false, false),
        NOW,
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn sucesso_zera_o_contador_de_tentativas() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, false, false),
        NOW,
    );
    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, false, false),
        NOW,
    );
    assert_eq!(queue.depth(), 1);
    queue.clear();
    // Sucesso no meio zera as duas falhas anteriores.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0108052", false),
        outcome(false, true, false),
        NOW,
    );
    for round in 1..=3 {
        settler.settle(
            &mut queue,
            &store,
            entry("tt0108052", false),
            outcome(false, false, false),
            NOW,
        );
        assert_eq!(queue.depth(), 1, "rodada {round} deveria reenfileirar");
        queue.take_head();
    }
}

#[test]
fn sonda_coalescida_finaliza_mesmo_com_entrada_completa() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = queue();
    let mut settler = settler();

    // Entrada base FULL (`br_probe:false`) com sonda anexada em voo: o
    // `is_probe` efetivo é o que decide a finalização.
    settler.settle(
        &mut queue,
        &store,
        entry("tt0133093", false),
        outcome(true, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0133093"), Some(BrProbeState::Empty));

    // Sem intenção de sonda, nada é gravado (não inventa estado).
    settler.settle(
        &mut queue,
        &store,
        entry("tt0133094", false),
        outcome(false, true, false),
        NOW,
    );
    assert_eq!(probe_state(&store, "tt0133094"), None);
}
