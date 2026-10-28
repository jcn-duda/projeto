//! Seleção pura de fallbacks removíveis após ready BR comprovado.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictCandidate {
    pub hash: String,
    pub pool: String,
    pub overflow: bool,
    pub marker_matches_work: bool,
    pub owned: bool,
    pub held: bool,
    pub protected: bool,
    pub accepted_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvictInput {
    pub current_ready_is_br: bool,
    pub work_has_prior_br_ready: bool,
    pub now: i64,
    pub min_age_ms: i64,
    pub candidates: Vec<EvictCandidate>,
}

/// Conserva a ordem do registro da obra; overflow nunca é removível.
pub fn eligible_evictions(input: &EvictInput) -> Vec<String> {
    if !input.current_ready_is_br && !input.work_has_prior_br_ready {
        return Vec::new();
    }
    let min_age = input.min_age_ms.max(0);
    let mut seen = std::collections::HashSet::new();
    input
        .candidates
        .iter()
        .filter_map(|entry| {
            let hash = entry.hash.to_lowercase();
            let age = input.now.saturating_sub(entry.accepted_at);
            let eligible = !hash.is_empty()
                && seen.insert(hash.clone())
                && matches!(entry.pool.as_str(), "any" | "seeds")
                && !entry.overflow
                && entry.marker_matches_work
                && entry.owned
                && !entry.held
                && !entry.protected
                && entry.accepted_at > 0
                && age >= min_age;
            eligible.then_some(hash)
        })
        .collect()
}

#[cfg(test)]
#[path = "evict_tests.rs"]
mod tests;
