//! Testes da coordenação da sonda BR — espelham os casos de
//! `test/br-probe.test.ts` (lease, dedupe, cap/estado final, fila sem trabalho).

use super::*;

use crate::inflight::HarvestIntent;
use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::reason::obra_identity;
use crate::store::HarvestStore;
use crate::types::{BrProbeRecord, HarvestEntry, HarvestMediaType};

/// Instante fixo: nada aqui depende de relógio real.
const NOW: i64 = 1_700_000_000_000;

fn store() -> HarvestStore {
    HarvestStore::open_memory().expect("store em memória")
}

fn queue() -> HarvestQueue {
    HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW)
}

fn config() -> ProbeConfig {
    ProbeConfig {
        index_only_indexers: vec!["bludv".into(), "comando".into()],
        pt_br_indexers: vec!["comando".into(), "bludv".into()],
        ..ProbeConfig::default()
    }
}

fn probe() -> BrProbe {
    BrProbe::new(config())
}

fn movie() -> BrProbeWork {
    BrProbeWork::movie("tt0111161")
}

#[test]
fn identidade_global_por_episodio_e_chave_estavel() {
    let ep5 = BrProbeWork::series("tt0944947", 2, 5);
    assert_eq!(probe_identity(&ep5), "series:tt0944947:2:5");
    assert_eq!(probe_identity(&movie()), "movie:tt0111161::");

    let key = probe_key(&ep5);
    assert!(key.starts_with("autofetch:v3:probe:"));
    assert_eq!(key.len(), "autofetch:v3:probe:".len() + 64);
    assert_eq!(key, probe_key(&ep5), "hash determinístico");
    assert_ne!(key, probe_key(&BrProbeWork::series("tt0944947", 2, 6)));
}

#[test]
fn fila_vazia_aceita_e_grava_pending() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();

    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert!(result.probe && result.pending);
    assert_eq!(result.skipped, None);
    assert_eq!(queue.depth(), 1);
    let entry = &queue.entries()[0];
    assert!(entry.br_probe, "entrada dirigida criada");
    assert_eq!(entry.reason, "br-gap");
    assert_eq!(entry.priority_at, Some(NOW));
    assert!(probe.blocks_seeds(&store, &movie(), NOW).unwrap());
}

#[test]
fn fila_sem_trabalho_aceito_nao_grava_pending() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    queue.set_enabled(false);

    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("disabled"));
    assert!(!result.probe && !result.pending);
    assert_eq!(probe.state(&store, &movie(), NOW).unwrap(), None);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn lease_vencido_e_orfao_sai_como_failed_e_reagenda() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    probe
        .set_record_for_test(
            &store,
            &movie(),
            BrProbeRecord {
                state: BrProbeState::Pending,
                at: NOW - PENDING_LEASE_MS - 1_000,
                lease_until: Some(NOW - 1),
            },
            NOW,
        )
        .unwrap();

    assert_eq!(
        probe.state(&store, &movie(), NOW).unwrap(),
        Some(BrProbeState::Failed),
        "pending sem lease não é busca ativa"
    );
    assert!(!probe.blocks_seeds(&store, &movie(), NOW).unwrap());

    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert!(result.probe && result.pending, "órfão reagenda");
    assert_eq!(queue.depth(), 1, "reagendou sem duplicar");
    assert_eq!(
        probe.state(&store, &movie(), NOW).unwrap(),
        Some(BrProbeState::Pending)
    );
    assert!(probe.blocks_seeds(&store, &movie(), NOW).unwrap());
}

