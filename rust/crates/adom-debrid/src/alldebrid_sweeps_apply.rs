//! Executor das varreduras: aplica o [`SweepPlan`] em lotes, com HTTP
//! injetado, `may_delete` fail-closed e contagem por motivo.
//!
//! O modo decide tudo (nada de env aqui):
//!
//! - [`SweepMode::Off`] / [`SweepMode::ReadOnly`]: **nenhum** `DELETE` sai
//!   (`applied = false`), o plano é devolvido como diagnóstico;
//! - [`SweepMode::Apply`]: cada hash do plano passa pela guarda VIVA
//!   ([`SweepHttp::guard_live`], reavaliada IMEDIATAMENTE antes do delete) e
//!   por `may_delete` fail-closed, e vira uma chamada de [`SweepHttp::delete`].
//!
//! Falha de um id **não** interrompe o lote: o magnet continua na conta e a
//! rodada segue (`delete_failed`). Só quota/auth param tudo
//! ([`SweepHttpError::Terminal`] → [`SweepStop`]), porque insistir num teto
//! estourado só gasta a conta.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;

use adom_core::{may_delete, DeleteFacts};

use super::facts::{SweepConfig, SweepFacts};
use super::types::{MagnetRow, Reason, SweepKind, SweepMode, SweepPlan};

/// Parada da rodada por estado da conta (nunca por id isolado).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepStop {
    /// `MAGNET_TOO_MANY*`: o teto derruba até o delete.
    Quota,
    /// Chave recusada (401/403/AUTH_*).
    Auth,
}

impl SweepStop {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Quota => "quota",
            Self::Auth => "auth",
        }
    }
}

/// Erro do delete injetado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SweepHttpError {
    /// Transitório (503/rede/rate): conta como falha do id e a rodada segue.
    Failed(String),
    /// Estado da conta: para a rodada inteira.
    Terminal(SweepStop),
}

/// HTTP injetado: o executor não conhece `reqwest`, base, chave nem env. O
/// wiring do gateway implementa com `AllDebrid::delete_ids` (que já tem
/// backoff/segunda rodada na fila de delete).
pub trait SweepHttp {
    /// Remove UM id (`/magnet/delete`).
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), SweepHttpError>> + Send;
    /// Guarda VIVA reavaliada IMEDIATAMENTE antes do DELETE deste hash: hold
    /// volátil, retenção durável e preexistente podem ter chegado DEPOIS de o
    /// plano fechar, e os fatos congelados da rodada não os enxergam.
    /// `None` = não deu para reler (fail-closed: veto, como `may_delete`).
    /// Default `Some(true)`: a fonte que não prova guarda viva não inventa
    /// veto — o `may_delete` dos fatos da rodada continua sendo a régua mínima.
    fn guard_live(&self, _hash: &str) -> impl Future<Output = Option<bool>> + Send {
        async { Some(true) }
    }
}

/// Resultado da aplicação: prova do que saiu, do que falhou e do que a guarda
/// vetou — mais o plano (motivos) para a contagem por categoria.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepOutcome {
    pub kind: SweepKind,
    /// `true` só no modo `Apply` E com alvo: `false` = nenhum DELETE saiu.
    pub applied: bool,
    /// Hashes que o plano mandou apagar.
    pub planned: usize,
    /// Ids que SAÍRAM de verdade (prova para o `adrm` do wiring).
    pub removed: Vec<String>,
    /// Ids que continuam na conta.
    pub failed: Vec<String>,
    /// Ids vetados no instante do delete (guarda viva ou `may_delete`).
    pub blocked: Vec<String>,
    pub stopped: Option<SweepStop>,
    /// Chamadas de `DELETE` feitas.
    pub calls: usize,
    /// Motivo por hash: o do plano + `guard_closed`/`delete_failed` do apply.
    pub skip: BTreeMap<String, Reason>,
}

impl SweepOutcome {
    /// Contagem por categoria (inclui os motivos que só o apply conhece).
    #[must_use]
    pub fn reason_counts(&self) -> BTreeMap<&'static str, usize> {
        let mut out: BTreeMap<&'static str, usize> = BTreeMap::new();
        for reason in self.skip.values() {
            *out.entry(reason.as_str()).or_default() += 1;
        }
        out
    }

    #[must_use]
    pub fn count(&self, reason: Reason) -> usize {
        self.skip.values().filter(|item| **item == reason).count()
    }

    /// Hash → motivo do plano, sem os motivos do apply (diagnóstico das réguas).
    #[must_use]
    pub fn reason_of(&self, hash: &str) -> Option<Reason> {
        self.skip.get(hash).copied()
    }
}

