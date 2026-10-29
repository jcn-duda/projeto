//! Contadores e SNAPSHOT das varreduras da AllDebrid — memória do processo.
//!
//! Cumulativos desde o boot e **nunca** persistidos: depois de um restart o
//! painel vê zero, não um histórico inferido. O snapshot é operacional e NÃO
//! carrega hash, id de magnet, `apiKey` nem escopo de conta — só o que a
//! execução (`al_sweeps_run`) devolveu, agregado.
//!
//! Separado do núcleo (`al_sweeps.rs`) para o arquivo caber no teto de 400
//! linhas: aqui só se conta e se monta JSON; nada fala com a conta nem com o
//! `cache.db`.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use adom_debrid::alldebrid_sweeps::{SweepKind, SweepOutcome, SweepStop};

use super::facts::TickReport;
use super::KINDS;

/// Contagem de UM tipo de varredura.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct KindCounters {
    pub(crate) runs: usize,
    pub(crate) planned: usize,
    pub(crate) swept: usize,
    pub(crate) failed: usize,
    pub(crate) blocked: usize,
    pub(crate) calls: usize,
}

impl KindCounters {
    fn to_json(self) -> Value {
        json!({
            "runs": self.runs,
            "planned": self.planned,
            "swept": self.swept,
            "failed": self.failed,
            "blocked": self.blocked,
            "calls": self.calls,
        })
    }
}

/// Contadores cumulativos da instância.
///
/// `by_kind` nasce com os quatro nomes canônicos em zero: ausência de chave
/// não é informação para o painel, zero explícito é.
#[derive(Debug, Clone, Default)]
pub(crate) struct SweepCounters {
    pub(crate) runs: usize,
    pub(crate) manual_runs: usize,
    pub(crate) reentered: usize,
    pub(crate) not_due: usize,
    /// Tipos que acordaram sem listagem da conta (`missing` da rodada).
    pub(crate) missing: usize,
    pub(crate) planned: usize,
    /// Ids REALMENTE removidos (nunca "planejados").
    pub(crate) swept: usize,
    pub(crate) failed: usize,
    pub(crate) blocked: usize,
    pub(crate) calls: usize,
    pub(crate) by_kind: BTreeMap<&'static str, KindCounters>,
    /// `SweepOutcome::reason_counts()` somado de todos os tipos.
    pub(crate) reasons: BTreeMap<&'static str, usize>,
}

impl SweepCounters {
    /// Zerado, com os quatro tipos já presentes (ordem canônica fixa).
    pub(crate) fn new() -> Self {
        let mut counters = Self::default();
        for kind in KINDS {
            counters
                .by_kind
                .insert(kind.as_str(), KindCounters::default());
        }
        counters
    }

    /// Grava UMA rodada. `reentered` e `not_due` contam sem sobrescrever o
    /// `last`: não houve execução para resumir. Rodada sem outcome (modo `Off`)
    /// não conta como rodada — nada rodou de verdade.
    pub(crate) fn record(
        &mut self,
        report: &TickReport,
        now_ms: i64,
        manual: bool,
        last: &mut Option<TickSummary>,
    ) {
        if report.reentered {
            self.reentered += 1;
            return;
        }
        if report.not_due {
            self.not_due += 1;
            return;
        }
        if report.outcomes.is_empty() {
            return;
        }
        self.runs += 1;
        if manual {
            self.manual_runs += 1;
        }
        self.missing += report.missing.len();
        let mut outcomes = Vec::with_capacity(report.outcomes.len());
        for outcome in &report.outcomes {
            self.absorb(outcome);
            outcomes.push(OutcomeSummary::new(outcome));
        }
        *last = Some(TickSummary {
            at_ms: now_ms,
            manual,
            outcomes,
            missing: report.missing.clone(),
        });
    }

    /// Um tipo da rodada: totais e a linha do `by_kind`.
    fn absorb(&mut self, outcome: &SweepOutcome) {
        let swept = outcome.removed.len();
        let failed = outcome.failed.len();
        let blocked = outcome.blocked.len();
        self.planned += outcome.planned;
        self.swept += swept;
        self.failed += failed;
        self.blocked += blocked;
        self.calls += outcome.calls;
        for (reason, count) in outcome.reason_counts() {
            *self.reasons.entry(reason).or_default() += count;
        }
        let entry = self.by_kind.entry(outcome.kind.as_str()).or_default();
        entry.runs += 1;
        entry.planned += outcome.planned;
        entry.swept += swept;
        entry.failed += failed;
        entry.blocked += blocked;
        entry.calls += outcome.calls;
    }

    /// `swept` de um tipo (o `sweptUndubbed` é atalho, não estado paralelo).
    pub(crate) fn swept_of(&self, kind: SweepKind) -> usize {
        self.by_kind
            .get(kind.as_str())
            .map_or(0, |counters| counters.swept)
    }

    /// Formato do §3.1 (`counters`): camelCase, chaves fixas, sem credencial.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "runs": self.runs,
            "manualRuns": self.manual_runs,
            "reentered": self.reentered,
            "notDue": self.not_due,
            "missing": self.missing,
            "planned": self.planned,
            "swept": self.swept,
            "sweptUndubbed": self.swept_of(SweepKind::Undubbed),
            "failed": self.failed,
            "blocked": self.blocked,
            "calls": self.calls,
            "byKind": self.by_kind_json(),
            "reasons": self.reasons,
        })
    }

    fn by_kind_json(&self) -> Value {
        let mut out = Map::new();
        for kind in KINDS {
            let counters = self.by_kind.get(kind.as_str()).copied().unwrap_or_default();
            out.insert(kind.as_str().to_string(), counters.to_json());
        }
        Value::Object(out)
    }
}

