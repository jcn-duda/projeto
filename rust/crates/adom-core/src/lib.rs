//! Núcleo Rust do Adom — migração TS→Rust.
//!
//! 25+ módulos portados com golden em `rust/golden/` (~4.000+ casos).
//! A integração com o Node é via `adom-napi` (bindings NAPI-RS).

mod audio_cleanup_verdicts;
mod audio_lang;
mod audio_presentation;
mod autofetch_expired;
mod autofetch_fallback;
mod autofetch_gates;
mod autofetch_keys;
mod autofetch_marker;
mod autofetch_obra;
mod autofetch_obra_overflow;
mod autofetch_policy;
mod autofetch_progress;
mod autofetch_seeds_pick;
mod br_origin;
mod br_pool_selection;
mod bytes_to_size;
mod cache_keys;
mod cache_quotas;
mod catalog_classify;
mod catalog_year;
mod collapse_acronyms;
mod collection_budget;
pub mod config_encoding;
mod crawl_store_rules;
mod crawl_url_key;
mod debrid;
mod debrid_cache_verdict;
mod debrid_may_delete;
mod debrid_rd_gate;
mod debrid_rd_ledger;
mod decode_entities;
mod dedupe_names;
mod dk_seal;
mod duplicate_pack;
mod episode_annotate;
mod episode_matching;
mod episode_parse;
mod episode_parse_gate;
mod episode_parse_scan;
mod episode_series_matching;
mod episode_size;
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
mod pack_text_totals;
mod play_disposition;
mod pt_audio_guards;
mod pt_title_dual;
mod release_filters;
mod release_guards;
mod release_index_media;
mod release_labels;
mod release_name_matching;
mod release_title_facts;
mod release_title_rules;
mod release_work;
mod reply_budget;
mod request_key;
mod resolve_sign;
mod search_bank;
mod search_finish;
mod search_name_helpers;
mod search_plan;
mod search_pool_coverage;
mod series_episode_filter;
mod short_name_tail;
mod stream_display;
mod stream_quotas;
mod stream_quotas_candidate;
pub mod stream_quotas_extra;
mod stream_ranking_dedupe;
mod stream_ranking_sort;
mod stream_ranking_types;
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
pub use br_pool_selection::picks::{
    br_listable_dub_pool, cached_br_dubbed_target_qualities, can_auto_fetch_br, filter_known_cache,
    has_cached_any_dubbed, has_cached_br_dubbed, hash_set, pick_any_dubbed_candidates,
    pick_br_dubbed_candidate, pick_br_dubbed_candidates, pick_from_pool,
    pick_top_seeded_candidates, uncached_br_hashes, FilterKnownOptions, FilterKnownResult,
    StreamDrop,
};
pub use br_pool_selection::{
    any_dubbed_pool, br_dubbed_pool, fallback_blocked, is_autofetch_target_quality,
    pick_br_dubbed_by_target_qualities, top_seeded_pool, PoolOptions, PoolStream,
};

// ── catalog_year ──────────────────────────────────────────────────────
pub use catalog_year::{catalog_alt_year_of, catalog_year_of};

// ── cache ─────────────────────────────────────────────────────────────
pub use cache_keys::{
    cache_key, is_versioned, mag_meta_counts_key, namespace_version, prefix, LEGACY_PREFIXES,
    NAMESPACE_VERSIONS,
};
pub use cache_quotas::{
    headroom, namespace_for, namespaces_without_explicit_quota, quota_for, universe, universe_len,
    universe_total, validate_quotas, MAX_ENTRIES, QUOTAS,
};

// ── config encoding / dk seal ─────────────────────────────────────────
pub use config_encoding::{decode_config, encode_config, parse_segment, seal_segment};
pub use dk_seal::{derive_dk_key, is_sealed, seal_dk, unseal_dk};

