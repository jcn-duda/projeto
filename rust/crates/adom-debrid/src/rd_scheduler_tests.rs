use super::*;

fn config() -> RdSchedulerConfig {
    RdSchedulerConfig {
        min_gap_ms: 100.0,
        max_gap_ms: 1000.0,
        cooldown_ms: 500.0,
        play_max_wait_ms: 50.0,
        success_threshold: 2,
        enabled: true,
    }
}
fn queued(v: RdAdmission) -> u64 {
    match v {
        RdAdmission::Queued(n) => n,
        _ => panic!("esperado queued"),
    }
}

#[test]
fn prioridades_fifo_e_contas_independentes() {
    let mut gate = RdScheduler::new(config());
    let active = queued(gate.admit("a", GatePriority::Autofetch, 0.0));
    assert_eq!(gate.next("a", 0.0), RdGrant::Granted(active));
    let autofetch = queued(gate.admit("a", GatePriority::Autofetch, 0.0));
    let cleanup = queued(gate.admit("a", GatePriority::Cleanup, 0.0));
    let play = queued(gate.admit("a", GatePriority::Play, 0.0));
    let other = queued(gate.admit("b", GatePriority::Probe, 0.0));
    assert_eq!(gate.next("b", 0.0), RdGrant::Granted(other));
    assert_eq!(gate.next("a", 0.0), RdGrant::Busy);
    assert!(!gate.finish("a", autofetch, RdOutcome::Success, 0.0));
    assert!(gate.finish("a", active, RdOutcome::Success, 0.0));
    assert_eq!(gate.next("a", 0.0), RdGrant::Wait(50.0));
    assert_eq!(gate.next("a", 50.0), RdGrant::Granted(play));
    assert!(gate.finish("a", play, RdOutcome::Success, 50.0));
    assert_eq!(gate.next("a", 50.0), RdGrant::Granted(cleanup));
    assert!(gate.finish("a", cleanup, RdOutcome::Error, 50.0));
    assert_eq!(gate.next("a", 50.0), RdGrant::Wait(150.0));
    assert_eq!(gate.next("a", 150.0), RdGrant::Granted(autofetch));
}

#[test]
fn rate_limit_nega_autofetch_limpeza_fura_cooldown_e_cancelamento_nao_preempta() {
    let mut gate = RdScheduler::new(config());
    let run = queued(gate.admit("a", GatePriority::Probe, 0.0));
    assert_eq!(gate.next("a", 0.0), RdGrant::Granted(run));
    assert!(!gate.cancel("a", run));
    assert!(gate.finish("a", run, RdOutcome::RateLimit(Some(800.0)), 10.0));
    assert_eq!(gate.snapshot("a").unwrap().gap_ms, 200.0);
    assert_eq!(
        gate.admit("a", GatePriority::Autofetch, 100.0),
        RdAdmission::Denied
    );
    let cleanup = queued(gate.admit("a", GatePriority::Cleanup, 100.0));
    let play = queued(gate.admit("a", GatePriority::Play, 100.0));
    assert!(gate.cancel("a", play));
    assert_eq!(gate.next("a", 100.0), RdGrant::Granted(cleanup));
    assert!(gate.finish("a", cleanup, RdOutcome::Error, 100.0));
    assert_eq!(
        gate.admit("a", GatePriority::Autofetch, 810.0),
        RdAdmission::Queued(3)
    );
    assert_eq!(gate.next("a", 810.0), RdGrant::Granted(3));
}

#[test]
fn desligado_e_passthrough_sem_reservar() {
    let mut cfg = config();
    cfg.enabled = false;
    let mut gate = RdScheduler::new(cfg);
    assert_eq!(
        gate.admit("a", GatePriority::Play, 0.0),
        RdAdmission::Bypass
    );
    assert_eq!(gate.next("a", 0.0), RdGrant::Idle);
    assert!(!gate.finish("a", 0, RdOutcome::Success, 0.0));
}
