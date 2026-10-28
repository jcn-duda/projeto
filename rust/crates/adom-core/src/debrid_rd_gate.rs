//! AIMD e elegibilidade do gate RD (`src/debrid/rd-gate.ts`).
//!
//! O snapshot entra e sai; o Node guarda a fila, o sleep e as Promises.
//! `enabled` e os limites já vêm resolvidos. Ordem: play, cleanup, autofetch,
//! probe, FIFO por `order`. Cleanup ignora gap/cooldown, mas perde para play
//! já na frente e para job em voo. Play fura os dois só com `now >= bypassAt`.
//! Autofetch/probe em cooldown são `deny`. Busy não preempta.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "lowercase"))]
pub enum GatePriority {
    Play,
    Cleanup,
    Autofetch,
    Probe,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct GateWaiter {
    pub priority: GatePriority,
    pub order: u64,
    pub queued_at: f64,
    pub bypass_at: f64,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
pub struct GateQueues {
    pub play: Vec<GateWaiter>,
    pub cleanup: Vec<GateWaiter>,
    pub autofetch: Vec<GateWaiter>,
    pub probe: Vec<GateWaiter>,
}

#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "camelCase"))]
pub struct GateState {
    pub busy: bool,
    pub gap_ms: f64,
    pub successes: i64,
    pub next_allowed_at: f64,
    pub cooldown_until: f64,
    pub next_order: u64,
    pub rate_limits: Vec<f64>,
    pub queues: GateQueues,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RateLimitDecision {
    pub honored_retry_after: bool,
    pub state: GateState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "lowercase"))]
pub enum AdmitAction {
    Passthrough,
    Deny,
    Enqueue,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AdmitDecision {
    pub action: AdmitAction,
    pub state: GateState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(test, serde(rename_all = "lowercase"))]
pub enum GrantAction {
    Idle,
    Busy,
    Wait,
    Grant,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GrantDecision {
    pub action: GrantAction,
    pub until: Option<f64>,
    pub priority: Option<GatePriority>,
    pub order: Option<u64>,
    pub state: GateState,
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

pub fn limits(min_gap_ms: f64, max_gap_ms: f64) -> (f64, f64) {
    let min = js_max(0.0, min_gap_ms);
    (min, js_max(min, max_gap_ms))
}

fn empty_queues() -> GateQueues {
    GateQueues {
        play: Vec::new(),
        cleanup: Vec::new(),
        autofetch: Vec::new(),
        probe: Vec::new(),
    }
}

pub fn initial_state(min_gap_ms: f64, max_gap_ms: f64) -> GateState {
    GateState {
        busy: false,
        gap_ms: limits(min_gap_ms, max_gap_ms).0,
        successes: 0,
        next_allowed_at: 0.0,
        cooldown_until: 0.0,
        next_order: 0,
        rate_limits: Vec::new(),
        queues: empty_queues(),
    }
}

/// 429 dobra o gap (entre min e max), zera sucessos e segura a última hora.
pub fn on_rate_limit(
    state: &GateState,
    now: f64,
    min_gap_ms: f64,
    max_gap_ms: f64,
    cooldown_ms: f64,
    retry_after_ms: Option<f64>,
) -> RateLimitDecision {
    let (min, max) = limits(min_gap_ms, max_gap_ms);
    let honored = matches!(retry_after_ms, Some(ms) if ms.is_finite() && ms >= 0.0);
    let wait_ms = if honored {
        retry_after_ms.unwrap()
    } else {
        js_max(0.0, cooldown_ms)
    };
    let cooldown_until = js_max(state.cooldown_until, now + wait_ms);
    let hour_ago = now - 3_600_000.0;
    let mut rate_limits: Vec<f64> = state
        .rate_limits
        .iter()
        .copied()
        .filter(|at| *at >= hour_ago)
        .collect();
    rate_limits.push(now);
    let mut next = state.clone();
    next.gap_ms = js_min(max, js_max(min, state.gap_ms * 2.0));
    next.successes = 0;
    next.cooldown_until = cooldown_until;
    next.next_allowed_at = js_max(state.next_allowed_at, cooldown_until);
    next.rate_limits = rate_limits;
    RateLimitDecision {
        honored_retry_after: honored,
        state: next,
    }
}

/// +1. No limiar, zera e o gap cai 10% com piso no mínimo.
pub fn on_success(
    state: &GateState,
    success_threshold: i64,
    min_gap_ms: f64,
    max_gap_ms: f64,
) -> GateState {
    let mut next = state.clone();
    let grown = state.successes + 1;
    if grown < success_threshold {
        next.successes = grown;
        return next;
    }
    let (min, _) = limits(min_gap_ms, max_gap_ms);
    next.successes = 0;
    next.gap_ms = js_max(min, (state.gap_ms * 0.9).floor());
    next
}

/// Fim do job: libera busy e empurra a próxima admissão pelo gap corrente.
pub fn on_finished(state: &GateState, now: f64) -> GateState {
    let mut next = state.clone();
    next.busy = false;
    next.next_allowed_at = js_max(state.next_allowed_at, now + state.gap_ms);
    next
}

fn queue_mut(queues: &mut GateQueues, priority: GatePriority) -> &mut Vec<GateWaiter> {
    match priority {
        GatePriority::Play => &mut queues.play,
        GatePriority::Cleanup => &mut queues.cleanup,
        GatePriority::Autofetch => &mut queues.autofetch,
        GatePriority::Probe => &mut queues.probe,
    }
}

fn head(queues: &GateQueues) -> Option<&GateWaiter> {
    queues
        .play
        .first()
        .or(queues.cleanup.first())
        .or(queues.autofetch.first())
        .or(queues.probe.first())
}

pub fn bypass_at(now: f64, play_max_wait_ms: f64) -> f64 {
    now + js_max(0.0, play_max_wait_ms)
}

pub fn eligible_at(
    priority: GatePriority,
    now: f64,
    next_allowed_at: f64,
    cooldown_until: f64,
    bypass_at: f64,
) -> f64 {
    let normal_at = js_max(next_allowed_at, cooldown_until);
    match priority {
        GatePriority::Cleanup => now,
        GatePriority::Play => js_min(normal_at, bypass_at),
        GatePriority::Autofetch | GatePriority::Probe => normal_at,
    }
}

/// Admissão. Desligado atravessa; autofetch/probe em cooldown são `deny`.
pub fn admit(
    state: &GateState,
    enabled: bool,
    priority: GatePriority,
    now: f64,
    play_max_wait_ms: f64,
) -> AdmitDecision {
    if !enabled {
        return AdmitDecision {
            action: AdmitAction::Passthrough,
            state: state.clone(),
        };
    }
    if !matches!(priority, GatePriority::Play | GatePriority::Cleanup) && state.cooldown_until > now
    {
        return AdmitDecision {
            action: AdmitAction::Deny,
            state: state.clone(),
        };
    }
    let mut next = state.clone();
    let waiter = GateWaiter {
        priority,
        order: state.next_order,
        queued_at: now,
        bypass_at: bypass_at(now, play_max_wait_ms),
    };
    let queue = queue_mut(&mut next.queues, priority);
    queue.push(waiter);
    queue.sort_by_key(|a| a.order);
    next.next_order = state.next_order + 1;
    AdmitDecision {
        action: AdmitAction::Enqueue,
        state: next,
    }
}

/// Próxima concessão. Busy segura sem agendar; fila vazia é ocioso.
pub fn next_grant(state: &GateState, now: f64, enabled: bool) -> GrantDecision {
    let same = |action| GrantDecision {
        action,
        until: None,
        priority: None,
        order: None,
        state: state.clone(),
    };
    if !enabled {
        return same(GrantAction::Idle);
    }
    if state.busy {
        return same(GrantAction::Busy);
    }
    let Some(waiter) = head(&state.queues) else {
        return same(GrantAction::Idle);
    };
    let at = eligible_at(
        waiter.priority,
        now,
        state.next_allowed_at,
        state.cooldown_until,
        waiter.bypass_at,
    );
    if at > now {
        return GrantDecision {
            action: GrantAction::Wait,
            until: Some(at),
            priority: None,
            order: None,
            state: state.clone(),
        };
    }
    let mut next = state.clone();
    let priority = waiter.priority;
    let order = waiter.order;
    queue_mut(&mut next.queues, priority).remove(0);
    next.busy = true;
    GrantDecision {
        action: GrantAction::Grant,
        until: None,
        priority: Some(priority),
        order: Some(order),
        state: next,
    }
}

#[cfg(test)]
#[rustfmt::skip]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn golden() -> Value {
        serde_json::from_str(include_str!("../tests/golden/debrid_rd_decision.json")).unwrap()
    }
    fn n(v: &Value, key: &str) -> f64 { v[key].as_f64().unwrap() }
    fn st(v: &Value) -> GateState { serde_json::from_value(v.clone()).unwrap() }
    fn pri(v: &Value) -> GatePriority { serde_json::from_value(v.clone()).unwrap() }

