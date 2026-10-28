//! Passo da sonda: payload, kill-switch, isenção de indexer, lease e confirmação.
//!
//! Nenhum teste toca a rede: a fila do colhedor entra como [`EnqueueOutcome`] e
//! a confirmação dirigida como booleano — a mesma pergunta que
//! `HarvestHandle::pending` responde em produção.

use adom_autofetch::v3::{ProbeState, PROBE_PENDING_LEASE_MS};
use adom_harvest::{EnqueueOutcome, EnqueueReason, HarvestMediaType};
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

use super::{finish, plan, read_state, settle, ProbeSkipReason, ProbeStep};

const NOW: i64 = 1_700_000_000_000;
const TTL: u64 = 43_200;

fn config() -> super::ProbeStepConfig {
    super::ProbeStepConfig {
        probe: adom_harvest::ProbeConfig {
            // Ordem do `indexOnly` decide a ordem dos alvos (como no TS).
            index_only_indexers: vec![
                "redetorrent-cardigann".into(),
                "apachetorrent-cardigann".into(),
                "hdrtorrent-cardigann".into(),
            ],
            pt_br_indexers: vec![
                "redetorrent-cardigann".into(),
                "apachetorrent-cardigann".into(),
                "hdrtorrent-cardigann".into(),
                "bludv".into(),
            ],
            live_exempt_indexers: vec!["apachetorrent-cardigann".into()],
            ..adom_harvest::ProbeConfig::default()
        },
        paused: false,
        queue_len: 0,
        queue_max: 200,
    }
}

fn body(value: Value) -> Map<String, Value> {
    value.as_object().expect("objeto").clone()
}

fn br_probe() -> Map<String, Value> {
    body(json!({ "imdbId": "tt0111161", "type": "movie", "season": null, "episode": null }))
}

fn schedule(payload: &Map<String, Value>) -> super::ProbeSchedule {
    match plan(payload, None, &config(), NOW) {
        ProbeStep::Schedule(planned) => planned,
        ProbeStep::Skip(reason) => panic!("esperava agendar, veio {reason:?}"),
    }
}

fn skip(payload: &Map<String, Value>, config: &super::ProbeStepConfig) -> ProbeSkipReason {
    match plan(payload, None, config, NOW) {
        ProbeStep::Skip(reason) => reason,
        ProbeStep::Schedule(_) => panic!("esperava Skip"),
    }
}

/// (a) Payload fora do contrato nunca vira sonda.
#[test]
fn payload_invalido_vira_skip_com_motivo() {
    let casos = [
        json!({ "type": "movie" }),
        json!({ "imdbId": "0111161", "type": "movie" }),
        json!({ "imdbId": "tt0111161", "type": "anime" }),
        json!({ "imdbId": "tt0111161" }),
        json!({ "imdbId": 123, "type": "movie" }),
    ];
    for caso in casos {
        assert_eq!(
            skip(&body(caso.clone()), &config()),
            ProbeSkipReason::InvalidPayload,
            "payload {caso} deveria ser recusado"
        );
    }
    assert_eq!(ProbeSkipReason::InvalidPayload.as_str(), "invalid");
}

/// (b) Worker pausado desliga a sonda — e o skip não grava nada.
#[test]
fn worker_pausado_desliga_a_sonda() {
    let mut cfg = config();
    cfg.paused = true;
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::WorkerPaused);
    assert_eq!(ProbeSkipReason::WorkerPaused.as_str(), "paused");
}

/// Fila do colhedor no teto: o `enqueue` evictaria a cauda antes de recusar.
#[test]
fn fila_cheia_pula_antes_do_enqueue() {
    let mut cfg = config();
    cfg.queue_len = 200;
    assert!(cfg.queue_full());
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::QueueFull);
    // Teto zero é "sem teto": a fila nunca está cheia.
    cfg.queue_len = 9_999;
    cfg.queue_max = 0;
    assert!(!cfg.queue_full());
}

/// (c) Indexer isento da busca viva não é sondado; a interseção sobrevive.
#[test]
fn indexer_isento_sai_da_sonda() {
    let planned = schedule(&br_probe());
    assert_eq!(
        planned.indexers,
        vec![
            "redetorrent-cardigann".to_string(),
            "hdrtorrent-cardigann".to_string()
        ],
        "apachetorrent-cardigann é isento (busca viva) e não pode ser sondado"
    );

    // Sem isenção, o apache voltaria na ordem do `indexOnly`.
    let mut sem_isencao = config();
    sem_isencao.probe.live_exempt_indexers.clear();
    assert_eq!(
        schedule(&br_probe()).indexers.len(),
        2,
        "a isenção é o único motivo de o apache sair"
    );
}

/// Se a interseção index-only ∩ pt-BR só tem isento, não há onde sondar.
#[test]
fn intersecao_so_de_isento_nao_vira_sonda() {
    let mut cfg = config();
    cfg.probe.index_only_indexers = vec!["apachetorrent-cardigann".into()];
    cfg.probe.pt_br_indexers = vec!["apachetorrent-cardigann".into()];
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::NoIntersection);
    assert_eq!(ProbeSkipReason::NoIntersection.as_str(), "no-intersection");

    cfg.probe.index_only_indexers = vec!["1337x".into()];
    cfg.probe.pt_br_indexers = vec!["bludv".into()];
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::NoIntersection);
}

