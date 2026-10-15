//! `pickBrDubbedByTargetQualities` — picking por faixa-alvo do pool BR
//! (`src/utils/autofetch-picks.ts`). Submódulo de
//! [`super`](crate::br_pool_selection), separado pela catraca de 400 linhas.

use std::collections::{HashMap, HashSet};

use super::picks::{hash_set, pick_from_pool};
use super::{
    br_dubbed_pool, is_autofetch_target_quality, PoolOptions, PoolStream,
    AUTOFETCH_TARGET_QUALITIES,
};

/// `pickBrDubbedByTargetQualities`: uncached por faixa-alvo (1080 → 720 → 4K),
/// primários primeiro e depois backups. Sem NENHUMA faixa-alvo no pool, cai no
/// pick clássico — senão o Chupim pararia de esquentar BR sem resolução.
pub fn pick_br_dubbed_by_target_qualities(
    streams: &[PoolStream],
    cached_hashes: &HashSet<String>,
    limit: i64,
    opts: &PoolOptions,
) -> Vec<usize> {
    let max = limit.max(0);
    if max == 0 {
        return Vec::new();
    }
    let pool = br_dubbed_pool(streams, opts);
    let cached = hash_set(cached_hashes);
    let has_target = pool
        .iter()
        .any(|&i| is_autofetch_target_quality(&streams[i].quality_text()));
    if !has_target {
        return pick_from_pool(streams, &pool, &cached, max);
    }

    let target_count = AUTOFETCH_TARGET_QUALITIES.len() as i64;
    let per_quality = if max <= target_count {
        1
    } else {
        ((max + target_count - 1) / target_count).max(1)
    };

    let mut seen: HashSet<String> = HashSet::new();
    let mut count_q: HashMap<String, i64> = HashMap::new();
    let mut primaries: Vec<usize> = Vec::new();
    let mut alternates: Vec<usize> = Vec::new();

    // Passo A: 1º uncached por faixa — primários sempre antes dos backups.
    for &i in &pool {
        let s = &streams[i];
        if !s.has_hash() {
            continue;
        }
        let key = s.hash_key();
        if seen.contains(&key) || cached.contains(&key) {
            continue;
        }
        let q = s.quality_text();
        if !is_autofetch_target_quality(&q) || count_q.contains_key(&q) {
            continue;
        }
        count_q.insert(q, 1);
        seen.insert(key);
        primaries.push(i);
        if primaries.len() as i64 >= max {
            return primaries;
        }
    }

    if per_quality <= 1 || primaries.len() as i64 >= max {
        return primaries;
    }

    // Passo B: alternates até K por faixa / até encher o limit.
    for &i in &pool {
        if (primaries.len() + alternates.len()) as i64 >= max {
            break;
        }
        let s = &streams[i];
        if !s.has_hash() {
            continue;
        }
        let key = s.hash_key();
        if seen.contains(&key) || cached.contains(&key) {
            continue;
        }
        let q = s.quality_text();
        if !is_autofetch_target_quality(&q) {
            continue;
        }
        let n = count_q.get(&q).copied().unwrap_or(0);
        if n == 0 || n >= per_quality {
            continue;
        }
        count_q.insert(q, n + 1);
        seen.insert(key);
        alternates.push(i);
    }

    let mut out = primaries;
    out.extend(alternates);
    out.truncate(max as usize);
    out
}
