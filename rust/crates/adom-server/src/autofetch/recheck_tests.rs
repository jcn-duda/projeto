//! Testes do recheck: lote persistido, passagem de status, morte comprovada,
//! settle/expiração com prova de posse e LRU.

use std::collections::BTreeMap;

use adom_autofetch::v3::QueueV3;
use adom_index::NativeKv;
use adom_sources::now_ms;

use super::super::fakes::FakeDebrid;
use super::super::season_fill::SeasonHint;
use super::super::Policy;
use super::{
    due, due_at, read, schedule, settle_lru, step, write, Lot, DEAD_THRESHOLD, STALL_THRESHOLD,
};
use super::{lot_key, LOT_PREFIX};

const SEARCH: &str = "tt1234567:1:2";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

fn lot(search_key: &str, hash: &str) -> Lot {
    Lot {
        search_key: search_key.to_string(),
        adapter_id: ADAPTER.to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.to_string()],
        created_at: now_ms(),
        ..Lot::default()
    }
}

fn queued(kv: &NativeKv, now: i64) -> usize {
    QueueV3::new(kv).read_queue(SEARCH, now).unwrap().len()
}

/// Fato do PACK de um release que prova a S2 (`payload.season` do pedido).
fn hint(title: &str) -> SeasonHint {
    SeasonHint {
        imdb_id: Some("tt0903747".to_string()),
        season: Some(2),
        title: title.to_string(),
    }
}

#[test]
fn schedule_arma_o_lote_e_reusa_created_at() {
    let kv = kv();
    let start = now_ms();
    let first = schedule(
        &kv,
        Policy::fixture(),
        SEARCH,
        (ADAPTER, ACCOUNT),
        &[(hash_of(1), Some("id-1".to_string()))],
        &BTreeMap::new(),
        start,
    )
    .unwrap()
    .unwrap();
    assert_eq!(first.info_hashes, vec![hash_of(1)]);
    assert_eq!(first.attempts, 0);
    assert_eq!(first.created_at, start);
    assert_eq!(first.transfers.get(&hash_of(1)), Some(&"id-1".to_string()));

    // Outra busca do MESMO título: união de hashes, contagem preservada.
    let second = schedule(
        &kv,
        Policy::fixture(),
        SEARCH,
        (ADAPTER, ACCOUNT),
        &[(hash_of(1), None), (hash_of(2), None), (hash_of(3), None)],
        &BTreeMap::new(),
        start + 1_000,
    )
    .unwrap()
    .unwrap();
    assert_eq!(second.info_hashes, vec![hash_of(1), hash_of(2), hash_of(3)]);
    assert_eq!(second.created_at, start, "reiniciar deixaria o lote eterno");
    assert_eq!(read(&kv, SEARCH, start + 2_000).unwrap(), Some(second));
}

#[test]
fn due_at_espera_pelo_menos_um_intervalo() {
    let policy = Policy::fixture();
    let mut lot = lot(SEARCH, &hash_of(1));
    lot.attempts = 0;
    assert_eq!(
        due_at(&lot, policy),
        lot.created_at + policy.recheck_interval_ms
    );
    lot.attempts = 2;
    assert_eq!(
        due_at(&lot, policy),
        lot.created_at + 2 * policy.recheck_interval_ms
    );
}

