//! Config AO VIVO do Chupim: o overlay que o painel grava no Node.
//!
//! O Node continua dono do formulário (`src/utils/autofetch-live.ts`, schema e
//! clamps em `autofetch-live-schema.ts`) e persiste os overrides em
//! `cfg:v1:autofetch`, no MESMO `cache.db` que o worker já abre. Sem esta ponte
//! o gateway só lia o `.env` (`Policy::from_env()`, uma vez no boot): mexer no
//! painel mudava o Chupim do Node e deixava o nativo com o TTL, o recheck, o
//! settle e a blacklist antigos.
//!
//! Precedência: **live > `.env` > default**, a mesma do `effective()` do TS
//! (`envDefaults()` + overrides). Override ausente ou ilegível = `.env`, nunca
//! erro: o Node já clampeia na escrita e um valor torto no disco não pode
//! derrubar o ciclo.
//!
//! O que NÃO mora aqui:
//! - os gates do ENFILEIRAMENTO (`autoFetchMax`, pools, fila, orçamento,
//!   `pauseAt`) são lidos no ponto do uso por `enqueue_gates::LivePolicy`;
//! - a pausa do worker tem chave própria (`autofetch-worker:v1:config`, escrita
//!   pela admin); o `paused` daqui só SOMA no boot (ver [`LiveOverlay::paused`]);
//! - a sonda dirigida e o Season Pack Fill leem o `.env` nos próprios passos
//!   (`probe_job.rs`, `season_step.rs`).
//!
//! Este módulo cobre as réguas de TEMPO do laço — exatamente as que o
//! `Policy::from_env()` congelava no boot.

use adom_index::NativeKv;
use serde_json::Value;

use super::super::Policy;

/// `${prefix('cfg')}autofetch` do Node (`src/utils/autofetch-live.ts:41`).
pub(crate) const LIVE_KEY: &str = "cfg:v1:autofetch";

/// Overrides do painel já tipados e clampados; `None` = vale o `.env`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct LiveOverlay {
    ttl_seconds: Option<i64>,
    recheck_interval_ms: Option<i64>,
    recheck_max: Option<i64>,
    stall_streak: Option<i64>,
    settle_interval_ms: Option<i64>,
    dead_ttl_seconds: Option<i64>,
    max_attempts: Option<i64>,
    queue_depth: Option<usize>,
    /// `paused` do painel. FORÇA a pausa (`||`), nunca a retira: o botão grava
    /// as duas chaves, e no runtime quem manda é a admin do gateway (o
    /// `POST /autofetch/pause` precisa poder retomar sozinho).
    pub(crate) paused: bool,
}

impl LiveOverlay {
    /// Objeto de overrides do Node. Campo ausente/ilegível vira `None` (`.env`).
    ///
    /// Os clamps são os do `clampValue` do TS (`autofetch-live.ts:101`), para o
    /// valor efetivo não depender de quem escreveu a linha no KV.
    pub(crate) fn from_value(value: &Value) -> Self {
        // `Math.trunc(n)` do TS: fração no disco é truncada, não rejeitada.
        let num = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite())
                .map(|n| n.trunc() as i64)
        };
        // `Math.max(0, n)` — os prazos não têm teto e `0` desliga.
        let span = |key: &str| num(key).map(|n| n.max(0));
        Self {
            ttl_seconds: span("autoFetchTtl"),
            recheck_interval_ms: span("autoFetchRecheckMs"),
            recheck_max: span("autoFetchRecheckMax"),
            stall_streak: span("autoFetchStallStreak"),
            settle_interval_ms: span("autoFetchSettleMs"),
            dead_ttl_seconds: span("autoFetchDeadTtl"),
            // `Math.min(12, Math.max(1, trunc(n)))`.
            max_attempts: num("autoFetchMax").map(|n| n.clamp(1, 12)),
            // `Math.min(12, Math.max(0, trunc(n)))`.
            queue_depth: num("autoFetchQueueDepth").map(|n| n.clamp(0, 12) as usize),
            paused: value
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }

    /// Linha do `cache.db`; ausente, vencida ou ilegível = sem overlay.
    pub(crate) fn load(kv: &NativeKv, now_ms: i64) -> Option<Self> {
        let value = kv.get_json(LIVE_KEY, now_ms).ok()??;
        value.is_object().then(|| Self::from_value(&value))
    }

    /// `.env` (`Policy::from_env`) + overrides.
    ///
    /// Os QUATRO usos do TTL andam juntos — lote, marker, cofre e horizonte do
    /// settle —, como o `from_env` já amarra ("UMA variável, dois usos que não
    /// podem divergir"). O horizonte NASCE do TTL: no TS ele é
    /// `createdAt + autoFetchTtl` (`autofetch-recheck.ts:347`), nunca o
    /// `autoFetchSettleMs`, que é só intervalo entre passagens de um lote já em
    /// settle.
    ///
    /// O piso de 1 s do `dead_ttl` é o mesmo do `from_env`: no KV nativo
    /// `ttl <= 0` grava PERMANENTE (`adom-index/src/kv.rs:12`) e o `0` do
    /// operador (que no Node DESLIGA a blacklist) viraria `dead:` eterno.
    pub(crate) fn apply(&self, env: &Policy) -> Policy {
        let mut policy = *env;
        if let Some(ttl) = self.ttl_seconds {
            let seconds = ttl.max(1);
            let ms = seconds.saturating_mul(1_000);
            policy.lot_ttl_seconds = seconds;
            policy.marker_ttl_seconds = seconds;
            policy.settle_horizon_ms = ms;
            policy.key_ttl_ms = ms;
        }
        if let Some(ms) = self.recheck_interval_ms {
            policy.recheck_interval_ms = ms;
        }
        if let Some(max) = self.recheck_max {
            policy.recheck_max = max;
        }
        if let Some(streak) = self.stall_streak {
            policy.stall_streak = streak;
        }
        if let Some(ms) = self.settle_interval_ms {
            policy.settle_interval_ms = ms;
        }
        if let Some(ttl) = self.dead_ttl_seconds {
            policy.dead_ttl_seconds = ttl.max(1);
        }
        if let Some(max) = self.max_attempts {
            policy.max_attempts = max;
        }
        if let Some(depth) = self.queue_depth {
            policy.queue_depth = depth;
        }
        policy
    }
}

#[cfg(test)]
#[path = "live_tests.rs"]
mod tests;
