//! Replay dos runs que ficaram `running` (T1-B3) — fecha a 5H.
//!
//! Um run só fica aberto no journal quando o processo morre entre o
//! `journal_begin` e o fechamento. No boot seguinte o slot durável do processo
//! anterior ainda está no MESMO documento da fila (`store_document.rs`) e
//! [`crate::HarvestQueue::load_from`] já devolve a obra à fila — mas o journal
//! continuaria dizendo `running` por 24 h, e o painel mentiria.
//!
//! # O que este módulo decide
//!
//! - Run `running` com slot correspondente (`lease.run_id` igual) → a obra
//!   VOLTA à fila; o run fecha com `interrupted` (ou `lease_expired`, se a
//!   lease já venceu) e a entrada é marcada `resumed`.
//! - Run `running` sem slot correspondente → nada a retomar: fecha `orphan`.
//!
//! O replay roda UMA vez no boot, ANTES do `load_from` (depois dele o slot já
//! foi reclamado e não há como distinguir os dois casos). Ele NÃO cria slot
//! novo nem toca na fila: quem devolve a obra é o `load_from`, e o chamador só
//! marca `resumed` nas entradas que este relatório apontou.

use crate::journal::JOURNAL_PREFIX;
use crate::lease::InflightEntry;
use crate::store::HarvestStore;

/// Run aberto lido do journal (o que o replay precisa para decidir).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRun {
    pub run_id: String,
    pub obra: String,
    pub started_ms: i64,
    /// Passos já executados, na ordem.
    pub steps: Vec<String>,
}

impl PendingRun {
    /// O passo ainda NÃO foi executado neste run (`false` = já marcado).
    pub fn missing_step(&self, step: &str) -> bool {
        !self.steps.iter().any(|done| done == step)
    }
}

/// Desfecho do replay no boot.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplayReport {
    /// Runs `running` encontrados antes do replay.
    pub pending: usize,
    /// Obras que voltam à fila (o run tinha slot em voo).
    pub resumed: Vec<InflightEntry>,
    /// Runs sem slot correspondente — fechados como `orphan`.
    pub orphans: usize,
}

impl ReplayReport {
    /// Quantas obras foram retomadas.
    pub fn replayed(&self) -> usize {
        self.resumed.len()
    }

    /// Runs que continuaram abertos (só sobra quando a escrita do journal
    /// falhou — o painel não pode esconder isso).
    pub fn pending_after(&self) -> usize {
        self.pending
            .saturating_sub(self.resumed.len() + self.orphans)
    }
}

/// Runs com `status == "running"` (JSON podre/expirado já sai como ausente).
pub fn pending_runs(store: &HarvestStore, now_ms: i64) -> Result<Vec<PendingRun>, String> {
    let mut out = Vec::new();
    for key in store.journal_keys(now_ms)? {
        let Some(run_id) = key.strip_prefix(JOURNAL_PREFIX) else {
            continue;
        };
        let Some(run) = store.journal_get(run_id, now_ms)? else {
            continue;
        };
        if run.status != "running" || run.finished_ms.is_some() {
            continue;
        }
        out.push(PendingRun {
            run_id: run_id.to_string(),
            obra: run.obra,
            started_ms: run.started_ms,
            steps: run.steps,
        });
    }
    Ok(out)
}

/// Fecha os runs pendentes e devolve quais obras voltam à fila.
///
/// Erro só quando o documento da fila não pode ser lido: sem ele não há como
/// saber o que retomar, e chutar `orphan` apagaria a evidência.
pub fn replay_pending(store: &HarvestStore, now_ms: i64) -> Result<ReplayReport, String> {
    let pending = pending_runs(store, now_ms)?;
    let mut report = ReplayReport {
        pending: pending.len(),
        ..ReplayReport::default()
    };
    if pending.is_empty() {
        return Ok(report);
    }
    // Documento CRU: o slot do processo anterior ainda está aqui (o `load_from`
    // roda depois e é quem o devolve à fila).
    let slot = store.load_queue(now_ms)?.inflight;
    for run in pending {
        match slot.as_ref().filter(|slot| slot.lease.run_id == run.run_id) {
            Some(found) => {
                let reason = if found.expired(now_ms) {
                    "lease_expired"
                } else {
                    "interrupted"
                };
                match store.journal_fail(&run.run_id, reason, now_ms) {
                    Ok(()) => report.resumed.push(found.clone()),
                    Err(err) => eprintln!(
                        "[harvest] replay: run {} não fechou como {reason}: {err}",
                        run.run_id
                    ),
                }
            }
            None => match store.journal_fail(&run.run_id, "orphan", now_ms) {
                Ok(()) => report.orphans = report.orphans.saturating_add(1),
                Err(err) => eprintln!(
                    "[harvest] replay: run {} não fechou como orphan: {err}",
                    run.run_id
                ),
            },
        }
    }
    Ok(report)
}

#[cfg(test)]
#[path = "replay_tests.rs"]
mod tests;
