use adom_search::orchestrator::OrchestratorConfig;
use adom_search::BuildOptions;
use adom_sources::jackett::{jackett_config_dir_from_env, resolve_jackett_indexers};
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
    if let Some(ms) = env_i64("SEARCH_TAIL_COLLECT_MS") {
        cfg.tail_collect_ms = ms;
    }
    // Mesmo default do Node (`config.search.packTail`): só "true" liga.
    cfg.pack_tail = std::env::var("SEARCH_PACK_TAIL").map_or(true, |raw| {
        let raw = raw.trim();
        raw.is_empty() || raw == "true"
    });
    if let Some(grace) = env_u64("STREAM_STALE_GRACE_SECONDS") {
        cfg.stale_grace_seconds = grace;
    }
    if let Ok(raw) = std::env::var("DEBRID_RESOLVE_UNCACHED") {
        cfg.resolve_uncached = env_flag(&raw);
    }
    // Efeitos de cauda emitidos pelo orquestrador nativo. Default ON desde o
    // F4.4 (o pipeline de debrid do Node saiu; estas são as ÚNICAS emissões).
    // Rollback: EFFECTS_RUST=off/0 — as filas do Node dedupam, mas o custo dobra.
    cfg.effects_enabled = std::env::var("EFFECTS_RUST")
        .map(|raw| env_flag(&raw))
        .unwrap_or(true);
    // Card virtual `mico` no `ji` default (mesma env do Node).
    cfg.mico_default = std::env::var("MICO_DEFAULT")
        .map(|raw| env_flag(&raw))
        .unwrap_or(false);
    // Inventário nativo da conta (F3): é a ÚNICA fonte da conta no corte.
    // `DEBRID_INVENTORY_SOURCE` (default true, como no Node): desligado, a
    // conta não é fonte.
    cfg.account_inventory_source = std::env::var("DEBRID_INVENTORY_SOURCE")
        .map(|raw| env_flag(&raw))
        .unwrap_or(true);
    // `ACCOUNT_FAST_PATH` do Node nasce LIGADO; só um valor falso desliga.
    cfg.account_fast_path = std::env::var("ACCOUNT_FAST_PATH")
        .map(|raw| env_flag(&raw))
        .unwrap_or(true);
    if let Some(n) = env_i64("ACCOUNT_FAST_MIN_RELEASES") {
        cfg.account_fast_min_releases = n.max(1) as usize;
    }
    // O `poolCovered` do Node usa o piso do AUTOFETCH (default 3), não o
    // `MIN_SEEDERS` do build.
    if let Some(n) = env_f64("DEBRID_AUTO_FETCH_MIN_SEEDERS") {
        cfg.account_fast_min_seeders = n.max(0.0);
    }
    if let Some(ms) = env_i64("DEBRID_INVENTORY_TIMEOUT_MS") {
        cfg.account_inventory_timeout_ms = ms.max(1);
    }
    if let Some(n) = env_i64("DEBRID_INVENTORY_MAX") {
        cfg.account_inventory_max = n.max(1) as usize;
    }
    if let Some(ttl) = env_i64("DEBRID_INVENTORY_TTL") {
        cfg.account_inventory_ttl_s = ttl.max(0);
    }
    if let Some(ms) = env_i64("ACCOUNT_FAST_WAIT_MS") {
        cfg.account_fast_wait_ms = ms.max(1);
    }
    // Defaults do Node (`config/harvest.ts`/`config/cache.ts`).
    cfg.release_index_enabled = std::env::var("RELEASE_INDEX")
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true);
    if let Some(ttl) = env_i64("RELEASE_INDEX_TTL") {
        cfg.release_index_ttl = ttl.max(0) as u64;
    }
    if let Some(n) = env_i64("RELEASE_INDEX_MAX_RELEASES") {
        cfg.release_index_max_releases = n.max(1) as usize;
    }
    cfg.magnet_bank_enabled = std::env::var("MAGNET_BANK")
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    cfg.magnet_bank_instant_enabled = std::env::var("MAGNET_BANK_INSTANT")
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    cfg.magnet_bank_fallback_enabled = std::env::var("MAGNET_BANK_FALLBACK")
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    if let Some(n) = env_i64("MAGNET_BANK_FALLBACK_MAX") {
        cfg.magnet_bank_fallback_max_per_indexer = n.clamp(1, 40);
    }
    if let Some(n) = env_i64("MAGNET_BANK_FALLBACK_GLOBAL_MAX") {
        cfg.magnet_bank_fallback_global_max = n.clamp(1, 500);
    }
    let instant_min = env_i64("MAGNET_BANK_INSTANT_MIN_MS")
        .map(|n| n.max(1_000))
        .unwrap_or(7 * 86_400_000);
    let instant_max = env_i64("MAGNET_BANK_INSTANT_MAX_MS")
        .map(|n| n.max(1_000))
        .unwrap_or(7 * 86_400_000)
        .max(instant_min);
    cfg.magnet_bank_instant_min_ms = instant_min;
    cfg.magnet_bank_instant_max_ms = instant_max;
    cfg.magnet_bank_instant_fresh_max_ms = env_i64("MAGNET_BANK_INSTANT_FRESH_MAX_MS")
        .map(|n| n.max(1_000))
        .unwrap_or(2 * 3_600_000)
        .min(instant_max);
    // O `poolCovered` do Node usa o piso do AUTOFETCH — o MESMO número já lido
    // para o fast-path da conta.
    cfg.auto_fetch_min_seeders = cfg.account_fast_min_seeders;
    // Listas de indexers do operador (`src/config/jackett.ts`). O índice/banco
    // nativo precisa delas para `allowedSourceIndexer` (isenção dos index-only),
    // elegibilidade da instantânea, BR-gap e `brSource` da reserva.
    // `JACKETT_INDEXERS` vazio → os indexers habilitados no VOLUME do Jackett
    // (modo automático do TS, `syncAutoIndexers`), lidos do disco no boot.
    cfg.selected_indexers = operator_jackett_indexers();
    cfg.pt_br_indexers = indexer_list(
        std::env::var("JACKETT_PT_BR_INDEXERS").ok().as_deref(),
        "bludv-cardigann,comandotorrents,nerdfilmes,torrentdosfilmesv2,vacatorrent,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
    );
    cfg.isolate_indexers = indexer_list(
        std::env::var("JACKETT_SLOW_INDEXERS").ok().as_deref(),
        "bludv-cardigann,redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann",
    );
    cfg.index_only_indexers = indexer_list(
        std::env::var("JACKETT_INDEX_ONLY_INDEXERS").ok().as_deref(),
        "redetorrent-cardigann,apachetorrent-cardigann,hdrtorrent-cardigann,magnetdownload,1337x,kickasstorrents-ws",
    );
    cfg
}

