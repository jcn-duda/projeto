//! Cascata de dispatch/enfileiramento do Chupim, pós-checagem de cache.
//!
//! Espelha a metade PURA de `autoFetchBrDubbed` (`autofetch-runner.ts:174`) mais
//! os portões de `enqueueAutofetch` (`runner.ts:52`) — sem rede, sem relógio e
//! sem escrita. O executor mede os fatos, chama [`cascade`] e aplica a ordem
//! devolvida: `attempts` vão para o enqueue (hold ANTES, marker só no aceite),
//! `deferred` voltam para a fila persistente (nunca se perdem) e `dropped`
//! viram `noteSkip`/rollback.
//!
//! # Ordem que importa (não reordenar)
//!
//! 1. Hash vazio, morto (`dead:`) e `adrm` (apagado DE PROPÓSITO da conta) saem
//!    **antes** dos pools. Sem isso o Chupim para no mesmo hash a cada busca: o
//!    `enqueue` o recusa e ele nunca chega ao próximo viável (medido em
//!    2026-10-24, Lanterns S01E08).
//! 2. Dedupe por hash, primeira ocorrência vence (a lista vem do índice, que
//!    pode repetir o mesmo release em dois indexers).
//! 3. `known == false` não escolhe nada: sem saber o que está em cache não há
//!    como saber o que falta.
//! 4. Pools em cascata `br > any > seeds`. O pool BR que TEM candidatos não cai
//!    para o `any`: coberto o alvo, não há o que baixar.
//! 5. Cobertura POR qualidade-alvo (720/1080/4K): um 720 Dual ⚡ não mata o
//!    1080. Fora das faixas-alvo (unknown/SD), qualquer BR dublado em cache para
//!    o pool inteiro.
//! 6. `seeds`: sonda pendente (transitória, NÃO purga) → bloqueio de seleção →
//!    stop gate por cache → exceção do título raro.
//!
//! # Divergência deliberada de forma
//!
//! O TS devolve `0`/`1` por candidato e o candidato barrado pelo teto da obra
//! continua na fila persistente (que a seleção já gravou). Aqui ele sai em
//! `deferred` com o motivo, para o executor regravá-lo — a informação que o
//! número não carrega. O teto por obra reusa `overflow_upgrade_allowed` do
//! núcleo: a reserva concedida entra na visão combinada e a segunda já não
//! passa, exatamente como o `pending` do `reserveObra`.
//!
//! Tipos e rótulos: [`types`] (`cascade_types.rs`), pela catraca de linhas.

#[path = "cascade_types.rs"]
mod types;

pub use types::{
    CascadeAttempt, CascadeCandidate, CascadeDecision, CascadeDefer, CascadeDeferred, CascadeDrop,
    CascadeDropped, CascadeFacts, CascadePool, ObraCapFacts, SeedsBlock, SeedsPurge, SeedsTrace,
};

use adom_core::{
    is_autofetch_target_quality, overflow_upgrade_allowed, ObraEntry, SeedsSelectionBlockReason,
    SeedsStopReason,
};

fn attempt_of(candidate: &CascadeCandidate, overflow: bool) -> CascadeAttempt {
    CascadeAttempt {
        info_hash: candidate.info_hash.clone(),
        pool: candidate.pool,
        quality: candidate.quality.clone(),
        slot_limit: candidate.slot_limit,
        rare: candidate.rare,
        overflow,
    }
}

fn drop_of(candidate: &CascadeCandidate, reason: CascadeDrop) -> CascadeDropped {
    CascadeDropped {
        info_hash: candidate.info_hash.clone(),
        pool: candidate.pool,
        reason,
    }
}

