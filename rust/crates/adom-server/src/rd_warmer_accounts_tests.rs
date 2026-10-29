//! Prova que o selo do painel gravado pelo `secret-box.ts` do Node abre no
//! Rust: o blob abaixo foi produzido por
//! `crypto.createCipheriv('aes-256-gcm')` + `scryptSync`, e o warmer tem de
//! usá-lo para a conta do operador (`cfg:v1:harvesterDebrid`).
//!
//! Também prende a precedência: painel com outro serviço DESLIGA o warm e não
//! cai no `.env` por baixo.

use std::sync::{Mutex, OnceLock};

use adom_core::prefix;
use adom_index::NativeKv;
use serde_json::json;

use super::accounts::OperatorAccounts;
use crate::autofetch::Vault;
use crate::rd_warmer::WarmKey;

const SECRET: &str = "adom-warmer-test-secret";
const KEY: &str = "rd-key-para-teste-123";
/// `secretBox.seal('rd-key-para-teste-123')` com `RESOLVE_SECRET` acima.
const NODE_SEALED: &str =
    "enc.v1.qiFnePHHEKx1q5stFq50EWdU7MjFU1Dov8fTtHsF_B2uicHiapPzuA8fga-WZDztvA";

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|err| err.into_inner())
}

fn panel(kv: &NativeKv, service: &str, sealed: &str, now: i64) {
    let value = json!({ "service": service, "sealedKey": sealed, "updatedAt": 1 });
    kv.put_json(&format!("{}harvesterDebrid", prefix("cfg")), &value, 0, now)
        .expect("painel de teste");
}

#[test]
fn selo_do_node_abre_no_warmer() {
    let _guard = env_lock();
    std::env::set_var("RESOLVE_SECRET", SECRET);
    let kv = NativeKv::open_memory().expect("kv de teste");
    let now = adom_sources::now_ms();
    panel(&kv, "realdebrid", NODE_SEALED, now);
    let accounts = OperatorAccounts::new(None, Some(std::sync::Arc::new(kv)));

    let expected_scope = Vault::scope_of("realdebrid", KEY).expect("escopo");
    assert_eq!(accounts.rd_key("", now).as_deref(), Some(KEY));
    assert_eq!(accounts.rd_key(&expected_scope, now).as_deref(), Some(KEY));
    assert_eq!(
        accounts.default_scope(now).as_deref(),
        Some(expected_scope.as_str())
    );
    assert_eq!(accounts.account_source(now), "panel");
    // Escopo de OUTRA conta não recebe a credencial do operador.
    assert_eq!(accounts.rd_key("realdebrid:outra-conta", now), None);

    std::env::remove_var("RESOLVE_SECRET");
}

#[test]
fn painel_de_outro_servico_desliga_sem_cair_no_env() {
    let _guard = env_lock();
    std::env::set_var("RESOLVE_SECRET", SECRET);
    let kv = NativeKv::open_memory().expect("kv de teste");
    let now = adom_sources::now_ms();
    panel(&kv, "alldebrid", NODE_SEALED, now);
    let accounts = OperatorAccounts::new(None, Some(std::sync::Arc::new(kv)));

    assert_eq!(accounts.rd_key("", now), None);
    assert_eq!(accounts.default_scope(now), None);
    assert_eq!(accounts.account_source(now), "none");

    std::env::remove_var("RESOLVE_SECRET");
}
