//! Remoção por id no settle (knob `DEBRID_REMOVE_BY_ID`) e blacklist do
//! colapso terminal — os dois pontos onde o worker nativo tinha perdido a régua
//! do TS (`git show HEAD:src/providers/autofetch-terminal.ts` e
//! `autofetch-recheck.ts:340`).
//!
//! A régua PURA já é testada em `adom-autofetch/src/v3/recheck_tests.rs`; o que
//! se prova aqui é o FIO: `Policy` → `RecheckInput` → ação → efeito no KV e na
//! porta do debrid. Inclui a retenção viva (`adhold:v1:`/`adprot:v1:`) em
//! serviço que NÃO é a AllDebrid: `isCleanupProtected` barra a remoção em
//! qualquer adaptador, então o hash vai para a represa.

use adom_autofetch::v3::{QueueV3, SuppressedV3};
use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::json;

use super::super::fakes::FakeDebrid;
use super::super::Policy;
use super::{read, step, write, Lot};

const SEARCH: &str = "tt7654321:1:2";
const ADAPTER: &str = "realdebrid";
const ACCOUNT: &str = "conta-de-teste";
const TRANSFER: &str = "id-transfer";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    NativeKv::open_memory().unwrap()
}

/// Lote em settle já vencido, com a transferência ancorada no id — o caso do
/// `expired-unready` do Node.
fn expired_lot(policy: Policy, hash: &str, now: i64) -> Lot {
    let mut lot = Lot {
        search_key: SEARCH.to_string(),
        adapter_id: ADAPTER.to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.to_string()],
        created_at: now - policy.settle_horizon_ms - 1,
        is_settle: true,
        ..Lot::default()
    };
    lot.transfers.insert(hash.to_string(), TRANSFER.to_string());
    lot
}

fn policy(remove_by_id: bool) -> Policy {
    Policy {
        remove_by_id,
        ..Policy::fixture()
    }
}

/// Knob DESLIGADO (o default do Node) + status identificado só pelo id: a
/// remoção NÃO acontece — a transferência vai para a represa, com o id, para o
/// dreno do knob/painel cobrar depois.
#[tokio::test]
async fn knob_desligado_barra_remocao_por_id_e_represa_o_id() {
    let kv = kv();
    let now = now_ms();
    let policy = policy(false);
    let hash = hash_of(1);
    let mut lot = expired_lot(policy, &hash, now);
    lot.via_id.insert(hash.clone());
    write(&kv, &lot, policy, now).unwrap();
    let debrid = FakeDebrid::accepting();

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.suppressed, 1);
    assert_eq!(report.expired, 0);
    assert!(
        debrid.removed().is_empty(),
        "knob OFF não pode apagar por id"
    );

    // O id continua registrado: represa, não lixo.
    let held = SuppressedV3::new(&kv)
        .read(ADAPTER, ACCOUNT, &hash, now)
        .unwrap()
        .expect("registro de represa");
    assert_eq!(held.id, TRANSFER);
    // E o hash saiu do lote: a decisão foi tomada, não adiada.
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

/// Knob LIGADO: a mesma transferência é removida pelo id.
#[tokio::test]
async fn knob_ligado_remove_pelo_id() {
    let kv = kv();
    let now = now_ms();
    let policy = policy(true);
    let hash = hash_of(2);
    let mut lot = expired_lot(policy, &hash, now);
    lot.via_id.insert(hash.clone());
    write(&kv, &lot, policy, now).unwrap();
    let debrid = FakeDebrid::accepting();

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.expired, 1);
    assert_eq!(report.suppressed, 0);
    assert_eq!(debrid.removed(), vec![TRANSFER.to_string()]);
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

/// Hash visto por HASH remove com o knob desligado: o freio é do `via === 'id'`,
/// nunca da remoção histórica (é o que mantém o settle fora da AllDebrid vivo).
#[tokio::test]
async fn hash_identificado_por_hash_remove_sem_o_knob() {
    let kv = kv();
    let now = now_ms();
    let policy = policy(false);
    let hash = hash_of(3);
    write(&kv, &expired_lot(policy, &hash, now), policy, now).unwrap();
    let debrid = FakeDebrid::accepting();

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    assert_eq!(report.expired, 1);
    assert_eq!(debrid.removed(), vec![TRANSFER.to_string()]);
}

