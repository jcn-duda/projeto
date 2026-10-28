use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::{AccountGate, AccountGateInput, AccountGateMeasurement, GateClock};

#[derive(Default)]
struct FakeClock(AtomicU64);

impl FakeClock {
    fn set(&self, value: u64) {
        self.0.store(value, Ordering::SeqCst);
    }
}

impl GateClock for FakeClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

fn input(key: &str) -> AccountGateInput {
    AccountGateInput {
        key: key.to_string(),
        pause_at: 10.0,
        refresh_ms: 500,
        occupancy_supported: false,
        ready_inventory_count: None,
    }
}

async fn wait_until(check: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(1), async {
        while !check() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("refresh em background concluiu");
}

#[tokio::test]
async fn cold_start_libera_agora_deduplica_refresh_e_memo_bloqueia_depois() {
    let clock = Arc::new(FakeClock::default());
    clock.set(100);
    let gate = Arc::new(AccountGate::new(clock.clone()));
    let refreshes = Arc::new(AtomicUsize::new(0));
    let (tx, rx) = tokio::sync::oneshot::channel();
    let refresh_count = refreshes.clone();
    assert!(!gate.blocked(input("rd:scopehash"), move || async move {
        refresh_count.fetch_add(1, Ordering::SeqCst);
        rx.await.ok().flatten()
    }));
    assert!(gate.in_flight("rd:scopehash"));
    wait_until(|| refreshes.load(Ordering::SeqCst) == 1).await;

    let duplicate_count = refreshes.clone();
    assert!(!gate.blocked(input("rd:scopehash"), move || async move {
        duplicate_count.fetch_add(1, Ordering::SeqCst);
        Some(AccountGateMeasurement {
            used: 0.0,
            max: None,
        })
    }));
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    tx.send(Some(AccountGateMeasurement {
        used: 10.0,
        max: None,
    }))
    .unwrap();
    wait_until(|| gate.memo("rd:scopehash").is_some()).await;
    assert_eq!(refreshes.load(Ordering::SeqCst), 1);
    assert_eq!(gate.memo("rd:scopehash").unwrap().at_ms, 100);

    let should_not_run = || async {
        panic!("memo quente não deve atualizar");
        #[allow(unreachable_code)]
        None
    };
    assert!(gate.blocked(input("rd:scopehash"), should_not_run));
}

#[tokio::test]
async fn piso_de_inventario_so_bloqueia_sem_occupancy() {
    let gate = AccountGate::default();
    let mut local_floor = input("tb:scopehash");
    local_floor.ready_inventory_count = Some(10);
    assert!(gate.blocked(local_floor, || async { None }));

    let mut occupancy = input("tb:otherhash");
    occupancy.occupancy_supported = true;
    occupancy.ready_inventory_count = Some(100);
    assert!(!gate.blocked(occupancy, || async { None }));
}

#[tokio::test]
async fn occupancy_usa_limite_medido_e_nao_pause_at() {
    let gate = AccountGate::default();
    let mut occupancy = input("tb:scopehash");
    occupancy.pause_at = 100.0;
    occupancy.occupancy_supported = true;
    assert!(!gate.blocked(occupancy.clone(), || async {
        Some(AccountGateMeasurement {
            used: 5.0,
            max: Some(5.0),
        })
    }));
    wait_until(|| gate.memo("tb:scopehash").is_some()).await;
    assert!(gate.blocked(occupancy, || async { None }));
    assert_eq!(gate.memo("tb:scopehash").unwrap().max, 5.0);
}

#[tokio::test]
async fn memo_vencido_libera_a_chamada_e_falha_nao_grava_dado() {
    let clock = Arc::new(FakeClock::default());
    clock.set(10);
    let gate = AccountGate::new(clock.clone());
    assert!(!gate.blocked(input("rd:scopehash"), || async {
        Some(AccountGateMeasurement {
            used: 10.0,
            max: None,
        })
    }));
    wait_until(|| gate.memo("rd:scopehash").is_some()).await;
    assert!(gate.blocked(input("rd:scopehash"), || async { None }));

    clock.set(600);
    let attempts = Arc::new(AtomicUsize::new(0));
    let failed_attempts = attempts.clone();
    assert!(!gate.blocked(input("rd:scopehash"), move || async move {
        failed_attempts.fetch_add(1, Ordering::SeqCst);
        None
    }));
    wait_until(|| attempts.load(Ordering::SeqCst) == 1 && !gate.in_flight("rd:scopehash")).await;
    // A medição velha segue visível para diagnóstico, mas não decide depois
    // do TTL: a chamada que encontrou o memo vencido foi fail-open.
    assert_eq!(gate.memo("rd:scopehash").unwrap().at_ms, 10);
    assert!(!gate.blocked(input("rd:scopehash"), || async { None }));
}

#[tokio::test]
async fn limite_de_occupancy_invalido_e_fail_open() {
    let gate = AccountGate::default();
    let mut occupancy = input("tb:scopehash");
    occupancy.occupancy_supported = true;
    assert!(!gate.blocked(occupancy, || async {
        Some(AccountGateMeasurement {
            used: 999.0,
            max: Some(0.0),
        })
    }));
    wait_until(|| !gate.in_flight("tb:scopehash")).await;
    assert_eq!(gate.memo("tb:scopehash"), None);
}
