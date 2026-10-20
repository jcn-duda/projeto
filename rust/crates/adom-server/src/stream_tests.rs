use super::*;

#[test]
fn streams_db_path_env_vence_default() {
    assert_eq!(
        streams_db_path_from(None),
        PathBuf::from(DEFAULT_STREAMS_DB)
    );
    assert_eq!(
        streams_db_path_from(Some("")),
        PathBuf::from(DEFAULT_STREAMS_DB)
    );
    assert_eq!(
        streams_db_path_from(Some("   ")),
        PathBuf::from(DEFAULT_STREAMS_DB)
    );
    assert_eq!(
        streams_db_path_from(Some("  custom/streams.db  ")),
        PathBuf::from("custom/streams.db")
    );
}

#[test]
fn new_shadow_swr_store_memoria_vazia_nao_abre_disco() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("streams.db");
    let prev = std::env::var("STREAMS_DB").ok();
    // SAFETY: teste serial local; restaura STREAMS_DB ao sair.
    std::env::set_var("STREAMS_DB", &path);
    let store = new_shadow_swr_store();
    assert_eq!(store.len(), 0);
    let orch = build_shadow_orchestrator();
    assert!(orch.shadow_mode());
    assert!(
        !path.exists(),
        "shadow não deve chamar open_swr_store / criar STREAMS_DB"
    );
    match prev {
        Some(v) => std::env::set_var("STREAMS_DB", v),
        None => std::env::remove_var("STREAMS_DB"),
    }
}

#[test]
fn open_swr_store_at_tempfile_abre() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("streams.db");
    let stores = open_stream_stores_at(&path);
    assert_eq!(stores.swr.len(), 0);
    assert!(
        stores.streams.is_some(),
        "a API administrativa recebe o SQLite"
    );
    assert!(path.is_file(), "open deve criar o arquivo em disco");
}

#[test]
fn open_swr_store_at_path_invalido_cai_em_memoria() {
    let dir = tempfile::tempdir().expect("tempdir");
    // Pai é arquivo → create_dir_all/open falha → fallback memória.
    let blocker = dir.path().join("nao-e-pasta");
    std::fs::write(&blocker, b"x").expect("blocker");
    let path = blocker.join("streams.db");
    let stores = open_stream_stores_at(&path);
    assert_eq!(stores.swr.len(), 0);
    assert!(!path.exists(), "fallback memória não cria o path inválido");
}

#[test]
fn cache_control_zero_e_positivo() {
    assert_eq!(cache_control(0), "max-age=0, public");
    assert_eq!(
        cache_control(900),
        "max-age=900, stale-while-revalidate=3600, stale-if-error=86400, public"
    );
}

#[test]
fn is_native_stream_so_get_head_em_path_stream() {
    assert!(is_native_stream(
        &Method::GET,
        "/stream/movie/tt0133093.json"
    ));
    assert!(is_native_stream(
        &Method::HEAD,
        "/e30/stream/series/tt0903747:1:1.json"
    ));
    assert!(!is_native_stream(
        &Method::POST,
        "/stream/movie/tt0133093.json"
    ));
    assert!(!is_native_stream(&Method::GET, "/manifest.json"));
    assert!(!is_native_stream(&Method::GET, "/health"));
}

#[test]
fn from_path_sem_config_mantem_encoded_none_e_prefixo_vazio() {
    let req = StreamRequest::from_path("/stream/movie/tt0133093.json", None, None, None)
        .expect("path sem config");
    // Paridade Node: sem segmento na URL → prefixo ""; o canônico `e30`
    // só entra no corpo de `/internal/search/*` (orquestrador).
    assert_eq!(req.encoded, None);
    assert_eq!(req.prefix(), "");

    let com = StreamRequest::from_path(
        "/eyJwIjoiamFja2V0dCJ9/stream/movie/tt0133093.json",
        None,
        None,
        None,
    )
    .expect("path com config");
    assert_eq!(com.encoded.as_deref(), Some("eyJwIjoiamFja2V0dCJ9"));
    assert_eq!(com.prefix(), "/eyJwIjoiamFja2V0dCJ9");
}

