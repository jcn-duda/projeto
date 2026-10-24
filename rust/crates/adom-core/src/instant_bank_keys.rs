//! Chaves e limites da seleção instantânea: normalização do id de indexer e os
//! tetos por indexer/global (piso e clamp do TS).

use super::{INSTANT_GLOBAL_MAX, INSTANT_PER_INDEXER_MAX};

pub(super) fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

pub(super) fn limit_per_indexer(raw: i64) -> i64 {
    let value = if raw == 0 {
        INSTANT_PER_INDEXER_MAX
    } else {
        raw
    };
    value.clamp(1, INSTANT_PER_INDEXER_MAX)
}

pub(super) fn limit_global(raw: i64) -> i64 {
    let value = if raw == 0 { INSTANT_GLOBAL_MAX } else { raw };
    value.clamp(1, 500)
}