/// Indexers do operador: `JACKETT_INDEXERS` vence; vazia/ausente cai nos
/// indexers HABILITADOS do volume do Jackett (leitura local, no boot).
///
/// O coletor Jackett resolve a mesma lista por `JackettConfig::from_env` — as
/// duas leituras são de boot, nunca por requisição; o log sai só aqui.
fn operator_jackett_indexers() -> Vec<String> {
    let raw = std::env::var("JACKETT_INDEXERS").ok();
    let from_env = raw.as_deref().is_some_and(|value| !value.trim().is_empty());
    let dir = jackett_config_dir_from_env();
    let ids = resolve_jackett_indexers(raw.as_deref(), &dir);
    if from_env {
        return ids;
    }
    if ids.is_empty() {
        eprintln!(
            "[gateway] JACKETT_INDEXERS vazio e nenhum indexer em {}; a busca cai no agregado /all",
            dir.display()
        );
    } else {
        eprintln!(
            "[gateway] JACKETT_INDEXERS vazio: {} indexers automáticos pelo volume do Jackett ({})",
            ids.len(),
            ids.join(", ")
        );
    }
    ids
}

/// CSV de indexers (`indexerList` do Node): trim, descarta vazios e aplica o
/// rename dos ids aposentados. `raw` vazio ou ausente cai no `default` (vazio
/// = lista vazia), nunca no catálogo vivo.
///
/// Régua do oráculo (`src/config/helpers.ts:13`): o gate é a string CRUA —
/// só ausente e `""` são falsy (`env || default`). `"   "` é TRUTHY e o
/// `list()` apara para `[]`, então aqui também vira lista VAZIA, nunca o
/// default (senão a sonda do colhedor e a busca viva leem knobs diferentes).
fn indexer_list(raw: Option<&str>, default: &str) -> Vec<String> {
    let source = match raw {
        None | Some("") => default,
        Some(value) => value,
    };
    let ids: Vec<String> = source
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    // O MESMO rename do TS (`indexerList`): o id aposentado da env aponta
    // para o card substituto. Sem isso, o Rust e o Node consultariam ids
    // DIFERENTES para a MESMA env — e o indexer sumiria da busca sem erro.
    adom_core::rename_indexer_ids(&ids)
}

