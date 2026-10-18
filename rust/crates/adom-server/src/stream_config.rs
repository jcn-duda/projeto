use adom_search::orchestrator::OrchestratorConfig;
use adom_search::BuildOptions;
use serde_json::Value;

pub fn orchestrator_config_from_env() -> OrchestratorConfig {
    let build = operator_search_build_from_env();
    let mut defaults = build.to_schema_defaults();
    merge_json_object(&mut defaults, &operator_debrid_defaults_from_env());
    let mut cfg = OrchestratorConfig {
        defaults,
        build,
        ..Default::default()
    };
    if let Ok(secret) = std::env::var("RESOLVE_SECRET") {
        cfg.resolve_secret = secret;
    }
    if let Some(ms) = env_u64("REPLY_DEADLINE_MS") {
        cfg.stremio_reply_ms = ms;
        cfg.budgets.reply_deadline_ms = ms as i64;
    }
    if let Some(ms) = env_u64("APP_REPLY_DEADLINE_MS") {
        cfg.app_reply_ms = ms;
    }
    if let Some(ms) = env_i64("DEBRID_RESERVE_MS") {
        cfg.budgets.debrid_reserve_ms = ms;
    }
    if let Some(ms) = env_i64("DEBRID_CHECK_FLOOR_MS") {
        cfg.budgets.debrid_check_floor_ms = ms;
    }
    if let Some(ttl) = env_i64("CACHE_TTL") {
        cfg.cache_ttl = ttl;
    }
    if let Some(ttl) = env_i64("FALLBACK_STREAMS_TTL") {
        cfg.fallback_streams_ttl = ttl;
    }
    if let Some(ms) = env_i64("SEARCH_INDEX_RESCUE_MIN_MS") {
        cfg.search_index_rescue_min_ms = ms;
    }
    if let Some(grace) = env_u64("STREAM_STALE_GRACE_SECONDS") {
        cfg.stale_grace_seconds = grace;
    }
    if let Ok(raw) = std::env::var("DEBRID_RESOLVE_UNCACHED") {
        cfg.resolve_uncached = env_flag(&raw);
    }
    cfg
}

pub fn operator_search_build_from_env() -> BuildOptions {
    let mut b = BuildOptions::default();
    if let Some(n) = env_f64("MAX_RESULTS") {
        b.max_results = n;
    }
    if let Some(n) = env_f64("MIN_SEEDERS") {
        b.min_seeders = n;
    }
    if let Some(n) = env_f64("CANDIDATE_POOL_FACTOR") {
        b.candidate_pool_factor = n;
    }
    if let Some(n) = env_f64("BR_RESERVED_SLOTS") {
        b.br_reserved_slots = n;
    }
    if let Some(n) = env_f64("BR_RESERVED_PER_QUALITY") {
        b.br_reserved_per_quality = n;
    }
    if let Some(n) = env_f64("MAX_STREAMS_PER_INDEXER") {
        b.max_per_indexer = n;
    }
    if let Ok(raw) = std::env::var("PREFER_DUBBED") {
        b.prefer_dubbed = env_flag(&raw);
    }
    // Ausente → default HD; `QUALITY_FILTER=` vazio de propósito aceita todas.
    if let Ok(raw) = std::env::var("QUALITY_FILTER") {
        b.qualities = raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    let mut limits = b.quality_limits.clone();
    // Chave do balde sem resolução = `UNKNOWN_QUALITY` do núcleo ("sem resolução").
    for (env_key, quality) in [
        ("MAX_STREAMS_2160P", "2160p"),
        ("MAX_STREAMS_1080P", "1080p"),
        ("MAX_STREAMS_720P", "720p"),
        ("MAX_STREAMS_480P", "480p"),
        ("MAX_STREAMS_SD", "SD"),
        ("MAX_STREAMS_UNKNOWN", "sem resolução"),
    ] {
        if let Some(n) = env_f64(env_key) {
            limits.insert(quality.to_string(), n);
        }
    }
    b.quality_limits = limits;
    b
}

pub fn merge_json_object(base: &mut Value, overlay: &Value) {
    let Some(base_map) = base.as_object_mut() else {
        return;
    };
    let Some(overlay_map) = overlay.as_object() else {
        return;
    };
    for (k, v) in overlay_map {
        base_map.insert(k.clone(), v.clone());
    }
}

pub fn operator_debrid_defaults_from_env() -> Value {
    operator_debrid_defaults(
        std::env::var("DEBRID_SERVICE").ok().as_deref(),
        std::env::var("DEBRID_API_KEY").ok().as_deref(),
        std::env::var("DEBRID_ALLOW_ENV_KEY").ok().as_deref(),
        std::env::var("DEBRID_CACHED_ONLY").ok().as_deref(),
        std::env::var("DEBRID_SHOW_UNCACHED_BR").ok().as_deref(),
        std::env::var("BR_RESERVED_SLOTS").ok().as_deref(),
        std::env::var("BR_RESERVED_PER_QUALITY").ok().as_deref(),
    )
}

pub fn operator_debrid_defaults(
    service: Option<&str>,
    api_key: Option<&str>,
    allow_env_key: Option<&str>,
    cached_only: Option<&str>,
    show_uncached_br: Option<&str>,
    br_reserved_slots: Option<&str>,
    br_reserved_per_quality: Option<&str>,
) -> Value {
    let allow = allow_env_key.map(env_flag).unwrap_or(true);
    let key = if allow {
        api_key.unwrap_or("").trim().to_string()
    } else {
        String::new()
    };
    let br_slots = br_reserved_slots
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(6.0);
    let br_pq = br_reserved_per_quality
        .and_then(|s| s.trim().parse::<f64>().ok())
        .unwrap_or(1.0);
    serde_json::json!({
        "debridService": service.unwrap_or("").trim().to_ascii_lowercase(),
        "debridApiKey": key,
        "debridCachedOnly": cached_only.map(env_flag).unwrap_or(true),
        "showUncachedBr": show_uncached_br.map(env_flag).unwrap_or(false),
        "brReservedSlots": br_slots,
        "brReservedPerQuality": br_pq,
    })
}

pub fn env_flag(raw: &str) -> bool {
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "on" | "yes"
    )
}

pub fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

pub fn env_i64(key: &str) -> Option<i64> {
    std::env::var(key).ok()?.trim().parse().ok()
}

pub fn env_f64(key: &str) -> Option<f64> {
    std::env::var(key).ok()?.trim().parse().ok()
}