#[test]
fn defaults_debrid_herdam_env_como_runtime_ts() {
    let d = operator_debrid_defaults(
        Some("AllDebrid"),
        Some(" chave-do-operador "),
        None, // ALLOW_ENV_KEY ausente → true
        None, // CACHED_ONLY ausente → true
        None,
        None,
        None,
    );
    assert_eq!(d["debridService"], serde_json::json!("alldebrid"));
    assert_eq!(d["debridApiKey"], serde_json::json!("chave-do-operador"));
    assert_eq!(d["debridCachedOnly"], serde_json::json!(true));
    assert_eq!(d["showUncachedBr"], serde_json::json!(false));
    assert_eq!(d["brReservedSlots"], serde_json::json!(6.0));
    assert_eq!(d["brReservedPerQuality"], serde_json::json!(1.0));
}

#[test]
fn defaults_merge_cotas_com_debrid_como_runtime_ts() {
    let build = operator_search_build_from_env();
    let mut defaults = build.to_schema_defaults();
    merge_json_object(
        &mut defaults,
        &operator_debrid_defaults(
            Some("alldebrid"),
            Some("chave"),
            Some("true"),
            Some("true"),
            Some("true"),
            None,
            None,
        ),
    );
    // Cotas Node-like sobrevivem ao merge (não só a fatia debrid).
    assert_eq!(defaults["max1080p"], serde_json::json!(2.0));
    assert_eq!(defaults["maxResults"], serde_json::json!(40.0));
    assert_eq!(defaults["brReservedSlots"], serde_json::json!(6.0));
    assert_eq!(
        defaults["qualities"],
        serde_json::json!(["2160p", "1080p", "720p"])
    );
    assert_eq!(defaults["debridService"], serde_json::json!("alldebrid"));
    assert_eq!(defaults["showUncachedBr"], serde_json::json!(true));
    assert_eq!(build.quality_limits.get("1080p"), Some(&2.0));
    assert_eq!(build.candidate_pool_factor, 4.0);
}

#[test]
fn defaults_debrid_sem_allow_env_key_nao_herdam_chave() {
    let d = operator_debrid_defaults(
        Some("premiumize"),
        Some("secreta"),
        Some("false"),
        Some("0"),
        Some("true"),
        Some("4"),
        Some("2"),
    );
    assert_eq!(d["debridService"], serde_json::json!("premiumize"));
    assert_eq!(d["debridApiKey"], serde_json::json!(""));
    assert_eq!(d["debridCachedOnly"], serde_json::json!(false));
    assert_eq!(d["showUncachedBr"], serde_json::json!(true));
    assert_eq!(d["brReservedSlots"], serde_json::json!(4.0));
    assert_eq!(d["brReservedPerQuality"], serde_json::json!(2.0));
}

#[test]
fn fabrica_com_defaults_env_liga_debrid_ativo() {
    use adom_search::orchestrator::{AdapterDebridFactory, DebridContext, DebridFactory};

    let defaults = operator_debrid_defaults(
        Some("alldebrid"),
        Some("chave"),
        Some("true"),
        Some("true"),
        None,
        None,
        None,
    );
    let ctx = DebridContext {
        service: defaults["debridService"].as_str().unwrap().into(),
        api_key: defaults["debridApiKey"].as_str().unwrap().into(),
        ..DebridContext::default()
    };
    assert!(ctx.is_active(), "herança env deve ativar DebridContext");
    // Com chave, a fábrica NÃO devolve NoDebridCheck (prepare/check
    // fariam rede — aqui só prove que o caminho ativo abre).
    let factory = AdapterDebridFactory::default();
    let _check = factory.make(&ctx);
}
