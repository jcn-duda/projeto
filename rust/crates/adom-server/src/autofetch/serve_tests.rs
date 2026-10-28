//! Testes do laço: canal, timers dos lotes, dreno após terminal, poda do cofre e
//! o contrato do status (`enabled`, `inflight`, `lastError`, skips).

use std::sync::Arc;

use adom_autofetch::v3::QueueV3;
use adom_index::NativeKv;
use adom_sources::now_ms;
use tokio::sync::mpsc;

use super::super::fakes::{batch_payload, factory_for, job, no_factory, FakeDebrid, SCOPE};
use super::super::ports::DebridIo;
use super::super::recheck::{self, Lot};
use super::super::vault::Vault;
use super::super::worker::AutofetchHandle;
use super::super::Policy;
use super::{Control, Engine, Message};

const SEARCH: &str = "tt1234567:1:2";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn lot(search_key: &str, hash: &str, now: i64) -> Lot {
    let mut lot = Lot {
        search_key: search_key.to_string(),
        adapter_id: ADAPTER.to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.to_string()],
        created_at: now - 10_000,
        ..Lot::default()
    };
    lot.transfers.insert(hash.to_string(), format!("id-{hash}"));
    lot
}

/// Lote já VENCIDO: mais de um intervalo desde o enfileiramento (é o que a
/// passagem de timers olha via `recheck::due`).
fn due_lot(search_key: &str, hash: &str, now: i64) -> Lot {
    let mut lot = lot(search_key, hash, now);
    lot.created_at = now - 2 * Policy::fixture().recheck_interval_ms;
    lot
}

fn marker(kv: &NativeKv, hash: &str, now: i64) -> bool {
    QueueV3::new(kv)
        .marker(ADAPTER, ACCOUNT, hash, now)
        .unwrap()
        .is_some()
}

