//! Núcleo Rust do Adom — migração TS→Rust.
//!
//! 25+ módulos portados com golden em `rust/golden/` (~4.000+ casos).
//! A integração com o Node é via `adom-napi` (bindings NAPI-RS).

mod audio_cleanup_verdicts;
mod audio_lang;
mod audio_presentation;
mod br_origin;
mod br_pool_selection;
mod bytes_to_size;
mod cache_keys;
mod cache_quotas;
mod catalog_classify;
mod catalog_year;
mod collapse_acronyms;
pub mod config_encoding;
mod crawl_store_rules;
mod crawl_url_key;
mod debrid;
mod decode_entities;
mod dedupe_names;
mod dk_seal;
mod episode_matching;
mod episode_parse;
mod episode_series_matching;
mod franchise;
mod indexer_priority;
mod info_hash;
mod inventory_filter;
mod js_text;
mod js_text16;
mod latin_table;
mod magnet_display_name;
mod magnet_uri;
mod matches_br_title;
mod matching_decisions;
mod matching_tokens;
mod matching_vocabulary;
mod metric_id;
mod multiwork_pack;
mod net_safety;
mod non_feature_release;
mod pt_audio_guards;
mod release_filters;
mod release_guards;
mod release_index_media;
mod release_labels;
mod release_name_matching;
mod release_title_rules;
mod release_work;
mod reply_budget;
mod request_key;
mod resolve_sign;
mod search_name_helpers;
mod short_name_tail;
mod stream_display;
mod stream_quotas;
mod stream_quotas_candidate;
pub mod stream_quotas_extra;
mod stream_relabel;
mod stream_trace;
mod strip_diacritics;
mod title_normalization;
mod tmdb_br_aliases;
mod video_header;

// ── info_hash / magnet ────────────────────────────────────────────────
pub use info_hash::extract_info_hash;
pub use magnet_uri::{default_magnet, sanitize_magnet};

// ── br_origin ─────────────────────────────────────────────────────────
pub use br_origin::{br_origin_mark, has_pt_signs};
pub use br_pool_selection::{
    any_dubbed_pool, br_dubbed_pool, fallback_blocked, is_autofetch_target_quality,
    pick_br_dubbed_by_target_qualities, top_seeded_pool, PoolOptions, PoolStream,
};

// ── catalog_year ──────────────────────────────────────────────────────
pub use catalog_year::{catalog_alt_year_of, catalog_year_of};

// ── cache ─────────────────────────────────────────────────────────────
pub use cache_keys::{
    cache_key, is_versioned, mag_meta_counts_key, namespace_version, prefix, LEGACY_PREFIXES,
};
pub use cache_quotas::{
    headroom, namespace_for, quota_for, universe_len, universe_total, validate_quotas, MAX_ENTRIES,
};

// ── config encoding / dk seal ─────────────────────────────────────────
pub use config_encoding::{decode_config, encode_config, parse_segment, seal_segment};
pub use dk_seal::{derive_dk_key, is_sealed, seal_dk, unseal_dk};

// ── debrid file select ────────────────────────────────────────────────
pub use debrid::{
    base_name, is_site_ad, looks_multi_work_files, pick_code_label, pick_file, pick_work_file,
    work_coverage, DebridFile, EpisodeContext, EpisodeEvidence, PickCode, PickOutcome, PlayHint,
    WorkHint,
};

// ── episode ───────────────────────────────────────────────────────────
pub use episode_matching::{is_season_pack_fill_eligible, is_season_pack_release, matches_episode};
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

// ── indexer_priority ──────────────────────────────────────────────────
pub use indexer_priority::{compare_indexer_priority, priority_map};

// ── inventory_filter ──────────────────────────────────────────────────
pub use inventory_filter::filter_inventory_relevant;

// ── release_index_media ───────────────────────────────────────────────
pub use release_index_media::{
    bank_rows_for_media_source, merge_media_source, BankRow, MagnetLike,
};

