//! Desfecho da obra colhida — porte mínimo de `harvest-outcome.ts`.
//!
//! O `tick` decide QUANDO colher; aqui mora o que fazer com o resultado:
//!
//! - **falha transitória** volta ao FIM da fila até [`MAX_ATTEMPTS`] vezes;
//! - **entrada dirigida** finaliza a sonda, inclusive quando ela coalesceu
//!   em voo numa execução completa;
//! - sonda bem-sucedida com FULL pendente devolve exatamente uma FULL;
//! - sonda **truncada** pelo teto horário (alvos sobraram) finaliza como
//!   `capped`, nunca como `empty`: `empty` afirma "procurei e não há", e uma
//!   passada cortada não provou isso — `capped` tem retry curto (5 min) e o
//!   aviso do painel não congela 12 h dizendo que a obra não tem dublado;
//! - FULL bem-sucedida absorve as intenções da mesma identidade;
//! - obra que **concluiu** zera o contador de tentativas, mesmo deixando
//!   um remanescente FULL.
//!
//! Requeue usa `tail` (sem dedupe e sem débito extra). Não há teto/preempção
//! neste desfecho: o freio de atividade opera na escolha do tick.

use std::collections::HashMap;

use adom_harvest::{
    entry_identity, BrProbe, BrProbeWork, HarvestEntry, HarvestQueue, HarvestStore, PendingFull,
    PendingIntent, ProbeConfig, ProbeFinal,
};

/// Falhas transitórias aceitas antes de a obra sair da fila (mesmo teto do TS).
const MAX_ATTEMPTS: u8 = 3;

/// Desfecho de UMA obra (o que o drain provou sobre ela).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Settlement {
    /// Snapshot do slot, capturado ANTES do `finish`.
    pub intent: Option<PendingIntent>,
    pub ok: bool,
    /// Achou BR viável nesta passada (vence `ok` na finalização da sonda).
    pub br_found: bool,
    /// O teto horário cortou alvos planejados (`DrainOutcome::truncated`): a
    /// passada não provou ausência.
    pub capped: bool,
}

/// Estado do desfecho entre ciclos (contadores por obra + sonda).
pub(crate) struct Settler {
    attempts: HashMap<String, u8>,
    probe: BrProbe,
}

impl Settler {
    /// `ttl_seconds` é o `BR_PROBE_TTL_S` (`DEFAULT_PROBE_TTL_SECONDS` no crate).
    pub(crate) fn new(ttl_seconds: u64) -> Self {
        Self {
            attempts: HashMap::new(),
            probe: BrProbe::new(ProbeConfig {
                ttl_seconds,
                ..ProbeConfig::default()
            }),
        }
    }

    /// Preempção: renova o lease da sonda (o registro não finaliza — a obra
    /// volta à fila e será recolhida). Fora de sonda não grava nada: `pending`
    /// de uma obra sem sonda bloquearia seeds sem trabalho dirigido.
    pub(crate) fn note_preempted(&self, store: &HarvestStore, entry: &HarvestEntry, now_ms: i64) {
        if !entry.br_probe {
            return;
        }
        if let Err(err) = self.probe.note_preempted(store, &probe_work(entry), now_ms) {
            eprintln!(
                "[harvest] sonda não renovou o lease ({}): {err}",
                entry.imdb_id
            );
        }
    }

    /// Aplica o desfecho de UMA obra já consumida da fila.
    pub(crate) fn settle(
        &mut self,
        queue: &mut HarvestQueue,
        store: &HarvestStore,
        entry: HarvestEntry,
        outcome: Settlement,
        now_ms: i64,
    ) {
        let Settlement {
            intent,
            ok,
            br_found,
            capped,
        } = outcome;
        let is_probe = entry.br_probe || intent.as_ref().is_some_and(|intent| intent.br_probe);
        if is_probe {
            // Ordem do estado final: achado real > corte do teto > ausência
            // provada > falha. `Found` vence sempre (o achado é prova); `capped`
            // vence `empty` porque cortou alvos sem responder; e vence `failed`
            // porque a falha de fonte continua visível no `last`/contadores do
            // status — o que o registro da sonda precisa dizer é que o PLANO
            // ficou incompleto.
            let state = if br_found {
                ProbeFinal::Found
            } else if capped {
                ProbeFinal::Capped
            } else if ok {
                ProbeFinal::Empty
            } else {
                ProbeFinal::Failed
            };
            if let Err(err) = self
                .probe
                .finalize(store, &probe_work(&entry), state, now_ms)
            {
                eprintln!("[harvest] sonda não finalizou ({}): {err}", entry.imdb_id);
            }
        }

        let identity = entry_identity(&entry);
        if ok {
            self.attempts.remove(&identity);
            if entry.br_probe {
                if let Some(full) = remaining_full(&entry, intent.as_ref()) {
                    queue.tail(as_full_remainder(&entry, full));
                }
            }
            return;
        }
        let tries = self.attempts.entry(identity.clone()).or_insert(0);
        *tries = tries.saturating_add(1);
        if *tries <= MAX_ATTEMPTS {
            queue.tail(retry_entry(&entry, intent.as_ref()));
        } else {
            self.attempts.remove(&identity);
            eprintln!("[harvest] {identity}: 4 falhas seguidas; obra sai da fila");
        }
    }
}

fn remaining_full(entry: &HarvestEntry, intent: Option<&PendingIntent>) -> Option<PendingFull> {
    intent
        .and_then(|intent| intent.full.clone())
        .or_else(|| entry.pending_full())
}

fn retry_entry(entry: &HarvestEntry, intent: Option<&PendingIntent>) -> HarvestEntry {
    if entry.br_probe {
        if let Some(full) = remaining_full(entry, intent) {
            return as_full_remainder(entry, full);
        }
        return entry.clone();
    }
    let reason = intent
        .map(|intent| intent.reason.clone())
        .unwrap_or_else(|| entry.reason.clone());
    let priority_at = if reason == "br-gap" {
        intent
            .and_then(|intent| intent.priority_at)
            .or(entry.priority_at)
    } else {
        None
    };
    HarvestEntry {
        imdb_id: entry.imdb_id.clone(),
        media_type: entry.media_type,
        season: entry.season,
        episode: entry.episode,
        reason,
        enqueued_at: entry.enqueued_at,
        priority_at,
        resumed: entry.resumed,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

fn as_full_remainder(entry: &HarvestEntry, full: PendingFull) -> HarvestEntry {
    let reason = full.reason;
    let priority_at = if reason == "br-gap" {
        full.priority_at.or(entry.priority_at)
    } else {
        None
    };
    HarvestEntry {
        imdb_id: entry.imdb_id.clone(),
        media_type: entry.media_type,
        season: entry.season,
        episode: entry.episode,
        reason,
        enqueued_at: entry.enqueued_at,
        priority_at,
        resumed: entry.resumed,
        br_probe: false,
        full_base: false,
        full_intent: None,
    }
}

fn probe_work(entry: &HarvestEntry) -> BrProbeWork {
    BrProbeWork {
        media_type: entry.media_type,
        imdb_id: entry.imdb_id.clone(),
        season: entry.season,
        episode: entry.episode,
    }
}

#[cfg(test)]
#[path = "settle_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "settle_intent_tests.rs"]
mod intent_tests;