/// A cascata inteira: exclusões → dedupe → cache → pools → teto/obra/vaga.
pub fn cascade(facts: &CascadeFacts, candidates: Vec<CascadeCandidate>) -> CascadeDecision {
    let mut decision = CascadeDecision::empty(None);
    if !facts.enabled {
        decision.dropped = candidates
            .iter()
            .map(|c| drop_of(c, CascadeDrop::Disabled))
            .collect();
        return decision;
    }

    // 1–2. Exclusão ANTES dos pools, na ordem de entrada, com dedupe por hash.
    let mut seen: Vec<String> = Vec::new();
    let mut live: Vec<CascadeCandidate> = Vec::new();
    for candidate in candidates {
        let hash = candidate.info_hash.to_lowercase();
        let reason = if hash.is_empty() {
            Some(CascadeDrop::EmptyHash)
        } else if candidate.dead {
            Some(CascadeDrop::Dead)
        } else if candidate.adrm {
            Some(CascadeDrop::Adrm)
        } else if !candidate.viable {
            Some(CascadeDrop::SeedFloorWaived)
        } else if seen.contains(&hash) {
            Some(CascadeDrop::Duplicate)
        } else {
            None
        };
        match reason {
            Some(reason) => decision.dropped.push(drop_of(&candidate, reason)),
            None => {
                seen.push(hash);
                live.push(candidate);
            }
        }
    }
    if live.is_empty() {
        return decision;
    }

    // 3. Kill-switch e cache desconhecido valem para a busca inteira.
    if facts.paused {
        decision.deferred = live
            .iter()
            .map(|c| CascadeDeferred {
                candidate: attempt_of(c, false),
                reason: CascadeDefer::Paused,
            })
            .collect();
        return decision;
    }
    if !facts.cache_known {
        decision
            .dropped
            .extend(live.iter().map(|c| drop_of(c, CascadeDrop::UnknownCache)));
        return decision;
    }

    // 4. Pools em cascata, preservando a ordem de entrada dentro de cada um.
    let mut br: Vec<CascadeCandidate> = Vec::new();
    let mut any: Vec<CascadeCandidate> = Vec::new();
    let mut seeds: Vec<CascadeCandidate> = Vec::new();
    for candidate in live {
        match candidate.pool {
            CascadePool::Br => br.push(candidate),
            CascadePool::Any => any.push(candidate),
            CascadePool::Seeds => seeds.push(candidate),
        }
    }

    let mut chosen: Vec<CascadeCandidate> = Vec::new();
    // Pools inferiores ao escolhido: não são tentados agora, mas NÃO se perdem —
    // voltam para a fila como adiados, igual ao backup que o TS deixa gravado.
    let mut lower: Vec<CascadeCandidate> = Vec::new();
    if !br.is_empty() {
        decision.pool = Some(CascadePool::Br);
        let covered = &facts.covered_qualities;
        for candidate in br {
            let quality = candidate.quality.clone().unwrap_or_default();
            let covers_target = if is_autofetch_target_quality(&quality) {
                covered.iter().any(|q| q == &quality)
            } else {
                facts.has_cached_br_dubbed
            };
            if covers_target {
                decision
                    .dropped
                    .push(drop_of(&candidate, CascadeDrop::AlreadyCached));
            } else {
                chosen.push(candidate);
            }
        }
        lower.extend(any);
        lower.extend(seeds);
    } else if !any.is_empty() {
        decision.pool = Some(CascadePool::Any);
        if facts.has_cached_br_dubbed || facts.has_cached_any_dubbed {
            decision
                .dropped
                .extend(any.iter().map(|c| drop_of(c, CascadeDrop::StopHasBr)));
        } else {
            chosen = any;
        }
        lower.extend(seeds);
    } else if !seeds.is_empty() {
        decision.pool = Some(CascadePool::Seeds);
        resolve_seeds(facts, seeds, &mut decision, &mut chosen);
    }

    // 5. Ordem de disparo: vaga, teto por obra (com overflow), conta e orçamento.
    let pool_index = decision.pool.map(CascadePool::index);
    let mut slots = facts.slots.max(0);
    let mut obra_current = pool_index.map_or(0, |i| facts.obra.current[i]);
    // Teto não medido/desligado (`cap <= 0`) não barra nada: só um teto real
    // fecha a janela. Sem isso a decisão sem fatos de obra pararia tudo.
    let obra_cap = pool_index.map_or(0, |i| facts.obra.caps[i]);
    let mut entries = facts.obra.entries.clone();

    for candidate in chosen {
        let mut entry = attempt_of(&candidate, false);
        let defer = if facts.account_blocked {
            Some(CascadeDefer::AccountGate)
        } else if slots <= 0 {
            Some(CascadeDefer::SearchSlotBusy)
        } else if obra_cap > 0 && obra_current >= obra_cap {
            // Só o cap EXATO abre a reserva extra (cap+1); acima disso a janela
            // já consumiu o overflow. A reserva concedida entra na visão
            // combinada, então a segunda tentativa não passa.
            let quality = candidate.quality.clone().unwrap_or_default();
            let pool = candidate.pool.as_str();
            if obra_current == obra_cap && overflow_upgrade_allowed(&entries, pool, &quality) {
                entry.overflow = true;
                entries.push(ObraEntry {
                    pool: pool.to_string(),
                    quality,
                    overflow: true,
                });
                None
            } else {
                Some(CascadeDefer::ObraCap)
            }
        } else if facts.budget_blocked {
            Some(CascadeDefer::BudgetBackoff)
        } else {
            None
        };
        match defer {
            Some(reason) => decision.deferred.push(CascadeDeferred {
                candidate: entry,
                reason,
            }),
            None => {
                if !entry.overflow {
                    slots -= 1;
                    obra_current += 1;
                    entries.push(ObraEntry {
                        pool: candidate.pool.as_str().to_string(),
                        quality: candidate.quality.clone().unwrap_or_default(),
                        overflow: false,
                    });
                }
                decision.attempts.push(entry);
            }
        }
    }

    for candidate in lower {
        decision.deferred.push(CascadeDeferred {
            candidate: attempt_of(&candidate, false),
            reason: CascadeDefer::LowerPool,
        });
    }
    decision
}