/// A passagem de status GRAVA o `via` no lote e o sobrescreve na observação
/// seguinte: o settle lê a identificação mais recente, não a primeira.
#[tokio::test]
async fn poll_grava_o_via_id_no_lote_e_a_ultima_observacao_manda() {
    let kv = kv();
    let now = now_ms();
    let policy = Policy::fixture();
    let hash = hash_of(4);
    let mut lot = Lot {
        search_key: SEARCH.to_string(),
        adapter_id: "premiumize".to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.clone()],
        created_at: now,
        ..Lot::default()
    };
    lot.transfers.insert(hash.clone(), TRANSFER.to_string());
    write(&kv, &lot, policy, now).unwrap();

    // Transferência que o serviço só conhece pelo id.
    let by_id = FakeDebrid::accepting().via_id(&hash, "downloading");
    step(&kv, policy, &by_id, false, SEARCH, now).await.unwrap();
    let saved = read(&kv, SEARCH, now).unwrap().unwrap();
    assert!(
        saved.via_id.contains(&hash),
        "via id precisa chegar ao lote"
    );

    // Na passagem seguinte o mesmo hash é visto por HASH: a marca caduca, senão
    // um id antigo barraria a remoção para sempre.
    let by_hash = FakeDebrid::accepting().state(&hash, "downloading");
    step(&kv, policy, &by_hash, false, SEARCH, now + 1)
        .await
        .unwrap();
    let saved = read(&kv, SEARCH, now + 1).unwrap().unwrap();
    assert!(!saved.via_id.contains(&hash), "última observação manda");
}

/// Colapso `TerminalStalled` blacklista como o `collapseTerminal` do TS: o hash
/// parado sai do lote E vira `dead:` da conta (senão volta na busca seguinte).
#[tokio::test]
async fn parado_terminal_blacklista_como_o_ts() {
    let kv = kv();
    let now = now_ms();
    let policy = Policy::fixture();
    let hash = hash_of(5);
    let mut lot = Lot {
        search_key: SEARCH.to_string(),
        adapter_id: "torbox".to_string(),
        account: ACCOUNT.to_string(),
        info_hashes: vec![hash.clone()],
        created_at: now,
        ..Lot::default()
    };
    // Falta UMA observação de parada para fechar o limiar (`stall_streak`).
    lot.stall_streak
        .insert(hash.clone(), policy.stall_streak - 1);
    write(&kv, &lot, policy, now).unwrap();
    let debrid = FakeDebrid::accepting().stalled(&hash, "downloading");

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    assert!(report.terminal);
    assert_eq!(report.dead, 0, "parada não é morte comprovada");
    assert_eq!(report.resolved, 1);
    assert!(QueueV3::new(&kv)
        .is_dead("torbox", ACCOUNT, &hash, now)
        .unwrap());
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
}

/// M1 (`git show HEAD:src/providers/autofetch-expired.ts`, `isCleanupProtected`):
/// o HOLD volátil (`adhold:v1:`) barra a remoção em QUALQUER serviço — aqui
/// fora da AllDebrid, onde a remoção histórica é preservada por padrão. O hash
/// vai para a represa, com o id, e o serviço não é chamado (invariante 6 do
/// `AGENTS.md`).
#[tokio::test]
async fn hold_vivo_represa_o_hash_fora_da_alldebrid() {
    let kv = kv();
    let now = now_ms();
    // Knob LIGADO: sem o hold a remoção aconteceria (ver
    // `hash_identificado_por_hash_remove_sem_o_knob`), então o que barra aqui é
    // a retenção viva, não o freio do id.
    let policy = policy(true);
    let hash = hash_of(7);
    write(&kv, &expired_lot(policy, &hash, now), policy, now).unwrap();
    kv.put_json(
        &format!("adhold:v1:{ACCOUNT}:{hash}"),
        &json!({ "until": now + 60_000 }),
        600,
        now,
    )
    .unwrap();
    let debrid = FakeDebrid::accepting();

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();

    assert_eq!(report.suppressed, 1, "hold vivo vai para a represa");
    assert_eq!(report.expired, 0);
    assert!(
        debrid.removed().is_empty(),
        "retenção viva não pode apagar: {:?}",
        debrid.removed()
    );
    let held = SuppressedV3::new(&kv)
        .read(ADAPTER, ACCOUNT, &hash, now)
        .unwrap()
        .expect("registro de represa");
    assert_eq!(held.id, TRANSFER);
}

/// M1, a outra metade: a proteção DURÁVEL do pool BR (`adprot:v1:`) também
/// barra a remoção fora da AllDebrid — o TS chama `isCleanupProtected` com o
/// `adapter.id`, não só quando o adaptador é a AllDebrid.
#[tokio::test]
async fn prot_do_pool_br_represa_o_hash_fora_da_alldebrid() {
    let kv = kv();
    let now = now_ms();
    let policy = policy(true);
    let hash = hash_of(8);
    write(&kv, &expired_lot(policy, &hash, now), policy, now).unwrap();
    kv.put_json(
        &format!("adprot:v1:{ADAPTER}:{ACCOUNT}:{hash}"),
        &json!({ "acceptedAt": now, "readyAt": now }),
        600,
        now,
    )
    .unwrap();
    let debrid = FakeDebrid::accepting();

    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();

    assert_eq!(report.suppressed, 1, "adprot vai para a represa");
    assert_eq!(report.expired, 0);
    assert!(
        debrid.removed().is_empty(),
        "proteção do pool BR não pode apagar: {:?}",
        debrid.removed()
    );
    let held = SuppressedV3::new(&kv)
        .read(ADAPTER, ACCOUNT, &hash, now)
        .unwrap()
        .expect("registro de represa");
    assert_eq!(held.id, TRANSFER);
}
