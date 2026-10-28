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
//!   pela admin); o `paused` daqui só SOMA (ver [`LiveOverlay::paused`]).
//!
//! Este módulo cobre as réguas de TEMPO do laço — as que o `Policy::from_env()`
//! congelava no boot —, a pausa e os DOIS toggles de passo que liam só o `.env`:
//! sonda dirigida (`probe_job.rs`) e Season Pack Fill (`season_step.rs`).
//!
//! # Quando o boletim é lido
//!
//! O laço relê a linha a CADA passagem ([`LiveOverlay::pass`]): o boot guarda uma
//! foto (`worker::load_effective`) e foto de boot não é régua de passagem. O
//! painel vale no ciclo seguinte, não no próximo restart.
//!
//! `paused` é a EXCEÇÃO de precedência: ele só SOMA
//! (`control.paused() || overlay.paused`), porque o botão grava as duas chaves e
//! no runtime quem manda é a admin do gateway.

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
    /// `autoFetchBrProbe` — toggle da sonda dirigida (`probe_job.rs`).
    auto_fetch_br_probe: Option<bool>,
    /// `autoFetchSeasonFill` — toggle do índice E do preenchimento de temporada
    /// (`season_step.rs`).
    auto_fetch_season_fill: Option<bool>,
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
        // Fora de booleano é ausência: vale o `.env`, como no `clampValue`.
        let flag = |key: &str| value.get(key).and_then(Value::as_bool);
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
            auto_fetch_br_probe: flag("autoFetchBrProbe"),
            auto_fetch_season_fill: flag("autoFetchSeasonFill"),
            paused: value
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }

    /// `autoFetchBrProbe` do painel; `None` = vale o `.env` do passo.
    pub(crate) fn auto_fetch_br_probe(&self) -> Option<bool> {
        self.auto_fetch_br_probe
    }

    /// `autoFetchSeasonFill` do painel; `None` = vale o `.env` do passo.
    pub(crate) fn auto_fetch_season_fill(&self) -> Option<bool> {
        self.auto_fetch_season_fill
    }

    /// Linha do `cache.db`; ausente, vencida ou ilegível = sem overlay.
    ///
    /// Leitura de BOOT (foto): quem relê a cada passagem usa [`Self::pass`].
    pub(crate) fn load(kv: &NativeKv, now_ms: i64) -> Option<Self> {
        Self::read(kv, now_ms).ok().flatten()
    }

    /// Como [`Self::load`], mas a falha de store sai como erro: o laço relê a
    /// cada passagem e precisa distinguir "sem override" de "KV ilegível" —
    /// um boletim podre não pode virar override silencioso nem derrubar o ciclo.
    pub(crate) fn read(kv: &NativeKv, now_ms: i64) -> Result<Option<Self>, String> {
        let value = kv.get_json(LIVE_KEY, now_ms)?;
        Ok(value
            .filter(Value::is_object)
            .map(|value| Self::from_value(&value)))
    }

    /// Boletim + `Policy` de UMA passagem: **live > base**, com a falha de
    /// leitura devolvida à parte (nunca no lugar do overlay).
    ///
    /// É o ÚNICO caminho de leitura do laço (chega ao `Engine` a cada volta):
    /// o `Policy` do boot descreve o processo, não o instante. Falha de leitura
    /// mantém a base e vira erro da passagem — o ciclo nunca para por causa de
    /// configuração.
    pub(crate) fn pass(
        kv: &NativeKv,
        base: &Policy,
        now_ms: i64,
    ) -> (Policy, Self, Option<String>) {
        match Self::read(kv, now_ms) {
            Ok(Some(overlay)) => (overlay.apply(base), overlay, None),
            Ok(None) => (*base, Self::default(), None),
            Err(err) => (
                *base,
                Self::default(),
                Some(format!("config ao vivo: {err}")),
            ),
        }
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
