//! Núcleo Rust do Adom — migração TS→Rust.
//!
//! 25+ módulos portados com golden em `rust/golden/` (~4.000+ casos).
//! A integração com o Node é via `adom-napi` (bindings NAPI-RS).

mod br_origin;
mod cache_keys;
mod cache_quotas;
mod catalog_year;
pub mod config_encoding;
mod dk_seal;
mod episode_matching;
mod episode_parse;
mod episode_series_matching;
mod franchise;
mod info_hash;
mod js_text;
mod latin_table;
mod magnet_uri;
mod matches_br_title;
mod matching_decisions;
mod matching_tokens;
mod matching_vocabulary;
mod multiwork_pack;
mod release_name_matching;
mod release_title_rules;
mod release_work;
mod resolve_sign;
mod short_name_tail;
mod stream_quotas;
pub mod stream_quotas_extra;
mod title_normalization;

// ── info_hash / magnet ────────────────────────────────────────────────
pub use info_hash::extract_info_hash;
pub use magnet_uri::{default_magnet, sanitize_magnet};

// ── br_origin ─────────────────────────────────────────────────────────
pub use br_origin::{br_origin_mark, has_pt_signs};

// ── catalog_year ──────────────────────────────────────────────────────
pub use catalog_year::{catalog_alt_year_of, catalog_year_of};

// ── cache ─────────────────────────────────────────────────────────────
pub use cache_keys::{cache_key, prefix, LEGACY_PREFIXES};
pub use cache_quotas::{
    MAX_ENTRIES,
    headroom, namespace_for, quota_for, universe_total, validate_quotas,
};

// ── config encoding / dk seal ─────────────────────────────────────────
pub use config_encoding::{decode_config, encode_config, parse_segment, seal_segment};
pub use dk_seal::{derive_dk_key, is_sealed, seal_dk, unseal_dk};

// ── episode ───────────────────────────────────────────────────────────
pub use episode_matching::{
    is_season_pack_fill_eligible, is_season_pack_release, matches_episode,
};
pub use episode_parse::{
    parse_title_season_episode, season_coverage_excludes, ParsedSeasonEpisode,
};
pub use episode_series_matching::{matches_episode_work_identity, matches_global_series_no_marker};

// ── franchise ─────────────────────────────────────────────────────────
pub use franchise::{
    franchise_base_contradicts, franchise_extension_contradicts, is_multi_work_collection,
    name_coverage_tokens,
};

// ── multiwork_pack ────────────────────────────────────────────────────
pub use multiwork_pack::{
    admits_multi_work_pack, collection_root, collection_root_tokens, covers_year, pack_year_source,
};

// ── matching ──────────────────────────────────────────────────────────
pub use matches_br_title::matches_br_title;
pub use release_name_matching::{
    contains_token_run, ends_with_sequence_marker, franchise_root, franchise_roots, matches_name,
};
pub use release_title_rules::{
    matches_short_name_identity, matches_title_structure, short_name_identity, ShortNameIdentity,
};
pub use release_work::{
    choose_episode_parse, episode_parse_specificity, release_fits_request, release_work_targets,
    route_work_location, WorkTarget,
};
pub use short_name_tail::short_name_tail_contradicts;

// ── matching_decisions ────────────────────────────────────────────────
pub use matching_decisions::{
    adaptation_identity_contradicts, first_significant_token, live_action_year_contradicts,
    named_sequel_contradicts, title_precision, year_contradicts,
};

// ── matching_tokens ───────────────────────────────────────────────────
pub use matching_tokens::{
    episode_work_tokens, extract_sequence_markers, first_unmarked_token, first_work_token,
    is_non_latin_token, is_non_naming_token, Marker,
};

// ── matching_vocabulary ───────────────────────────────────────────────
pub use matching_vocabulary::{
    episode_token_test, title_tokens, vocabulary_contents, year_range_test,
};

// ── stream_quotas ─────────────────────────────────────────────────────
pub use stream_quotas::limit_by_indexer;
pub use stream_quotas_extra::{
    limit_by_quality, limit_by_quality_and_indexer, limit_reserving_br, quality_from_title,
    select_quality_candidates, stream_quality, QUALITY_KEYS, UNKNOWN_QUALITY,
};

// ── resolve_sign (HMAC) ──────────────────────────────────────────────
pub use resolve_sign::{sign_resolve, verify_resolve};

// ── title_normalization ──────────────────────────────────────────────
pub use title_normalization::normalize_title;

/// Único formato de manifest aceito pelo consumidor do golden.
///
/// Contrato on-disk compartilhado com o gerador `scripts/golden` e com o
/// checker Node; aqui é só a constante do formato, sem comportamento.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";