    // Inteiro exato vira número inteiro, para bater com o JSON do oráculo.
    fn whole(v: Value) -> Value {
        match v {
            Value::Number(num) => match num.as_f64() {
                Some(f) if f.fract() == 0.0 && f.abs() <= i64::MAX as f64 => json!(f as i64),
                _ => Value::Number(num),
            },
            Value::Array(items) => Value::Array(items.into_iter().map(whole).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(k, v)| (k, whole(v))).collect()),
            other => other,
        }
    }

    fn eval(case: &Value) -> Value {
        let i = &case["input"];
        let retry = if i["retryAfterMs"].is_null() { None } else { i["retryAfterMs"].as_f64() };
        let value = match case["op"].as_str().unwrap() {
            "initial_state" => json!({ "state": initial_state(n(i, "minGapMs"), n(i, "maxGapMs")) }),
            "on_rate_limit" => {
                let out = on_rate_limit(&st(&i["state"]), n(i, "now"), n(i, "minGapMs"), n(i, "maxGapMs"), n(i, "cooldownMs"), retry);
                json!({ "honoredRetryAfter": out.honored_retry_after, "state": out.state })
            }
            "on_success" => json!({ "state": on_success(&st(&i["state"]), i["successThreshold"].as_i64().unwrap(), n(i, "minGapMs"), n(i, "maxGapMs")) }),
            "on_finished" => json!({ "state": on_finished(&st(&i["state"]), n(i, "now")) }),
            "admit" => {
                let out = admit(&st(&i["state"]), i["enabled"].as_bool().unwrap(), pri(&i["priority"]), n(i, "now"), n(i, "playMaxWaitMs"));
                json!({ "action": out.action, "state": out.state })
            }
            "next_grant" => {
                let out = next_grant(&st(&i["state"]), n(i, "now"), i["enabled"].as_bool().unwrap());
                json!({ "action": out.action, "until": out.until, "priority": out.priority, "order": out.order, "state": out.state })
            }
            other => panic!("op desconhecida: {other}"),
        };
        whole(value)
    }

    #[test]
    fn gate_matches_dist_oracle() {
        let parsed = golden();
        let cases = parsed["gate"].as_array().unwrap();
        assert!(cases.len() >= 20, "golden curto demais");
        for case in cases {
            assert_eq!(eval(case), case["expect"], "{}", case["id"]);
        }
    }
}