#[tokio::test]
async fn lote_vazio_derruba_a_fila_e_sai_do_kv() {
    let kv = kv();
    let now = now_ms();
    QueueV3::new(&kv)
        .write_queue(SEARCH, &[], 600, 12, None, now)
        .unwrap();
    let mut lot = lot(SEARCH, &hash_of(1));
    lot.info_hashes.clear();
    // `write` recusa lote vazio (derruba a chave), então gravamos o JSON cru:
    // o caso é um lote que esvaziou fora deste caminho e precisa ser limpo.
    kv.put_json(
        &lot_key(SEARCH),
        &serde_json::to_value(&lot).unwrap(),
        600,
        now,
    )
    .unwrap();

    let report = step(
        &kv,
        Policy::fixture(),
        &FakeDebrid::accepting(),
        true,
        SEARCH,
        now,
    )
    .await
    .unwrap();
    assert_eq!(report.outcome, Some("finished"));
    assert_eq!(queued(&kv, now), 0);
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

#[tokio::test]
async fn ready_resolve_e_o_lote_sai_quando_esvazia() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    write(&kv, &lot(SEARCH, &hash), Policy::fixture(), now).unwrap();
    let debrid = FakeDebrid::accepting().state(&hash, "ready");

    let report = step(&kv, Policy::fixture(), &debrid, true, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.resolved, 1);
    assert_eq!(report.remaining, 0);
    assert_eq!(report.outcome, Some("finished"));
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

#[tokio::test]
async fn morte_comprovada_vira_dead_da_conta() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    write(&kv, &lot(SEARCH, &hash), Policy::fixture(), now).unwrap();
    let debrid = FakeDebrid::accepting().state(&hash, "dead");
    let policy = Policy::fixture();
    let queue = QueueV3::new(&kv);

    // Primeira observação de morte: contador sobe, nada é condenado.
    let first = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
    assert_eq!(first.dead, 0);
    assert!(!queue.is_dead(ADAPTER, ACCOUNT, &hash, now).unwrap());
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.dead_streak.get(&hash), Some(&1));
    assert_eq!(saved.attempts, 1);

    // Segunda: `dead_threshold` fechou, o hash vira `dead:` da conta.
    let second = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
    assert_eq!(second.dead, 1);
    assert!(second.terminal);
    assert!(queue.is_dead(ADAPTER, ACCOUNT, &hash, now).unwrap());
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
    assert_eq!(DEAD_THRESHOLD, 2);
}

#[tokio::test]
async fn sem_resposta_nao_e_prova_de_morte() {
    let kv = kv();
    let now = now_ms();
    let hash = hash_of(1);
    write(&kv, &lot(SEARCH, &hash), Policy::fixture(), now).unwrap();
    // Adaptador sem evidência nenhuma: `unknown` não condena nem apaga.
    let debrid = FakeDebrid::accepting();
    let report = step(&kv, Policy::fixture(), &debrid, true, SEARCH, now)
        .await
        .unwrap();

    assert_eq!(report.dead, 0);
    assert_eq!(report.remaining, 1);
    assert!(!QueueV3::new(&kv)
        .is_dead(ADAPTER, ACCOUNT, &hash, now)
        .unwrap());
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.attempts, 1);
    assert_eq!(saved.dead_streak.get(&hash), Some(&0));
    assert_eq!(STALL_THRESHOLD, 3);
}

#[tokio::test]
async fn recheck_max_entra_em_settle_sem_drenar() {
    let kv = kv();
    let now = now_ms();
    let mut lot = lot(SEARCH, &hash_of(1));
    lot.attempts = Policy::fixture().recheck_max;
    write(&kv, &lot, Policy::fixture(), now).unwrap();

    let report = step(
        &kv,
        Policy::fixture(),
        &FakeDebrid::accepting(),
        true,
        SEARCH,
        now,
    )
    .await
    .unwrap();
    assert_eq!(report.outcome, Some("enter-settle"));
    assert!(!report.terminal, "settle não drena fila");
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert!(saved.is_settle);
    assert_eq!(saved.info_hashes.len(), 1);
}

