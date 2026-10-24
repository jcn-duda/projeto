//! Desfecho da obra colhida — porte mínimo de `harvest-outcome.ts`.
//!
//! O `tick` decide QUANDO colher; aqui mora o que fazer com o resultado:
//!
//! - **falha transitória** volta ao FIM da fila até [`MAX_ATTEMPTS`] vezes. Sem
//!   isso a obra desaparece com o `seen` de 12 h já gravado no aceite e a
//!   próxima busca só recebe `dedupe`;
//! - **entrada dirigida** finaliza a sonda (`found`/`empty`/`failed`), senão o
//!   `pending` fica até o lease vencer e o pool de seeds segue bloqueado. Vale
//!   também quando a sonda coalesceu em voo numa execução completa — o desfecho
//!   recebe `is_probe`, não lê só a entrada base;
//! - obra que **concluiu** zera o contador de tentativas.
//!
//! Não há teto/preempção neste desfecho: o `DrainOutcome` do gateway carrega só
//! `{ok, queries}` e o drain não aborta por tráfego (o freio de atividade opera
//! na escolha do tick, não no meio da obra).

use std::collections::HashMap;

use adom_harvest::{
    entry_identity, BrProbe, BrProbeWork, HarvestEntry, HarvestQueue, HarvestStore, ProbeConfig,
    ProbeFinal,
};

/// Falhas transitórias aceitas antes de a obra sair da fila (mesmo teto do TS).
const MAX_ATTEMPTS: u8 = 3;

/// Desfecho de UMA obra (o que o drain provou sobre ela).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settlement {
    /// Intenção EFETIVA do slot (`entry.br_probe` **ou** sonda coalescida em voo).
    pub is_probe: bool,
    pub ok: bool,
    /// Achou BR viável nesta passada (vence `ok` na finalização da sonda).
    pub br_found: bool,
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
            is_probe,
            ok,
            br_found,
        } = outcome;
        if is_probe {
            let state = if br_found {
                ProbeFinal::Found
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
            return;
        }
        let tries = self.attempts.entry(identity.clone()).or_insert(0);
        *tries = tries.saturating_add(1);
        if *tries <= MAX_ATTEMPTS {
            queue.tail(entry);
        } else {
            self.attempts.remove(&identity);
            eprintln!("[harvest] {identity}: {MAX_ATTEMPTS} falhas seguidas; obra sai da fila");
        }
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