/// Aplica o plano. `rows` é a MESMA lista de fatos da decisão (é dela que sai
/// o `id` do delete); `facts` serve à reavaliação fail-closed.
pub async fn apply_plan<H: SweepHttp>(
    plan: &SweepPlan,
    rows: &[MagnetRow],
    facts: &SweepFacts<'_>,
    config: &SweepConfig,
    mode: SweepMode,
    http: &H,
) -> SweepOutcome {
    let mut outcome = SweepOutcome {
        kind: plan.kind,
        applied: false,
        planned: plan.delete.len(),
        removed: Vec::new(),
        failed: Vec::new(),
        blocked: Vec::new(),
        stopped: None,
        calls: 0,
        skip: plan.skip.clone(),
    };
    // `Off`/`ReadOnly` (e plano vazio) não chamam a API: o modo manda, sem env.
    if plan.delete.is_empty() || !mode.deletes() {
        return outcome;
    }
    let by_hash: HashMap<String, &MagnetRow> = rows
        .iter()
        .map(|row| (row.normalized_hash(), row))
        .collect();
    outcome.applied = true;
    let batch = config.batch_size.max(1);
    let mut done: Vec<String> = Vec::new();
    'batches: for chunk in plan.delete.chunks(batch) {
        for hash in chunk {
            done.push(hash.clone());
            let Some(row) = by_hash.get(hash.as_str()) else {
                outcome.skip.insert(hash.clone(), Reason::MissingId);
                continue;
            };
            let Some(id) = row.usable_id() else {
                outcome.skip.insert(hash.clone(), Reason::MissingId);
                continue;
            };
            // Guarda VIVA, no instante do delete: `Some(false)` (protegido
            // agora) e `None` (não deu para reler) fecham a guarda. Sem isto,
            // um hold do autofetch que chegou depois do plano não seria visto.
            if http.guard_live(hash).await != Some(true) {
                outcome.blocked.push(id.to_string());
                outcome.skip.insert(hash.clone(), Reason::GuardClosed);
                continue;
            }
            // `may_delete` fail-closed NO INSTANTE do delete: hold novo,
            // preexistente provado ou inventário que sumiu fecham a guarda.
            let allowed = may_delete(DeleteFacts {
                inventory_loaded: facts.known_before.is_some(),
                known_before: facts
                    .known_before
                    .is_some_and(|snap| snap.contains(hash.as_str())),
                protected: facts.held.contains(hash.as_str())
                    || facts.retained.contains(hash.as_str()),
            });
            if !allowed {
                outcome.blocked.push(id.to_string());
                outcome.skip.insert(hash.clone(), Reason::GuardClosed);
                continue;
            }
            outcome.calls += 1;
            match http.delete(id).await {
                Ok(()) => outcome.removed.push(id.to_string()),
                Err(SweepHttpError::Terminal(stop)) => {
                    outcome.failed.push(id.to_string());
                    outcome.stopped = Some(stop);
                    outcome.skip.insert(hash.clone(), Reason::Stopped);
                    break 'batches;
                }
                Err(SweepHttpError::Failed(_)) => {
                    outcome.failed.push(id.to_string());
                    outcome.skip.insert(hash.clone(), Reason::DeleteFailed);
                }
            }
        }
    }
    // Parada por conta: o que nem foi tentado continua na conta e precisa
    // aparecer como `stopped`, nunca sumir do diagnóstico.
    if outcome.stopped.is_some() {
        for hash in &plan.delete {
            if !done.contains(hash) {
                outcome.skip.insert(hash.clone(), Reason::Stopped);
            }
        }
    }
    eprintln!(
        "[alldebrid] varredura {}: {} removido(s), {} falhou(ram), {} vetado(s){}",
        plan.kind.as_str(),
        outcome.removed.len(),
        outcome.failed.len(),
        outcome.blocked.len(),
        match outcome.stopped {
            Some(stop) => format!(" — parada: {}", stop.as_str()),
            None => String::new(),
        }
    );
    outcome
}
