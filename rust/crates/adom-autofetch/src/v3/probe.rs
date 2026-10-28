//! Estado puro da sonda BR e lease que bloqueia pool seeds.
//!
//! Espelha o antigo `br-probe.ts` (apagado na B4) sem rede: o pedido ao
//! colhedor é do executor; aqui ficam o registro persistido
//! (`state`/`at`/`leaseUntil`), a leitura que promove `pending` órfão a
//! `failed` e a decisão de agendar ou pular.
//!
//! [`ProbeRecord`] tem o MESMO JSON do antigo TS (`{state, at, leaseUntil}`).
//! Depois do corte o único leitor/escritor do registro é o worker nativo, pela
//! chave `autofetch:v3:probe:<sha256>`; o Node não tem mais ponte TS para ele
//! (as `readBrProbeNative`/`writeBrProbeNative` saíram junto), então o formato
//! segue contrato de fio apenas para o estado já persistido em disco.

/// Lease do `pending`: crash/restart não deixa seeds bloqueados para sempre.
/// Maior que os 60s com que a lista que só tem o aviso é cacheada, para o aviso
/// nunca sobreviver ao lease.
pub const PROBE_PENDING_LEASE_MS: i64 = 10 * 60_000;

/// Retry curto de `failed`/`capped`: não martela a fila e libera os seeds.
pub const PROBE_RETRY_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeState {
    Pending,
    Found,
    Empty,
    Capped,
    Failed,
}

impl ProbeState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Found => "found",
            Self::Empty => "empty",
            Self::Capped => "capped",
            Self::Failed => "failed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "found" => Some(Self::Found),
            "empty" => Some(Self::Empty),
            "capped" => Some(Self::Capped),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Registro persistido. `lease_until` só existe em `pending`.
///
/// `camelCase` porque o JSON é lido/escrito pelos DOIS lados: o `leaseUntil`
/// do `br-probe.ts` e o `lease_until` daqui são o mesmo campo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRecord {
    pub state: ProbeState,
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_until: Option<i64>,
}

impl ProbeRecord {
    pub fn new(state: ProbeState, at: i64) -> Self {
        Self {
            state,
            at,
            lease_until: None,
        }
    }

    /// O que `writePending` grava: lease de 10 min a partir de `now`.
    pub fn pending(now: i64) -> Self {
        Self {
            state: ProbeState::Pending,
            at: now,
            lease_until: Some(now + PROBE_PENDING_LEASE_MS),
        }
    }

    /// Sonda em curso AGORA (lease vivo).
    pub fn is_live_pending(&self, now: i64) -> bool {
        self.state == ProbeState::Pending && self.lease_until.unwrap_or(0) > now
    }

    /// Leitura do painel: `pending` sem lease vivo é órfão e sai como `failed`.
    pub fn effective_state(&self, now: i64) -> ProbeState {
        if self.state == ProbeState::Pending && !self.is_live_pending(now) {
            return ProbeState::Failed;
        }
        self.state
    }
}

/// Pending órfão vira `Failed`; só lease ativo bloqueia seeds.
pub fn probe_state(state: Option<ProbeState>, lease_until: i64, now: i64) -> Option<ProbeState> {
    match state {
        Some(ProbeState::Pending) if lease_until <= now => Some(ProbeState::Failed),
        other => other,
    }
}

pub fn probe_blocks_seeds(state: Option<ProbeState>, lease_until: i64, now: i64) -> bool {
    matches!(
        probe_state(state, lease_until, now),
        Some(ProbeState::Pending)
    )
}

/// Fatos da sonda para a decisão de agendar. `enabled` cobre toggle + RELEASE_INDEX
/// + interseção não vazia — quem mede isso é o executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeInput {
    pub enabled: bool,
    pub record: Option<ProbeRecord>,
    pub now_ms: i64,
}

/// Por que a sonda NÃO foi agendada. Nome do `skipped` do TS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeSkip {
    /// Toggle/RELEASE_INDEX/interseção: o chamador mantém o `br-gap` normal.
    Disabled,
    /// Já existe sonda procurando (lease vivo).
    Pending,
    /// BR já provado: dedupe de 12h, e NÃO bloqueia seeds.
    Found,
    /// Sonda completou sem BR há pouco: dedupe, seeds já liberados.
    Empty,
    /// `failed`/`capped` dentro do retry curto.
    Retry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeDecision {
    /// Agendar. `orphan` = havia `pending` com lease vencido (crash/restart):
    /// métrica própria, e o reagendamento é legítimo.
    Schedule {
        orphan: bool,
    },
    Skip(ProbeSkip),
}

/// `requestBrProbe` sem rede: só diz se o pedido deve sair.
///
/// Um lease órfão NÃO bloqueia — senão um crash seguraria as sementes para
/// sempre. `found`/`empty` deduplicam a sonda mas liberam seeds: quem decide
/// baixar swarm para a mesma obra é a lista/índice na próxima abertura.
pub fn probe_step(input: ProbeInput) -> ProbeDecision {
    if !input.enabled {
        return ProbeDecision::Skip(ProbeSkip::Disabled);
    }
    let Some(record) = input.record else {
        return ProbeDecision::Schedule { orphan: false };
    };
    if record.is_live_pending(input.now_ms) {
        return ProbeDecision::Skip(ProbeSkip::Pending);
    }
    match record.state {
        ProbeState::Found => return ProbeDecision::Skip(ProbeSkip::Found),
        ProbeState::Empty => return ProbeDecision::Skip(ProbeSkip::Empty),
        ProbeState::Failed | ProbeState::Capped => {
            if input.now_ms - record.at < PROBE_RETRY_MS {
                return ProbeDecision::Skip(ProbeSkip::Retry);
            }
        }
        ProbeState::Pending => {
            // Lease vencido: órfão, reagenda sem esperar o retry.
            return ProbeDecision::Schedule { orphan: true };
        }
    }
    ProbeDecision::Schedule { orphan: false }
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