#[tokio::test]
async fn passagem_enfileira_arma_o_lote_e_conta_os_skips() {
    let kv = kv();
    let now = now_ms();
    let control = Control::new(false, 60_000);
    let debrid = Arc::new(FakeDebrid::accepting());
    let factory = factory_for(SCOPE, debrid.clone());
    let (tx, mut rx) = mpsc::channel(4);
    let payload = batch_payload(SEARCH, &[(&hash_of(1), true), (&hash_of(2), true)]);
    tx.try_send(Message::Batch(job(SCOPE, payload))).unwrap();

    let engine = Engine::new(&kv, Policy::fixture(), None, &factory, &control);
    let pass = engine.run_once(&mut rx, now).await;

    assert_eq!(pass.jobs, 1);
    assert_eq!(pass.enqueued, 2);
    assert_eq!(pass.scheduled, 1);
    assert!(pass.errors.is_empty(), "{:?}", pass.errors);
    // Lote armado com os hashes aceitos.
    let saved = recheck::read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.info_hashes.len(), 2);
    assert_eq!(saved.account, ACCOUNT);
    // Contadores do painel.
    let snapshot = control.snapshot();
    assert_eq!(snapshot.processed, 1);
    assert!(!snapshot.inflight);
    assert!(snapshot.last_error.is_none());
    // Canal vazio depois da passagem.
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn passagem_vazia_nao_inventa_trabalho() {
    let kv = kv();
    let control = Control::new(false, 60_000);
    let factory = no_factory();
    let (_tx, mut rx) = mpsc::channel(4);
    let engine = Engine::new(&kv, Policy::fixture(), None, &factory, &control);

    let pass = engine.run_once(&mut rx, now_ms()).await;
    assert_eq!(pass.jobs, 0);
    assert_eq!(pass.rechecked, 0);
    assert!(pass.skips.is_empty());
    assert!(kv
        .keys_matching("autofetch", adom_sources::now_ms())
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn timer_processa_lote_vencido_e_limpa_quando_resolve() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    let policy = Policy::fixture();
    recheck::write(&kv, &due_lot(SEARCH, &hash, now), policy, now).unwrap();
    let debrid = Arc::new(FakeDebrid::accepting().state(&hash, "ready"));
    let factory = factory_for(SCOPE, debrid);
    let control = Control::new(false, 60_000);
    let (_tx, mut rx) = mpsc::channel(4);
    let engine = Engine::new(&kv, policy, None, &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.rechecked, 1);
    assert_eq!(pass.drained, 0, "sem terminal não há dreno");
    assert!(recheck::read(&kv, SEARCH, now).unwrap().is_none());
}

#[tokio::test]
async fn terminal_com_fila_viva_drena_o_proximo_com_hold() {
    let kv = kv();
    let now = now_ms();
    let policy = Policy::fixture();
    let dead = hash_of(1);
    let next = hash_of(2);
    // Uma observação de morte já registrada: esta passagem fecha o terminal.
    let mut lot = due_lot(SEARCH, &dead, now);
    lot.dead_streak.insert(dead.clone(), 1);
    recheck::write(&kv, &lot, policy, now).unwrap();
    QueueV3::new(&kv)
        .write_queue(
            SEARCH,
            &[adom_autofetch::v3::QueueCandidate {
                info_hash: next.clone(),
                ..Default::default()
            }],
            600,
            12,
            Some((ADAPTER, ACCOUNT)),
            now,
        )
        .unwrap();
    let debrid = Arc::new(FakeDebrid::accepting().state(&dead, "dead"));
    let control = Control::new(false, 60_000);
    let factory = factory_for(SCOPE, debrid.clone());
    let (_tx, mut rx) = mpsc::channel(4);
    let engine = Engine::new(&kv, policy, None, &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.rechecked, 1);
    assert_eq!(pass.drained, 1);
    assert!(QueueV3::new(&kv)
        .is_dead(ADAPTER, ACCOUNT, &dead, now)
        .unwrap());
    // O próximo foi aceito e marcado; o morto não volta para a fila.
    assert_eq!(debrid.accepted(), vec![next.clone()]);
    assert!(marker(&kv, &next, now));
    assert!(QueueV3::new(&kv)
        .read_queue(SEARCH, now)
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn pedido_de_dreno_da_admin_consome_o_canal() {
    let kv = kv();
    let now = now_ms();
    let policy = Policy::fixture();
    let next = hash_of(3);
    recheck::write(&kv, &lot(SEARCH, &hash_of(4), now), policy, now).unwrap();
    QueueV3::new(&kv)
        .write_queue(
            SEARCH,
            &[adom_autofetch::v3::QueueCandidate {
                info_hash: next.clone(),
                ..Default::default()
            }],
            600,
            12,
            Some((ADAPTER, ACCOUNT)),
            now,
        )
        .unwrap();
    let debrid = Arc::new(FakeDebrid::accepting());
    let control = Control::new(false, 60_000);
    let factory = factory_for(SCOPE, debrid.clone());
    let (tx, mut rx) = mpsc::channel(4);
    tx.try_send(Message::Drain).unwrap();
    let engine = Engine::new(&kv, policy, None, &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.drained, 1);
    assert_eq!(debrid.accepted(), vec![next]);
}

/// O adaptador entra como `Arc<dyn AutofetchDebrid>` pela fábrica por conta: é o
/// caminho de injeção que a leva do flip usa, e precisa compilar fora dos
/// genéricos concretos.
#[tokio::test]
async fn adaptador_injetado_como_trait_object() {
    let kv = kv();
    let now = now_ms();
    let debrid: DebridIo = Arc::new(FakeDebrid::accepting());
    let factory = factory_for(SCOPE, debrid);
    let control = Control::new(true, 60_000);
    let engine = Engine::new(&kv, Policy::fixture(), None, &factory, &control);
    let payload = batch_payload(SEARCH, &[(&hash_of(1), true)]);
    let (tx, mut rx) = mpsc::channel(4);
    tx.try_send(Message::Batch(job(SCOPE, payload))).unwrap();

    // Pausado: o lote é ADIADO (fila escrita), nada é enfileirado.
    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.enqueued, 0);
    assert_eq!(pass.skips.get("paused"), Some(&1));
    assert_eq!(QueueV3::new(&kv).read_queue(SEARCH, now).unwrap().len(), 1);
}

#[tokio::test]
async fn falha_do_adaptador_vira_last_error_no_painel() {
    let kv = kv();
    let now = now_ms();
    let mut fake = FakeDebrid::accepting();
    fake.fail_status = true;
    let policy = Policy::fixture();
    recheck::write(&kv, &due_lot(SEARCH, &hash_of(1), now), policy, now).unwrap();
    let control = Control::new(false, 60_000);
    let factory = factory_for(SCOPE, Arc::new(fake));
    let (_tx, mut rx) = mpsc::channel(4);
    let engine = Engine::new(&kv, policy, None, &factory, &control);

    let pass = engine.run_once(&mut rx, now).await;
    assert_eq!(pass.rechecked, 0);
    assert_eq!(pass.errors.len(), 1);
    let snapshot = control.snapshot();
    assert_eq!(
        snapshot.last_error.as_deref(),
        Some("recheck de alldebrid: status do debrid falhou")
    );
}

#[tokio::test]
async fn passagem_poda_o_cofre_e_o_status_conta_sem_vazar_chave() {
    let kv = Arc::new(kv());
    let now = now_ms();
    let vault = Arc::new(Vault::new(1_000, 4, ""));
    let scope = vault.put("alldebrid", "chave-secreta-42", now).unwrap();
    let control = Arc::new(Control::new(false, 60_000));
    let factory = no_factory();
    let (_tx, mut rx) = mpsc::channel(4);
    let engine = Engine::new(&kv, Policy::fixture(), Some(&vault), &factory, &control);

    let pass = engine.run_once(&mut rx, now + 5_000).await;
    assert_eq!(pass.forgotten_keys, 1);
    assert!(vault.key(&scope, now + 5_000).is_none());
    assert!(!control.inflight(), "passagem não pode ficar em voo");

    // Status de um handle ligado: contadores + contagem redigida do cofre.
    let handle = AutofetchHandle::stub_enabled(kv, Some(vault.clone()), control.clone());
    let status = handle.status();
    assert!(status.enabled);
    assert_eq!(status.phase, "active");
    assert!(!status.inflight);
    let json = serde_json::to_string(&status).unwrap();
    assert!(json.contains("\"lastError\":null"), "{json}");
    assert!(json.contains("\"vaultAccounts\":0"), "{json}");
    assert!(!json.contains("chave-secreta-42"), "{json}");
}
