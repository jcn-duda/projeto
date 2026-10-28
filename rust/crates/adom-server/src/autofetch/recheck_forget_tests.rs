//! Esquecimento do registro do Chupim no índice dentro do laço do recheck (M2) —
//! a parte que faltava depois do `forget_autofetch_hash` da leva do `adom-index`:
//! a régua existia e nenhum chamador a usava, então release morta continuava
//! `autofetch_seeded` por até 30 dias e ligava a via rápida da busca
//! (`orchestrator/native_index.rs:162-166`) para um hash que a conta não tem.
//!
//! # Por que arquivo próprio
//!
//! `recheck_removal_tests.rs` é o arquivo dos testes de remoção por id (M1) e da
//! blacklist do colapso, e os dois conjuntos juntos passaram do teto de 400
//! linhas. O que se prova aqui é o FIO do M2: `recheck::step` →
//! `index_record::forget` com a obra vinda do hint do lote — o status do debrid
//! não carrega IMDb, então sem `season_hints` não há chave para apagar.
//!
//! O efeito no SQLite (apaga só `source:'autofetch'`) é provado em
//! `index_record_forget_tests.rs`; aqui o sink só GUARDA a operação.

use std::sync::{Arc, Mutex};

use adom_index::NativeKv;
use adom_sources::now_ms;

use super::super::fakes::FakeDebrid;
use super::super::index_record::{clear, register, test_lock, Op, Refuse};
use super::super::season_fill::SeasonHint;
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

fn policy(remove_by_id: bool) -> Policy {
    Policy {
        remove_by_id,
        ..Policy::fixture()
    }
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

/// Esquecimentos do índice registrados para UM hash — o registro do sink é do
/// PROCESSO, então outros testes podem enfileirar os deles no mesmo vetor.
fn forgets_of(seen: &Arc<Mutex<Vec<Op>>>, wanted: &str) -> Vec<(String, String)> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|op| match op {
            Op::Forget { imdb_id, hash } if hash == wanted => Some((imdb_id.clone(), hash.clone())),
            _ => None,
        })
        .collect()
}

/// Sink do índice que só GUARDA a operação (o efeito no SQLite é provado em
/// `index_record_forget_tests.rs`).
fn recording(seen: &Arc<Mutex<Vec<Op>>>) -> Arc<dyn Fn(Op) -> Result<usize, Refuse> + Send + Sync> {
    let seen = Arc::clone(seen);
    Arc::new(move |op: Op| {
        seen.lock().unwrap().push(op);
        Ok(0)
    })
}

/// M2 (`autofetch-terminal.ts:95`): o colapso terminal ESQUECE o registro do
/// Chupim no índice — release morta ficava `autofetch_seeded` por 30 dias,
/// ligando a via rápida para um hash que a conta não tem mais. O IMDb sai do
/// hint do lote, não do status.
#[tokio::test]
async fn colapso_terminal_esquece_o_registro_do_chupim() {
    let _serial = test_lock().await;
    let kv = kv();
    let now = now_ms();
    let policy = Policy::fixture();
    let hash = hash_of(6);
    let imdb = "tt7654321";
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
    lot.season_hints.insert(
        hash.clone(),
        SeasonHint {
            imdb_id: Some(imdb.to_string()),
            season: Some(1),
            title: "Pack Completo DUBLADO".to_string(),
        },
    );
    write(&kv, &lot, policy, now).unwrap();

    let seen = Arc::new(Mutex::new(Vec::new()));
    register(recording(&seen));
    let debrid = FakeDebrid::accepting().stalled(&hash, "downloading");
    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    clear();

    assert!(report.terminal, "colapso terminal aconteceu");
    assert_eq!(
        forgets_of(&seen, &hash),
        vec![(imdb.to_string(), hash.clone())],
        "a obra veio do hint do lote"
    );
}

/// M2 no FIM do lote (`autofetch-recheck.ts:375`): settle vencido que esvaziou
/// esquece o registro do Chupim do snapshot — o hash saiu do KV, mas o `lot`
/// local ainda o tem, e é dele que sai a obra (o settle não consulta o serviço).
#[tokio::test]
async fn settle_vencido_esquece_o_registro_do_chupim() {
    let _serial = test_lock().await;
    let kv = kv();
    let now = now_ms();
    let policy = policy(false);
    let hash = hash_of(7);
    let imdb = "tt7654322";
    let mut lot = expired_lot(policy, &hash, now);
    lot.season_hints.insert(
        hash.clone(),
        SeasonHint {
            imdb_id: Some(imdb.to_string()),
            season: Some(2),
            title: "Pack S2 DUBLADO".to_string(),
        },
    );
    write(&kv, &lot, policy, now).unwrap();

    let seen = Arc::new(Mutex::new(Vec::new()));
    register(recording(&seen));
    let debrid = FakeDebrid::accepting();
    let report = step(&kv, policy, &debrid, false, SEARCH, now)
        .await
        .unwrap();
    clear();

    assert_eq!(report.outcome, Some("finished"), "o settle esvaziou");
    assert_eq!(report.expired, 1);
    assert!(read(&kv, SEARCH, now).unwrap().is_none());
    assert_eq!(
        forgets_of(&seen, &hash),
        vec![(imdb.to_string(), hash.clone())],
        "a obra veio do hint do lote"
    );
}