/// Resumo de UM tipo numa rodada — também o corpo do `POST /sweeps/run`.
#[derive(Debug, Clone)]
pub(crate) struct OutcomeSummary {
    pub(crate) kind: SweepKind,
    pub(crate) applied: bool,
    pub(crate) planned: usize,
    pub(crate) swept: usize,
    pub(crate) failed: usize,
    pub(crate) blocked: usize,
    pub(crate) stopped: Option<&'static str>,
    pub(crate) calls: usize,
    pub(crate) reasons: BTreeMap<&'static str, usize>,
}

impl OutcomeSummary {
    pub(crate) fn new(outcome: &SweepOutcome) -> Self {
        Self {
            kind: outcome.kind,
            applied: outcome.applied,
            planned: outcome.planned,
            swept: outcome.removed.len(),
            failed: outcome.failed.len(),
            blocked: outcome.blocked.len(),
            stopped: stop_name(outcome.stopped),
            calls: outcome.calls,
            reasons: outcome.reason_counts(),
        }
    }

    /// Tipo sem execução (rodada vazia): zeros explícitos, nada inventado.
    pub(crate) fn zero(kind: SweepKind) -> Self {
        Self {
            kind,
            applied: false,
            planned: 0,
            swept: 0,
            failed: 0,
            blocked: 0,
            stopped: None,
            calls: 0,
            reasons: BTreeMap::new(),
        }
    }

    pub(crate) fn to_json(&self) -> Value {
        json!({
            "kind": self.kind.as_str(),
            "applied": self.applied,
            "planned": self.planned,
            "swept": self.swept,
            "failed": self.failed,
            "blocked": self.blocked,
            "stopped": self.stopped,
            "calls": self.calls,
            "reasons": self.reasons,
        })
    }
}

/// Resumo da última rodada que executou (`last` do §3.1).
#[derive(Debug, Clone)]
pub(crate) struct TickSummary {
    pub(crate) at_ms: i64,
    pub(crate) manual: bool,
    pub(crate) outcomes: Vec<OutcomeSummary>,
    pub(crate) missing: Vec<SweepKind>,
}

impl TickSummary {
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "at": self.at_ms,
            "manual": self.manual,
            "outcomes": self.outcomes.iter().map(OutcomeSummary::to_json).collect::<Vec<_>>(),
            "missing": self.missing.iter().map(|kind| kind.as_str()).collect::<Vec<_>>(),
        })
    }
}

/// Foto do agendador para o painel. `running` é o guard de anti-reentrada:
/// `true` = uma rodada (agendada ou manual) está em voo agora.
#[derive(Debug, Clone)]
pub(crate) struct SweepSnapshot {
    pub(crate) started_at_ms: i64,
    pub(crate) running: bool,
    pub(crate) last_tick: Option<TickSummary>,
    pub(crate) counters: SweepCounters,
    pub(crate) next_due_at_ms: Option<i64>,
    /// Relógio por tipo (`mark_run`); ordem canônica do [`KINDS`].
    pub(crate) last_by_kind: Vec<(SweepKind, i64)>,
}

impl SweepSnapshot {
    /// Foto ZERADA de quem não tem agendador (runtime desligado ou não
    /// injetado): `enabled:false` já diz o resto, e inventar histórico é
    /// exatamente o que o contrato proíbe.
    pub(crate) fn idle(started_at_ms: i64) -> Self {
        Self {
            started_at_ms,
            running: false,
            last_tick: None,
            counters: SweepCounters::new(),
            next_due_at_ms: None,
            last_by_kind: Vec::new(),
        }
    }

    /// Corpo do `GET /sweeps` (§3.1), sem `ok`/`mode`/`enabled` — esses vêm do
    /// `SweepAdmin`, que é quem sabe o que está montado.
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "running": self.running,
            "startedAt": (self.started_at_ms > 0).then_some(self.started_at_ms),
            "lastTickAt": self.last_tick.as_ref().map(|tick| tick.at_ms),
            "nextDueAt": self.next_due_at_ms,
            "lastByKind": self.last_by_kind_json(),
            "counters": self.counters.to_json(),
            "last": self.last_tick.as_ref().map(TickSummary::to_json),
        })
    }

    fn last_by_kind_json(&self) -> Value {
        let mut out = Map::new();
        for kind in KINDS {
            let at = self
                .last_by_kind
                .iter()
                .find(|(known, _)| *known == kind)
                .map(|(_, at)| *at);
            out.insert(kind.as_str().to_string(), json!(at));
        }
        Value::Object(out)
    }
}

/// Menor instante em que um tipo JÁ RODADO volta a vencer. Tipo que nunca
/// rodou vence no próximo tick, então a foto não anuncia data futura: `None`.
pub(crate) fn next_due_at(last: &[(SweepKind, i64)], interval_ms: i64) -> Option<i64> {
    last.iter()
        .map(|(_, at)| at.saturating_add(interval_ms))
        .min()
}

fn stop_name(stop: Option<SweepStop>) -> Option<&'static str> {
    stop.map(SweepStop::as_str)
}
