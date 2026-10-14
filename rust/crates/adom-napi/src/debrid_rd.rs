//! Transições do ledger e do AIMD. O Node manda o estado; aqui não há I/O.

use napi_derive::napi;

#[napi(object)]
pub struct RdWriteOut {
    pub present: bool,
    pub s: String,
    pub at: f64,
    pub n: f64,
    pub ttl_seconds: f64,
    pub hash: Option<String>,
}

fn write_of(value: Option<adom_core::LedgerWrite>) -> RdWriteOut {
    match value {
        Some(write) => RdWriteOut {
            present: true,
            s: write.s.to_string(),
            at: write.at,
            n: write.n,
            ttl_seconds: write.ttl_seconds,
            hash: write.hash,
        },
        None => RdWriteOut {
            present: false,
            s: String::new(),
            at: 0.0,
            n: 0.0,
            ttl_seconds: 0.0,
            hash: None,
        },
    }
}

fn bare_gate(gap_ms: f64, successes: i64, next_allowed_at: f64, cooldown_until: f64, rate_limits: Vec<f64>) -> adom_core::GateState {
    adom_core::GateState {
        busy: false,
        gap_ms,
        successes,
        next_allowed_at,
        cooldown_until,
        next_order: 0,
        rate_limits,
        queues: adom_core::GateQueues {
            play: Vec::new(),
            cleanup: Vec::new(),
            autofetch: Vec::new(),
            probe: Vec::new(),
        },
    }
}

#[napi(catch_unwind)]
pub fn debrid_rd_next_hit(enabled: bool, hit_ttl: f64, now: f64, current: String) -> RdWriteOut {
    write_of(adom_core::next_on_hit(enabled, hit_ttl, now, &current))
}

#[napi(catch_unwind)]
#[allow(clippy::too_many_arguments)]
pub fn debrid_rd_next_miss(
    enabled: bool,
    hash: String,
    backoff_ms: Vec<f64>,
    now: f64,
    current: String,
    prior_s: Option<String>,
    prior_n: Option<f64>,
) -> RdWriteOut {
    write_of(adom_core::next_on_miss(
        enabled,
        &hash,
        &backoff_ms,
        now,
        &current,
        prior_s.as_deref(),
        prior_n,
    ))
}

#[napi(catch_unwind)]
pub fn debrid_rd_next_blocked(enabled: bool, hash: String, blocked_ttl: f64, now: f64) -> RdWriteOut {
    write_of(adom_core::next_on_blocked(enabled, &hash, blocked_ttl, now))
}

#[napi(object)]
pub struct RdRateOut {
    pub gap_ms: f64,
    pub successes: i64,
    pub next_allowed_at: f64,
    pub cooldown_until: f64,
    pub rate_limits: Vec<f64>,
    pub honored_retry_after: bool,
}

#[napi(catch_unwind)]
#[allow(clippy::too_many_arguments)]
pub fn debrid_rd_on_rate_limit(
    gap_ms: f64,
    next_allowed_at: f64,
    cooldown_until: f64,
    rate_limits: Vec<f64>,
    now: f64,
    min_gap_ms: f64,
    max_gap_ms: f64,
    cooldown_ms: f64,
    retry_after_ms: Option<f64>,
) -> RdRateOut {
    let state = bare_gate(gap_ms, 0, next_allowed_at, cooldown_until, rate_limits);
    let step = adom_core::on_rate_limit(&state, now, min_gap_ms, max_gap_ms, cooldown_ms, retry_after_ms);
    RdRateOut {
        gap_ms: step.state.gap_ms,
        successes: step.state.successes,
        next_allowed_at: step.state.next_allowed_at,
        cooldown_until: step.state.cooldown_until,
        rate_limits: step.state.rate_limits,
        honored_retry_after: step.honored_retry_after,
    }
}

#[napi(object)]
pub struct RdSuccessOut {
    pub gap_ms: f64,
    pub successes: i64,
}

#[napi(catch_unwind)]
pub fn debrid_rd_on_success(gap_ms: f64, successes: i64, success_threshold: i64, min_gap_ms: f64, max_gap_ms: f64) -> RdSuccessOut {
    let state = bare_gate(gap_ms, successes, 0.0, 0.0, Vec::new());
    let next = adom_core::on_success(&state, success_threshold, min_gap_ms, max_gap_ms);
    RdSuccessOut { gap_ms: next.gap_ms, successes: next.successes }
}

#[napi(catch_unwind)]
pub fn debrid_rd_on_finished(next_allowed_at: f64, gap_ms: f64, now: f64) -> f64 {
    let state = bare_gate(gap_ms, 0, next_allowed_at, 0.0, Vec::new());
    adom_core::on_finished(&state, now).next_allowed_at
}