// ── debrid file select ────────────────────────────────────────────────
pub use debrid::{
    base_name, is_sample, is_site_ad, is_video, looks_multi_work_files, looks_pack_by_files,
    pick_code_label, pick_file, pick_work_file, work_coverage, DebridFile, EpisodeContext,
    EpisodeEvidence, PickCode, PickOutcome, PlayHint, WorkHint,
};
pub use debrid_cache_verdict::{
    cache_check_honest, failure_reason, failure_verdict, normalize_cache_result, unusable_reason,
    unusable_verdict, CacheAnswer, CacheVerdict, Unusable, UnusableReason,
};
pub use debrid_may_delete::{may_delete, DeleteFacts};
pub use debrid_rd_gate::{
    admit, initial_state, next_grant, on_finished, on_rate_limit, on_success, GateQueues, GateState,
};
pub use debrid_rd_ledger::{
    ledger_key, next_on_blocked, next_on_hit, next_on_miss, normalize_hash, peek_state, LedgerWrite,
};
pub use duplicate_pack::{drop_duplicate_pack_files, DuplicatePackInput, DuplicatePackOutput};

// ── episode ───────────────────────────────────────────────────────────
pub use episode_annotate::{
    annotate_movie_sizes_core, annotate_pack_sizes_core, episodes_covered, episodes_covered_wanted,
    exact_episode_bytes, fill_missing_sizes_core, fill_torrent_totals_core, EpisodeCounts,
    FillOpts, PackOpts,
};
pub use episode_matching::{is_season_pack_fill_eligible, is_season_pack_release, matches_episode};
pub use episode_parse::{
    parse_title_season_episode, season_coverage_excludes, ParsedSeasonEpisode,
};
pub use episode_series_matching::{matches_episode_work_identity, matches_global_series_no_marker};
pub use episode_size::{
    has_bogus_size_mark, parse_size_label, stream_size_label, stream_title_bytes,
};

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
pub use matches_br_title::{matches_br_title, matches_br_title_prepared, BrTitleName};
pub use release_name_matching::{
    contains_token_run, ends_with_sequence_marker, franchise_root, franchise_roots, matches_name,
};
pub use release_title_facts::{release_title_facts, ReleaseTitleFacts};
pub use release_title_rules::{
    matches_short_name_identity, matches_title_structure, short_name_identity, ShortNameIdentity,
};
pub use release_work::{
    choose_episode_parse, episode_parse_specificity, release_fits_request, release_work_targets,
    route_work_location, WorkTarget,
};
pub use series_episode_filter::{
    filter_series_episode, EpisodeFilterItem, SeriesEpisodeOutcome, SeriesEpisodeRejectReason,
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
    episode_token_test, normalized_title_tokens, title_tokens, vocabulary_contents, year_range_test,
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
    limit_by_quality, limit_by_quality_and_indexer, limit_reserving_br, limit_reserving_br_trace,
    quality_from_title, select_quality_candidates, stream_quality, LimitBrOpts,
    LimitReservingBrTrace, QualityLimits, StreamRef, QUALITY_KEYS, UNKNOWN_QUALITY,
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
pub use audio_presentation::{
    audio_from_title, audio_signals, looks_pt_br, strip_quality_tag_blob, AudioSignals,
};
pub use autofetch_expired::{expired_removal_allowed, ExpiredFacts};
pub use autofetch_fallback::{
    compose_queue_entries, pick_lower_pool_fallbacks, to_queue_candidate, FallbackLive,
    FallbackOpts, FallbackPick, FallbackPool, QueueCandidate, QueueCandidateOpts, QueueEntry,
};
pub use autofetch_gates::{
    classify_enqueue, rollback_for, skip_reason_label, EnqueueGates, RollbackAction, SkipReason,
};
pub use autofetch_keys::dead_key;
pub use autofetch_marker::{
    marker_key, marker_obra, marker_transfer_id, marker_value, MarkerMeta, MarkerValue,
};
pub use autofetch_obra::{
    combined_view, counts_from, obra_digest, obra_identity, obra_key, obra_prefix, pool_cap,
    read_record, seeds_rare, window_ms, ObraCounts, ObraIdentityInput, ObraLiveConfig,
    ObraRecordEntry, PendingReservation, OBRA_LEASE_TTL_MS,
};
pub use autofetch_obra_overflow::{overflow_upgrade_allowed, quality_rank, ObraEntry};
pub use autofetch_policy::{
    decide_seeds_stop, effective_seeds_max_bytes, filter_seeds_universe, has_playable_stream,
    normalize_seeds_max_quality, seeds_download_bytes, seeds_drain_rejection,
    seeds_intrinsic_rejection, seeds_quality_reject, seeds_selection_block, seeds_size_reject,
    DecideSeedsStopInput, DecideSeedsStopOutput, FilterSeedsResult, PlayableStream, SeedsCandidate,
    SeedsDrainReason, SeedsPolicyConfig, SeedsRejectReason, SeedsSelectionBlockReason,
    SeedsStopReason,
};
pub use autofetch_progress::{
    derive_stall, forget_lot_progress, forget_progress, progress_memory_size, ProgressDerivation,
    ProgressEntry, ProgressLot, ProgressMemory, TorrentProgress, TorrentStatus,
};
pub use autofetch_seeds_pick::{
    pick_seeds_pool, RareConfig, SeedsPickLive, SeedsPickOpts, SeedsPickResult,
};
pub use bytes_to_size::bytes_to_size;
pub use catalog_classify::{
    audio_bucket, classify_by_title, classify_with_evidence, foreign_proof_label, foreign_verdict,
    Proof,
};
pub use collapse_acronyms::collapse_acronyms;
pub use collection_budget::{compute_collection_budget, compute_priority_grace};
// Decisões do FIM da busca (porte de `src/providers/search-commit.ts`): o que
// gravar no cache, o que a promoção tardia faz e quando o SWR pode servir.
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
pub use pack_text_totals::{
    drop_pack_text_totals, files_prove_pack, names_multiple_episodes, PackTextTotalsInput,
    PackTextTotalsOutput,
};
pub use pt_audio_guards::{explicit_pt_audio, has_explicit_foreign_audio};
// Recuperação de DUAL global pelo título pt do TMDB (`ptTitleDual`): o Node
// deixou de decidir; a rota e o build in-process chamam esta régua.
pub use pt_title_dual::{
    pt_title_dual_marks, should_mark_pt_title_dual, PtTitleDualItem, PtTitleDualTitles,
};
pub use release_filters::{
    filter_relevant_raw, filter_relevant_raw_for_year, RelevanceItem, RelevanceOutcome,
    RelevanceQuery, RelevanceRejectReason, RelevanceSettings,
};
pub use release_guards::{
    magnet_season_contradicts, magnet_year_contradicts, text_years_contradict,
};
pub use release_labels::{compact_audio, edition_from_title, source_from_title};
// Saída do stream depois da checagem de cache (porte de `debrid-play-guard.ts`):
// é aqui que "pack multiobra admitido nunca vira P2P inteiro" vira código.
pub use play_disposition::{play_disposition, PlayDisposition, PlayFacts};
pub use reply_budget::remaining_check_budget;
pub use request_key::{account_scope, streams_cache_key, streams_cache_scope};
// Via do banco de magnets (porte de `magnet-bank-fallback.ts` e
// `magnet-bank-instant.ts`): a reserva e a janela da via instantânea.
pub use search_bank::{
    instant_window, is_recent_release, pick_source, InstantMeta, InstantWindow, SourceRow, WorkRow,
};
pub use search_finish::{
    commit_decision, debrid_refresh_satisfied, late_promotion_decision, stale_refresh_eligible,
    CommitDecision, CommitFacts, LateAction, LateDecision, LateFacts, LateReason, LiveState,
};
pub use search_name_helpers::{
    build_search_query, mark_debrid_name, matches_quality_filter, numeral_search_variant,
    parse_stremio_id, resolve_original_step_name, resolve_search_names,
};
pub use search_plan::{
    dubbed_sweep_query_for, live_indexers, plan_jackett_queries, pt_sweep_indexers, pt_sweep_query,
    pt_sweep_query_for, SearchPlanTask,
};
pub use search_pool_coverage::{idx_pool_covered, pool_covered, PoolCoverage, PoolCoverageItem};
pub use stream_display::{
    compact_tracker, stream_display_name, StreamDisplayConfig, StreamDisplayOptions,
    StreamNameStyle, UserDisplayOptions,
};
pub use stream_ranking_dedupe::{dedupe_by_hash, is_generic_dub_token, DedupeInput, DedupeOutput};
pub use stream_ranking_sort::{
    passes_quality_filter, sort_and_limit, SortInput, SortOptions, SortOutput,
};
pub use stream_ranking_types::{RankingStream, TraceDrop};
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