#[tokio::test]
async fn settle_vencido_nao_remove_sem_prova_de_posse() {
    let kv = kv();
    let policy = Policy::fixture();
    let now = now_ms();
    let hash = hash_of(1);
    let mut lot = lot(SEARCH, &hash);
    lot.is_settle = true;
    lot.created_at = now - policy.settle_horizon_ms - 1;
    lot.transfers.insert(hash.clone(), "id-1".to_string());
    write(&kv, &lot, policy, now).unwrap();
    QueueV3::new(&kv)
        .write_queue(SEARCH, &[], 600, 12, None, now)
        .unwrap();
    let debrid = FakeDebrid::accepting().state(&hash, "downloading");

    // AllDebrid sem marker/adsub/snapshot: REPRESA, nunca remoção cega.
    let report = step(&kv, policy, &debrid, true, SEARCH, now).await.unwrap();
    assert_eq!(report.outcome, Some("finished"));
    assert_eq!(report.suppressed, 1);
    assert_eq!(report.expired, 0);
    assert!(debrid.removed().is_empty());
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

#[tokio::test]
async fn settle_vencido_fora_da_alldebrid_remove_pelo_id() {
    let kv = kv();
    let policy = Policy::fixture();
    let now = now_ms();
    let hash = hash_of(1);
    let mut lot = lot(SEARCH, &hash);
    lot.adapter_id = "realdebrid".to_string();
    lot.is_settle = true;
    lot.created_at = now - policy.settle_horizon_ms - 1;
    lot.transfers.insert(hash.clone(), "id-9".to_string());
    write(&kv, &lot, policy, now).unwrap();
    let debrid = FakeDebrid::accepting().state(&hash, "downloading");

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.expired, 1);
    assert_eq!(debrid.removed(), vec!["id-9".to_string()]);
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

#[test]
fn lru_de_settle_derruba_o_mais_antigo() {
    let kv = kv();
    let policy = Policy {
        max_settle_lots: 1,
        ..Policy::fixture()
    };
    let now = now_ms();
    for (index, search) in ["busca-a", "busca-b"].iter().enumerate() {
        let mut lot = lot(search, &hash_of(index as u32));
        lot.is_settle = true;
        lot.created_at = now + index as i64;
        write(&kv, &lot, policy, now).unwrap();
    }
    assert_eq!(settle_lru(&kv, policy, now).unwrap(), 1);
    assert_eq!(read(&kv, "busca-a", now).unwrap(), None);
    assert!(read(&kv, "busca-b", now).unwrap().is_some());
    assert_eq!(
        kv.keys_matching(LOT_PREFIX, now).unwrap(),
        vec![lot_key("busca-b")]
    );
}

#[test]
fn due_so_traz_lote_vencido() {
    let kv = kv();
    let policy = Policy::fixture();
    let now = now_ms();
    let mut fresh = lot("busca-nova", &hash_of(1));
    fresh.created_at = now;
    let mut stale = lot("busca-velha", &hash_of(2));
    stale.created_at = now - policy.recheck_interval_ms - 1;
    for lot in [&fresh, &stale] {
        write(&kv, lot, policy, now).unwrap();
    }
    let due = due(&kv, policy, now).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(due[0].search_key, "busca-velha");
}

/// Os fatos do PACK entram no lote só para hash ENFILEIRADO (o mapa é do lote,
/// não do payload) e sobrevivem à ida e volta pelo KV.
#[test]
fn schedule_guarda_hint_so_do_hash_do_lote() {
    let kv = kv();
    let start = now_ms();
    let mut hints = BTreeMap::new();
    hints.insert(hash_of(1), hint("Season 2 Complete"));
    hints.insert(hash_of(9), hint("Season 2 Complete"));

    let lot = schedule(
        &kv,
        Policy::fixture(),
        SEARCH,
        (ADAPTER, ACCOUNT),
        &[(hash_of(1), None)],
        &hints,
        start,
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        lot.season_hints.len(),
        1,
        "hash fora do lote não ganha hint"
    );

    let raw = kv.get_json(&lot_key(SEARCH), start).unwrap().unwrap();
    assert!(raw.get("seasonHints").is_some(), "{raw}");
    let saved = read(&kv, SEARCH, start).unwrap().unwrap();
    let saved_hint = saved
        .season_hints
        .get(&hash_of(1))
        .expect("hint persistido");
    assert_eq!(saved_hint.season, Some(2));
    assert_eq!(saved_hint.imdb_id.as_deref(), Some("tt0903747"));
    assert_eq!(saved_hint.title, "Season 2 Complete");
}

/// `ready` leva o hint para fora da passagem (é dele que o laço preenche) e o
/// hash que continua pendente MANTÉM o fato no lote.
#[tokio::test]
async fn ready_entrega_o_hint_e_o_pendente_mantem_o_dele() {
    let kv = kv();
    let now = now_ms();
    let (ready, pending) = (hash_of(1), hash_of(2));
    let debrid = FakeDebrid::accepting().state(&ready, "ready");

    let mut hints = BTreeMap::new();
    hints.insert(ready.clone(), hint("Season 2 Complete"));
    hints.insert(pending.clone(), hint("Season 2 Complete"));
    let mut armed = lot(SEARCH, &ready);
    armed.info_hashes = vec![ready.clone(), pending.clone()];
    armed.season_hints = hints;
    write(&kv, &armed, Policy::fixture(), now).unwrap();

    let report = step(&kv, Policy::fixture(), &debrid, true, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.ready.len(), 1, "só o hash pronto entrega fato");
    assert_eq!(report.ready[0].title, "Season 2 Complete");

    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert_eq!(saved.info_hashes, vec![pending.clone()]);
    assert!(
        !saved.season_hints.contains_key(&ready),
        "o hint do hash resolvido sai com ele"
    );
    assert!(
        saved.season_hints.contains_key(&pending),
        "o pendente não pode perder o fato do PACK"
    );
}