// ── stream_quotas_candidate ───────────────────────────────────────────
pub use stream_quotas_candidate::{
    candidate_stream_quality, select_candidate_streams, CandidateStream,
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
pub use audio_cleanup_verdicts::{
    dn_contradicts_dub_claim, dubbed_lie_verdict, en_scene_mirror_title, has_pt_audio_mark,
    strong_en_scene_mark, DubbedLieVerdict,
};
pub use audio_lang::{
    foreign_lang_named_for_bucket, generic_dub_proves_pt, names_foreign_dub_language,
};
pub use audio_presentation::{audio_from_title, looks_pt_br, strip_quality_tag_blob};
pub use bytes_to_size::bytes_to_size;
pub use catalog_classify::{classify_by_title, classify_with_evidence, foreign_proof_label, Proof};
pub use collapse_acronyms::collapse_acronyms;
pub use crawl_store_rules::{
    apply_result, decide_upsert, empty_counters, error_backoff_ms, parse_progress, parse_status,
    parse_url_row, progress_advanced, render_progress, render_url, with_dry_flag, CRAWL_GIVE_UP_MS,
    DEFAULT_RETRY_BASE_MS, ERROR_BACKOFF_CAP_MS, URL_COLUMNS,
};
pub use crawl_url_key::crawl_url_key;
pub use decode_entities::decode_entities;
pub use dedupe_names::dedupe_names;
pub use js_text16::JsText;
pub use magnet_display_name::magnet_display_name;
pub use metric_id::{indexer_fallback_metric_key, safe_metric_id};
pub use net_safety::is_safe_download_url;
pub use non_feature_release::{is_home_source, is_non_feature, pre_home_release_contradicts};
pub use pt_audio_guards::{explicit_pt_audio, has_explicit_foreign_audio};
pub use release_filters::{
    filter_relevant_raw, filter_relevant_raw_for_year, RelevanceItem, RelevanceOutcome,
    RelevanceQuery, RelevanceRejectReason, RelevanceSettings,
};
pub use release_guards::{
    magnet_season_contradicts, magnet_year_contradicts, text_years_contradict,
};
pub use release_labels::{compact_audio, edition_from_title, source_from_title};
pub use reply_budget::remaining_check_budget;
pub use request_key::{account_scope, streams_cache_key, streams_cache_scope};
pub use search_name_helpers::{
    build_search_query, mark_debrid_name, matches_quality_filter, numeral_search_variant,
    parse_stremio_id, resolve_original_step_name, resolve_search_names,
};
pub use stream_display::{
    compact_tracker, stream_display_name, StreamDisplayConfig, StreamDisplayOptions,
    StreamNameStyle, UserDisplayOptions,
};
pub use stream_relabel::{relabel, RelabelOptions, RelabelStream};
pub use stream_trace::{
    clone_stream_trace, create_stream_trace, drop_trace, finalize_trace, sanitize_chupim_note,
    sanitize_trace_label, serialize_trace, set_trace_chupim, set_trace_stage, stage_trace,
    TraceValue, STREAM_TRACE_CHUPIM_MAX, STREAM_TRACE_LABEL_MAX, STREAM_TRACE_MAX_ACCOUNT_ITEMS,
    STREAM_TRACE_MAX_ITEMS,
};
pub use strip_diacritics::strip_diacritics;
pub use title_normalization::normalize_title;
pub use tmdb_br_aliases::{filter_br_aliases, MAX_BR_ALIASES};
pub use video_header::{
    is_mp4, parse_mp4_tail, parse_video_resolution, quality_from_resolution, VideoResolution,
};

/// Único formato de manifest aceito pelo consumidor do golden.
///
/// Contrato on-disk compartilhado com o gerador `scripts/golden` e com o
/// checker Node; aqui é só a constante do formato, sem comportamento.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";