pub fn operator_search_build_from_env() -> BuildOptions {
    // `config.search.titlePrecisionTailCut`: default true; só "false" desliga.
    // O `JackettCollector` lê a MESMA env (ele não recebe o OrchestratorConfig).
    let mut b = BuildOptions {
        title_precision_tail_cut: std::env::var("TITLE_PRECISION_TAIL_CUT")
            .map(|raw| raw.trim() != "false")
            .unwrap_or(true),
        ..BuildOptions::default()
    };
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
    // `BR_MULTIWORK_PACKS` / `SEARCH_PRE_HOME_RELEASE_CUT` são do OPERADOR (não
    // estão no SCHEMA do usuário). Default do Node = ligado; só o literal
    // "false" desliga (`String(env || 'true') === 'true'`).
    b.multi_work_packs = std::env::var("BR_MULTIWORK_PACKS")
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    b.pre_home_release_cut = std::env::var("SEARCH_PRE_HOME_RELEASE_CUT")
        .map(|raw| raw.trim() != "false")
        .unwrap_or(true);
    if let Some(ms) = env_i64("SEARCH_PRE_HOME_RELEASE_MARGIN_MS") {
        b.pre_home_release_margin_ms = ms;
    }
    if let Some(ms) = env_i64("SEARCH_UNAIRED_MARGIN_MS") {
        b.unaired_margin_ms = ms;
    }
    if let Some(ms) = env_i64("SEARCH_PREAIR_RELEASE_MARGIN_MS") {
        b.pre_air_margin_ms = ms;
    }
    if let Ok(raw) = std::env::var("PREFER_DUBBED") {
        b.prefer_dubbed = env_flag(&raw);
    }
    // `dubbedOnly` do `runtime.ts` nasce de `BLUDV_DUBBED_ONLY` (default true).
    // É a mesma opção que o coletor BLUDV recebe para filtrar `legendado`.
    b.dubbed_only = std::env::var("BLUDV_DUBBED_ONLY")
        .map(|raw| env_flag(&raw))
        .unwrap_or(true);
    // Mesmas listas do Node (`src/config/audit.ts`): o dn= de cena EN anula a
    // promessa de dublado do post também no /stream nativo.
    b.audio_audit = adom_search::AudioAudit::from_env_values(
        std::env::var("AUDIO_AUDIT").ok().as_deref(),
        std::env::var("AUDIO_AUDIT_PT_MARKERS").ok().as_deref(),
        std::env::var("AUDIO_AUDIT_EN_GROUPS").ok().as_deref(),
    );
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

#[cfg(test)]
mod tests {
    use super::indexer_list;

    #[test]
    fn lista_de_indexers_trim_e_default() {
        assert_eq!(
            indexer_list(Some(" bludv-cardigann, ,nerdfilmes "), ""),
            vec!["bludv-cardigann".to_string(), "nerdfilmes".to_string()]
        );
        let ab = vec!["a".to_string(), "b".to_string()];
        // Valor presente: split simples (sem default envolvido).
        assert_eq!(indexer_list(Some("a,b"), "x"), ab);
        // Ausente e `""` são falsy: caem no default (que pode ser vazio — ji
        // automático NÃO é replicado no nativo).
        assert_eq!(indexer_list(None, ""), Vec::<String>::new());
        assert_eq!(indexer_list(None, "a,b"), ab);
        assert_eq!(indexer_list(Some(""), "a,b"), ab);
        // `"   "` é TRUTHY no Node: `list()` apara e devolve `[]` — lista
        // VAZIA, nunca o default (mesma régua da sonda do colhedor).
        assert!(indexer_list(Some("   "), "a,b").is_empty());
        assert!(indexer_list(Some(" , , "), "a,b").is_empty());
    }
}
