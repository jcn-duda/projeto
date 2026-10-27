//! Seleção do dreno sem rede e sem escrita: o trabalhador injeta as provas
//! de obsolescência, os bloqueios transitórios e a reserva da obra.

use super::QueueCandidate;

#[derive(Debug)]
pub struct DrainSelection<L> {
    pub next: Option<QueueCandidate>,
    pub remaining: Vec<QueueCandidate>,
    pub lease: Option<L>,
    /// Candidatos que permaneceram na fila porque a obra atingiu o teto.
    pub cap_deferred: usize,
}

/// Mesmo laço de `takeDrainCandidate`: obsoletos saem; hold/sonda esperam;
/// cap fechado adia o candidato na frente e procura o próximo. O `skip` roda
/// também sobre elementos posteriores ao escolhido, como `takeNext` no Node.
/// Não persiste a fila; o dono precisa reservar e gravar com um único escritor.
pub fn select_drain_candidate<L, E>(
    mut queue: Vec<QueueCandidate>,
    mut skip: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    mut defer: impl FnMut(&QueueCandidate) -> Result<bool, E>,
    mut reserve: impl FnMut(&QueueCandidate) -> Result<Option<L>, E>,
) -> Result<DrainSelection<L>, E> {
    let mut cap_deferred = Vec::new();
    let (next, mut remaining, lease) = loop {
        let mut first = None;
        let mut kept = Vec::new();
        for candidate in queue {
            if skip(&candidate)? {
                continue;
            }
            if first.is_none() && !defer(&candidate)? {
                first = Some(candidate);
            } else {
                kept.push(candidate);
            }
        }
        let Some(candidate) = first else {
            break (None, kept, None);
        };
        if let Some(lease) = reserve(&candidate)? {
            break (Some(candidate), kept, Some(lease));
        }
        cap_deferred.push(candidate);
        queue = kept;
    };
    let deferred_count = cap_deferred.len();
    cap_deferred.append(&mut remaining);
    Ok(DrainSelection {
        next,
        remaining: cap_deferred,
        lease,
        cap_deferred: deferred_count,
    })
}