#[test]
fn kill_switches_de_config_tem_motivo_proprio() {
    let mut cfg = config();
    cfg.probe.release_index_enabled = false;
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::ReleaseIndexOff);
    cfg.probe.release_index_enabled = true;
    cfg.probe.auto_fetch_br_probe = false;
    assert_eq!(skip(&br_probe(), &cfg), ProbeSkipReason::Disabled);

    // Série por episódio entra com S/E normalizados na obra.
    let serie = body(json!({ "imdbId": "tt0944947", "type": "series", "season": 2, "episode": 5 }));
    let planned = schedule(&serie);
    assert_eq!(planned.work.media_type, HarvestMediaType::Series);
    assert_eq!(
        (planned.work.season, planned.work.episode),
        (Some(2), Some(5))
    );
}

/// (d) Lease órfão (crash no meio da sonda) é recuperado e o lease renovado.
#[test]
fn lease_orfao_e_recuperado_e_renovado() {
    let kv = NativeKv::open_memory().expect("kv");
    let cfg = config();
    let planned = schedule(&br_probe());

    let run = settle(
        &kv,
        &planned,
        EnqueueOutcome::accepted(EnqueueReason::Queued),
        true,
        TTL,
        NOW,
    );
    assert!(run.scheduled && run.pending && run.error.is_none());
    let record = read_state(&kv, &planned.work, NOW)
        .expect("leitura")
        .expect("registro");
    assert_eq!(record.state, ProbeState::Pending);
    assert_eq!(record.lease_until, Some(NOW + PROBE_PENDING_LEASE_MS));

    // Lease vivo: a segunda abertura não re-sonda.
    assert_eq!(
        plan(&br_probe(), Some(record), &cfg, NOW + 1),
        ProbeStep::Skip(ProbeSkipReason::Pending)
    );

    // Um tique depois do vencimento é órfão: reagenda sem esperar o retry.
    let late = NOW + PROBE_PENDING_LEASE_MS;
    let stale = read_state(&kv, &planned.work, late)
        .expect("leitura")
        .expect("registro");
    let decision = plan(&br_probe(), Some(stale), &cfg, late);
    match decision {
        ProbeStep::Schedule(ref planned) => assert!(planned.orphan, "órfão tem métrica própria"),
        ProbeStep::Skip(reason) => panic!("esperava reagendar, veio {reason:?}"),
    }
    let again = settle(
        &kv,
        &planned,
        EnqueueOutcome::accepted(EnqueueReason::Queued),
        true,
        TTL,
        late,
    );
    assert!(again.pending);
    let renewed = read_state(&kv, &planned.work, late)
        .expect("leitura")
        .expect("registro");
    assert_eq!(renewed.at, late, "o reagendamento renova o lease");
    assert_eq!(renewed.lease_until, Some(late + PROBE_PENDING_LEASE_MS));
}

/// Aceite sem a flag dirigida (ou recusa da fila) NÃO grava `pending`: lease
/// sem sonda bloquearia o pool de sementes para sempre.
#[test]
fn sem_confirmacao_dirigida_nada_e_gravado() {
    let kv = NativeKv::open_memory().expect("kv");
    let planned = schedule(&br_probe());

    let recusado = settle(
        &kv,
        &planned,
        EnqueueOutcome::rejected(EnqueueReason::Capacity),
        true,
        TTL,
        NOW,
    );
    assert!(!recusado.scheduled && !recusado.pending);
    assert_eq!(recusado.skip, Some("capacity"));
    assert!(read_state(&kv, &planned.work, NOW)
        .expect("leitura")
        .is_none());

    let sem_flag = settle(
        &kv,
        &planned,
        EnqueueOutcome::accepted(EnqueueReason::Promoted),
        false,
        TTL,
        NOW,
    );
    assert_eq!(sem_flag.skip, Some("not-directed"));
    assert!(read_state(&kv, &planned.work, NOW)
        .expect("leitura")
        .is_none());
}

/// `found`/`empty` deduplicam a sonda e liberam seeds: só o estado final é
/// gravado, e `pending` nunca é aceito como final.
#[test]
fn estado_final_dedupe_sem_bloquear_seeds() {
    let kv = NativeKv::open_memory().expect("kv");
    let planned = schedule(&br_probe());
    finish(&kv, &planned.work, ProbeState::Found, TTL, NOW).expect("grava found");
    let record = read_state(&kv, &planned.work, NOW)
        .expect("leitura")
        .expect("registro");
    assert_eq!(record.state, ProbeState::Found);
    assert_eq!(record.lease_until, None);
    assert_eq!(
        plan(&br_probe(), Some(record), &config(), NOW + 1),
        ProbeStep::Skip(ProbeSkipReason::Found)
    );
    assert!(finish(&kv, &planned.work, ProbeState::Pending, TTL, NOW).is_err());
}

// Golden de CONTRATO (fixture `.jsonl`) do plano e do `settle`.
#[path = "probe_step_golden.rs"]
mod golden;
