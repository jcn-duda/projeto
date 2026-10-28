//! Decisão pura do stop gate, da purga e da reposição seeds.
//!
//! Espelha `purgeSeedsQueue` e `applySeedsStopGate` de
//! `autofetch-seeds-pool.ts` sem I/O: a fila entra como fatia medida e sai como
//! plano (`keep`/`removed`), para o executor regravar e soltar os holds. A
//! escolha de QUEM entra na fila (`pickSeedsPool`) mora no núcleo.

use adom_core::{decide_seeds_stop, DecideSeedsStopInput, DecideSeedsStopOutput, SeedsStopReason};

pub fn seeds_stop(input: &DecideSeedsStopInput) -> DecideSeedsStopOutput {
    decide_seeds_stop(input)
}

/// O pool cujo nome a fila usa (`toQueueCandidate` grava `pool: 'seeds'`).
pub const SEEDS_POOL: &str = "seeds";

/// Entrada mínima da fila persistente que a purga lê.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedsQueueEntry {
    pub info_hash: String,
    pub pool: String,
}

/// Plano de purga: `keep` é a fila que o executor regrava, `removed` é o que sai.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeedsPurgePlan {
    pub keep: Vec<SeedsQueueEntry>,
    pub removed: Vec<SeedsQueueEntry>,
}

impl SeedsPurgePlan {
    pub fn removed_count(&self) -> usize {
        self.removed.len()
    }

    /// Nada saiu: o executor nem toca na fila.
    pub fn is_empty(&self) -> bool {
        self.removed.is_empty()
    }

    /// Hashes que saíram: o executor solta o hold de cada um.
    pub fn released_hashes(&self) -> Vec<String> {
        self.removed
            .iter()
            .map(|item| item.info_hash.clone())
            .collect()
    }

    /// Seeds que sobreviveram na fila — o complemento relaxado da próxima
    /// passagem. `br`/`any` não contam: nunca foram fila de aquecimento.
    pub fn complement_hashes(&self) -> Vec<String> {
        self.keep
            .iter()
            .filter(|item| item.pool == SEEDS_POOL)
            .map(|item| item.info_hash.clone())
            .collect()
    }
}

fn in_cache(hash: &str, cached: &[String]) -> bool {
    cached.iter().any(|item| item.eq_ignore_ascii_case(hash))
}

/// `purgeSeedsQueue(searchKey, { cached })` sem I/O.
///
/// `cached == None` reproduz o `null` do TS: TODA entrada `seeds` sai (o pool
/// foi bloqueado, não faz sentido guardar candidato). Com o conjunto em mãos,
/// só saem as seeds já em cache. Entradas `br`/`any` nunca saem — purgar o
/// dublado por causa de uma decisão sobre sementes seria perder a busca.
/// Entrada `seeds` sem evidência de cache no conjunto (`None` do TS) fica: o
/// falso negativo de cache custa um download, e a purga não é o lugar de
/// apostar contra ele.
pub fn purge_seeds(entries: &[SeedsQueueEntry], cached: Option<&[String]>) -> SeedsPurgePlan {
    let mut plan = SeedsPurgePlan::default();
    for entry in entries {
        let drop_it = entry.pool == SEEDS_POOL
            && match cached {
                None => true,
                Some(cached) => in_cache(&entry.info_hash, cached),
            };
        if drop_it {
            plan.removed.push(entry.clone());
        } else {
            plan.keep.push(entry.clone());
        }
    }
    plan
}

/// Resultado do gate de seeds, já com os efeitos separados.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeedsGateOutcome {
    /// Aquecimento segue normalmente.
    Allow,
    /// Stop gate: nada passa e a fila de seeds é purgada inteira.
    Stop(SeedsStopReason),
    /// Título raro sobre cache global não-dublado: só o que NÃO está em cache
    /// continua (o aquecimento é a razão de existir desse regime).
    RareOverCached,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedsGatePlan {
    pub outcome: SeedsGateOutcome,
    pub purge: SeedsPurgePlan,
    /// Hashes da fatia imediata que seguem para o enqueue.
    pub immediate: Vec<String>,
    /// Holds a soltar: candidatos que saíram da fatia imediata.
    pub released: Vec<String>,
}

/// `applySeedsStopGate` sem I/O.
///
/// A decisão é da policy ([`seeds_stop`]); aqui ficam os efeitos que ela não
/// pode ter: purgar a fila e filtrar a fatia imediata liberando os holds. A
/// purga roda em TODA entrada no regime raro, não só quando há imediato
/// cacheado — a fila foi escrita antes da checagem saber o que está em cache.
pub fn seeds_stop_gate(
    input: &DecideSeedsStopInput,
    entries: &[SeedsQueueEntry],
    immediate: &[String],
    cached: &[String],
) -> SeedsGatePlan {
    let decision = seeds_stop(input);
    if let Some(stop) = decision.stop {
        return SeedsGatePlan {
            outcome: SeedsGateOutcome::Stop(stop),
            purge: purge_seeds(entries, None),
            immediate: Vec::new(),
            released: immediate.to_vec(),
        };
    }
    if !decision.rare_over_cached {
        return SeedsGatePlan {
            outcome: SeedsGateOutcome::Allow,
            purge: SeedsPurgePlan::default(),
            immediate: immediate.to_vec(),
            released: Vec::new(),
        };
    }
    let mut keep = Vec::new();
    let mut released = Vec::new();
    for hash in immediate {
        if in_cache(hash, cached) {
            released.push(hash.clone());
        } else {
            keep.push(hash.clone());
        }
    }
    SeedsGatePlan {
        outcome: SeedsGateOutcome::RareOverCached,
        purge: purge_seeds(entries, Some(cached)),
        immediate: keep,
        released,
    }
}

#[cfg(test)]
#[path = "seeds_tests.rs"]
mod tests;