#[test]
fn pending_vivo_bloqueia_e_nao_reenfileira() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    probe
        .set_record_for_test(
            &store,
            &movie(),
            BrProbeRecord {
                state: BrProbeState::Pending,
                at: NOW,
                lease_until: Some(NOW + PENDING_LEASE_MS),
            },
            NOW,
        )
        .unwrap();

    assert!(probe.is_pending(&store, &movie(), NOW).unwrap());
    assert!(probe.blocks_seeds(&store, &movie(), NOW).unwrap());
    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("pending"));
    assert!(result.probe && result.pending);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn found_nao_bloqueia_seeds_e_nao_reagenda() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    assert!(probe
        .finalize(&store, &movie(), ProbeFinal::Found, NOW)
        .unwrap());

    assert_eq!(
        probe.state(&store, &movie(), NOW).unwrap(),
        Some(BrProbeState::Found)
    );
    assert!(!probe.blocks_seeds(&store, &movie(), NOW).unwrap());
    assert_eq!(
        probe.run_wait_ms(&store, &movie(), NOW + 1_500).unwrap(),
        Some(1_500)
    );
    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("found"));
    assert!(!result.pending);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn empty_libera_seeds() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    probe
        .finalize(&store, &movie(), ProbeFinal::Empty, NOW)
        .unwrap();

    assert!(!probe.blocks_seeds(&store, &movie(), NOW).unwrap());
    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("empty"));
    assert_eq!(queue.depth(), 0);
}

#[test]
fn failed_e_capped_tem_retry_curto_de_cinco_minutos() {
    for state in [ProbeFinal::Failed, ProbeFinal::Capped] {
        let (store, probe) = (store(), probe());
        let mut queue = queue();
        probe.finalize(&store, &movie(), state, NOW).unwrap();

        let early = probe
            .request(&store, &mut queue, &movie(), NOW + RETRY_MS - 1)
            .unwrap();
        assert_eq!(early.skipped, Some("retry"), "dentro da janela não martela");
        assert_eq!(queue.depth(), 0);

        let late = probe
            .request(&store, &mut queue, &movie(), NOW + RETRY_MS)
            .unwrap();
        assert!(late.probe, "fora da janela reagenda");
        assert_eq!(queue.depth(), 1);
    }
}

#[test]
fn dedupe_de_doze_horas_por_obra_e_motivo() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();

    let first = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert!(first.probe);
    assert_eq!(queue.take_head().map(|entry| entry.br_probe), Some(true));
    // Worker consumiu e falhou: estado final libera seeds, mas o dedupe fica.
    probe
        .finalize(&store, &movie(), ProbeFinal::Failed, NOW)
        .unwrap();

    let again = probe
        .request(&store, &mut queue, &movie(), NOW + RETRY_MS)
        .unwrap();
    assert_eq!(again.skipped, Some("dedupe"));
    assert!(!again.probe && !again.pending);
    assert_eq!(queue.depth(), 0);
    assert!(
        !probe
            .blocks_seeds(&store, &movie(), NOW + RETRY_MS)
            .unwrap(),
        "dedupe não bloqueia seeds"
    );

    let after = probe
        .request(&store, &mut queue, &movie(), NOW + 12 * 3600 * 1_000 + 1)
        .unwrap();
    assert!(after.probe, "dedupe expirado permite novo pedido");
    assert_eq!(queue.depth(), 1);
}

#[test]
fn coalescing_em_voo_grava_pending_sem_entrada_nova() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();
    let entry = HarvestEntry {
        imdb_id: "tt0111161".into(),
        media_type: HarvestMediaType::Movie,
        season: None,
        episode: None,
        reason: "br-gap".into(),
        enqueued_at: NOW,
        priority_at: Some(NOW),
        resumed: false,
        br_probe: false,
        full_base: false,
        full_intent: None,
    };
    queue.inflight_mut().begin(
        &obra_identity("tt0111161", None, None),
        HarvestIntent::from_entry(&entry),
    );

    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("inflight"));
    assert!(result.probe && result.pending);
    assert_eq!(queue.depth(), 0, "execução em voo cobre a sonda");
    assert!(probe.blocks_seeds(&store, &movie(), NOW).unwrap());
}

#[test]
fn preempcao_renova_o_lease() {
    let (store, probe) = (store(), probe());
    probe
        .set_record_for_test(
            &store,
            &movie(),
            BrProbeRecord {
                state: BrProbeState::Pending,
                at: NOW,
                lease_until: Some(NOW + PENDING_LEASE_MS),
            },
            NOW,
        )
        .unwrap();

    assert!(probe
        .note_preempted(&store, &movie(), NOW + 9 * 60_000)
        .unwrap());
    assert!(
        probe
            .blocks_seeds(&store, &movie(), NOW + 11 * 60_000)
            .unwrap(),
        "lease renovado no instante da preempção"
    );
}