/// Pool `seeds`: sonda → bloqueio de seleção → stop gate → exceção do raro.
fn resolve_seeds(
    facts: &CascadeFacts,
    seeds: Vec<CascadeCandidate>,
    decision: &mut CascadeDecision,
    chosen: &mut Vec<CascadeCandidate>,
) {
    // Sonda pendente é TRANSITÓRIA: defere o despacho sem purgar a fila — ela
    // volta a drenar quando o lease terminar.
    if facts.probe_pending {
        decision.seeds = SeedsTrace::Blocked(SeedsBlock::BrProbePending);
        decision.dropped.extend(
            seeds
                .iter()
                .map(|c| drop_of(c, CascadeDrop::BrProbePending)),
        );
        return;
    }
    if let Some(reason) = facts.seeds_block {
        let (block, drop) = match reason {
            SeedsSelectionBlockReason::DubbedOnly => {
                (SeedsBlock::DubbedOnly, CascadeDrop::DubbedOnly)
            }
            SeedsSelectionBlockReason::SeedsPlayable => {
                (SeedsBlock::SeedsPlayable, CascadeDrop::SeedsPlayable)
            }
            SeedsSelectionBlockReason::BrProbePending => {
                (SeedsBlock::BrProbePending, CascadeDrop::BrProbePending)
            }
        };
        decision.seeds = SeedsTrace::Blocked(block);
        decision.purge = if matches!(block, SeedsBlock::BrProbePending) {
            SeedsPurge::None
        } else {
            SeedsPurge::All
        };
        decision
            .dropped
            .extend(seeds.iter().map(|c| drop_of(c, drop)));
        return;
    }
    if let Some(stop) = facts.seeds_stop {
        let (block, drop) = match stop {
            SeedsStopReason::StopHasBr => (SeedsBlock::StopHasBr, CascadeDrop::StopHasBr),
            SeedsStopReason::StopHasCached => {
                (SeedsBlock::StopHasCached, CascadeDrop::StopHasCached)
            }
        };
        decision.seeds = SeedsTrace::Blocked(block);
        decision.purge = SeedsPurge::All;
        decision
            .dropped
            .extend(seeds.iter().map(|c| drop_of(c, drop)));
        return;
    }
    decision.seeds = SeedsTrace::Allowed;
    if facts.rare_over_cached {
        // Título raro mantém o aquecimento apesar de cache global não-dublado:
        // o que já toca sai da frente (e da fila), o resto continua.
        decision.purge = SeedsPurge::CachedOnly;
        for candidate in seeds {
            if candidate.cached {
                decision
                    .dropped
                    .push(drop_of(&candidate, CascadeDrop::AlreadyCached));
            } else {
                chosen.push(candidate);
            }
        }
        return;
    }
    chosen.extend(seeds);
}

#[cfg(test)]
#[path = "cascade_tests.rs"]
mod tests;
