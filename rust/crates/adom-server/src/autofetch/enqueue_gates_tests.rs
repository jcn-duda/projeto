use std::collections::HashSet;

use adom_debrid::alldebrid_cleanup::adrm_key;
use adom_index::NativeKv;
use serde_json::json;

use super::{
    account_is_blocked, adrm_blocked_when, any_dubbed_from, budget_count, env_js_true,
    reserve_budget, LivePolicy,
};

#[test]
fn overlay_do_painel_define_maximo_fila_budget_e_gate() {
    let kv = NativeKv::open_memory().unwrap();
    let now = 1_800_000_000_000;
    kv.put_json(
        "cfg:v1:autofetch",
        &json!({
            "autoFetchMax": 7,
            "autoFetchTopSeedsMax": 4,
            "autoFetchQueue": true,
            "autoFetchQueueDepth": 9,
            "autoFetchEnqueueMaxHour": 13,
            "autoFetchPauseAt": 87
        }),
        86_400,
        now,
    )
    .unwrap();

    let live = LivePolicy::load(&kv, "alldebrid", now).unwrap();
    assert_eq!(live.max_attempts, 7);
    assert_eq!(live.top_seeds_max, 4);
    assert!(live.queue_enabled);
    assert_eq!(live.queue_depth, 9);
    assert_eq!(live.hourly_limit, 13);
    assert_eq!(live.pause_at, 87);
}

#[test]
fn overlay_respeita_clamps_e_fila_desligada() {
    let kv = NativeKv::open_memory().unwrap();
    let now = 1_800_000_000_000;
    kv.put_json(
        "cfg:v1:autofetch",
        &json!({
            "autoFetchMax": 99,
            "autoFetchQueue": false,
            "autoFetchQueueDepth": 9,
            "autoFetchPauseAt": -1
        }),
        86_400,
        now,
    )
    .unwrap();

    let live = LivePolicy::load(&kv, "alldebrid", now).unwrap();
    assert_eq!(live.max_attempts, 12);
    assert!(!live.queue_enabled);
    assert_eq!(live.queue_depth, 0);
    assert_eq!(live.pause_at, 0);
}

#[test]
fn gate_de_conta_e_fail_open_sem_medicao() {
    assert!(account_is_blocked(Some(2000), 2000));
    assert!(!account_is_blocked(Some(1999), 2000));
    assert!(!account_is_blocked(None, 2000));
    assert!(!account_is_blocked(Some(9000), 0));
}

#[test]
fn budgete_por_conta_usa_janela_deslizante_de_uma_hora() {
    let kv = NativeKv::open_memory().unwrap();
    let t0 = 1_800_000_000_000;
    assert_eq!(budget_count(&kv, "alldebrid", "conta", t0).unwrap(), 0);
    assert!(reserve_budget(&kv, "alldebrid", "conta", 2, t0).unwrap());
    assert!(reserve_budget(&kv, "alldebrid", "conta", 2, t0 + 1).unwrap());
    assert!(!reserve_budget(&kv, "alldebrid", "conta", 2, t0 + 2).unwrap());
    assert_eq!(budget_count(&kv, "alldebrid", "conta", t0 + 2).unwrap(), 2);
    assert!(reserve_budget(&kv, "alldebrid", "conta", 2, t0 + 3_600_001).unwrap());
}

#[test]
fn any_dubbed_usa_o_nome_do_node_e_o_alias_antigo() {
    // `_ANY` é o nome do Node (`src/config/debrid.ts:210`) e vence sempre.
    assert!(!any_dubbed_from(Some("false"), None));
    assert!(any_dubbed_from(Some("true"), Some("false")));
    assert!(
        any_dubbed_from(Some(""), Some("false")),
        "vazia = ligado no TS"
    );
    // Sem `_ANY`, o alias histórico ainda desliga o pool.
    assert!(!any_dubbed_from(None, Some("false")));
    assert!(any_dubbed_from(None, Some("true")));
    assert!(any_dubbed_from(None, None));
    // Régua do `=== 'true'`: sem trim e sem caixa.
    assert!(!env_js_true(Some(" true ")));
    assert!(!env_js_true(Some("TRUE")));
    assert!(!env_js_true(Some("1")));
    assert!(env_js_true(Some("true")));
    assert!(env_js_true(Some("")));
    assert!(env_js_true(None));
}

#[test]
fn env_do_pool_global_chega_ao_live_policy_com_a_precedencia_do_node() {
    let _guard = crate::autofetch::build::test_lock();
    let kv = NativeKv::open_memory().unwrap();
    let now = 1_800_000_000_000;
    std::env::set_var("DEBRID_AUTO_FETCH_ANY", "false");
    std::env::set_var("DEBRID_AUTO_FETCH_ANY_DUBBED", "true");
    let live = LivePolicy::load(&kv, "alldebrid", now).unwrap();
    assert!(!live.any_dubbed_enabled, "_ANY=false vence o alias ligado");
    std::env::remove_var("DEBRID_AUTO_FETCH_ANY");
    let live = LivePolicy::load(&kv, "alldebrid", now).unwrap();
    assert!(live.any_dubbed_enabled, "só o alias ligado mantém o pool");
    std::env::set_var("DEBRID_AUTO_FETCH_ANY_DUBBED", "false");
    let live = LivePolicy::load(&kv, "alldebrid", now).unwrap();
    assert!(!live.any_dubbed_enabled, "o alias ainda desliga sem _ANY");
    std::env::remove_var("DEBRID_AUTO_FETCH_ANY_DUBBED");
}

#[test]
fn adrm_le_a_marca_viva_sem_escrever_nada() {
    let kv = NativeKv::open_memory().unwrap();
    let now = 1_800_000_000_000;
    let live = "aa".repeat(20);
    let expired = "bb".repeat(20);
    let key = adrm_key("conta", &live);
    kv.put_json(&key, &json!({ "at": now }), 3_600, now)
        .unwrap();
    let old = adrm_key("conta", &expired);
    kv.put_json(&old, &json!({ "at": now }), 60, now).unwrap();

    let hashes = vec![live.clone(), expired, live.to_uppercase()];
    let blocked = adrm_blocked_when(&kv, "conta", &hashes, now + 120_000, true).unwrap();
    assert_eq!(
        blocked,
        HashSet::from([live.clone()]),
        "vencida não bloqueia"
    );
    // Leitura pura: a marca não foi reescrita nem renovada.
    assert_eq!(
        kv.remaining_seconds(&key, now + 120_000).unwrap(),
        Some(3_480)
    );
    // Kill-switch/TTL desligados devolvem vazio sem tocar no KV.
    assert!(adrm_blocked_when(&kv, "conta", &hashes, now, false)
        .unwrap()
        .is_empty());
    assert!(adrm_blocked_when(&kv, "", &hashes, now, true)
        .unwrap()
        .is_empty());
}
