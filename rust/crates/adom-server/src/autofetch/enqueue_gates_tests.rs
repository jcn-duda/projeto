use adom_index::NativeKv;
use serde_json::json;

use super::{account_is_blocked, budget_count, reserve_budget, LivePolicy};

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