#[test]
fn toggle_desligado_mantem_o_fallback_do_br_gap() {
    let store = store();
    let mut queue = queue();
    let probe = BrProbe::new(ProbeConfig {
        auto_fetch_br_probe: false,
        ..config()
    });

    let result = probe.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("disabled"));
    assert!(result.fallback_br_gap);
    assert!(!result.probe);
    assert_eq!(probe.state(&store, &movie(), NOW).unwrap(), None);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn sem_indice_ou_sem_intersecao_nao_sona() {
    let store = store();
    let mut queue = queue();

    let no_index = BrProbe::new(ProbeConfig {
        release_index_enabled: false,
        ..config()
    });
    let result = no_index.request(&store, &mut queue, &movie(), NOW).unwrap();
    assert_eq!(result.skipped, Some("release-index-off"));
    assert!(result.fallback_br_gap);

    let no_intersection = BrProbe::new(ProbeConfig {
        index_only_indexers: vec!["bludv".into()],
        pt_br_indexers: vec!["comando".into()],
        ..ProbeConfig::default()
    });
    let result = no_intersection
        .request(&store, &mut queue, &movie(), NOW)
        .unwrap();
    assert_eq!(result.skipped, Some("no-intersection"));
    assert!(result.fallback_br_gap);
    assert_eq!(queue.depth(), 0);
}

#[test]
fn intersecao_respeita_ordem_e_isenos_da_busca_viva() {
    assert_eq!(probe().probe_indexers(), vec!["bludv", "comando"]);

    let exempt = BrProbe::new(ProbeConfig {
        live_exempt_indexers: vec!["comando".into()],
        ..config()
    });
    assert_eq!(exempt.probe_indexers(), vec!["bludv"]);
    assert!(exempt.enabled());
}

#[test]
fn obra_invalida_nao_toca_a_fila() {
    let (store, probe) = (store(), probe());
    let mut queue = queue();

    let result = probe
        .request(&store, &mut queue, &BrProbeWork::movie("tt"), NOW)
        .unwrap();
    assert_eq!(result.skipped, Some("invalid"));
    assert!(!result.fallback_br_gap);
    assert_eq!(
        probe.state(&store, &BrProbeWork::movie("tt"), NOW).unwrap(),
        None
    );
    assert_eq!(queue.depth(), 0);
}

#[test]
fn json_do_registro_e_o_mesmo_do_ts() {
    let pending = BrProbeRecord {
        state: BrProbeState::Pending,
        at: 7,
        lease_until: Some(11),
    };
    assert_eq!(
        serde_json::to_string(&pending).unwrap(),
        r#"{"state":"pending","at":7,"leaseUntil":11}"#
    );
    let done = BrProbeRecord {
        state: BrProbeState::Empty,
        at: 7,
        lease_until: None,
    };
    assert_eq!(
        serde_json::to_string(&done).unwrap(),
        r#"{"state":"empty","at":7}"#
    );

    let from_ts: BrProbeRecord =
        serde_json::from_str(r#"{"state":"capped","at":5,"leaseUntil":9}"#).unwrap();
    assert_eq!(from_ts.state, BrProbeState::Capped);
    assert_eq!(from_ts.lease_until, Some(9));
}

#[test]
fn registro_expira_pelo_ttl_configurado() {
    let store = store();
    let probe = BrProbe::new(ProbeConfig {
        ttl_seconds: 1,
        ..config()
    });
    // `pending` tem piso de lease; o TTL do env governa o estado FINAL.
    let gravou = probe.finalize(&store, &movie(), ProbeFinal::Empty, NOW);
    assert!(gravou.unwrap());
    let estado = probe.state(&store, &movie(), NOW + 999).unwrap();
    assert_eq!(estado, Some(BrProbeState::Empty));
    assert_eq!(probe.state(&store, &movie(), NOW + 1_000).unwrap(), None);
}
