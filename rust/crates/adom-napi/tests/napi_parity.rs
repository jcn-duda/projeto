//! Testes de paridade do `adom-napi`.
//!
//! Cada teste valida a lógica que os wrappers NAPI delegam ao `adom-core`.
//! Como o wrapper é trivial (conversão `String` → `&str`), testar o `adom-core`
//! diretamente cobre o mesmo comportamento sem precisar do runtime Node.js.
//!
//! Se algum wrapper NAPI introduzir lógica própria (não apenas delegação),
//! deve ganhar um teste específico aqui.

use std::collections::HashMap;

// ---------------------------------------------------------------------------
// normalize_title
// ---------------------------------------------------------------------------

#[test]
fn normalize_title_remove_special_chars() {
    let result = adom_core::normalize_title("Star Wars: The Clone Wars");
    assert_eq!(result, "star wars the clone wars");
}

#[test]
fn normalize_title_with_accents() {
    let result = adom_core::normalize_title("A Paixão de Cristo");
    assert_eq!(result, "a paixao de cristo");
}

#[test]
fn normalize_title_empty() {
    let result = adom_core::normalize_title("");
    assert_eq!(result, "");
}

// ---------------------------------------------------------------------------
// sign_resolve / verify_resolve
// ---------------------------------------------------------------------------

#[test]
fn sign_resolve_produces_hex() {
    let sig = adom_core::sign_resolve(
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "1",
        "",
        "minha-chave-secreta",
    );
    // HMAC-SHA256 → 64 caracteres hex.
    assert_eq!(sig.len(), 64);
    assert!(sig.bytes().all(|b| b.is_ascii_hexdigit()));
}

#[test]
fn sign_resolve_empty_secret_returns_empty() {
    let sig = adom_core::sign_resolve("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", "", "", "");
    assert_eq!(sig, "");
}

#[test]
fn verify_resolve_roundtrip() {
    let secret = "teste-secreto";
    let hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    let ep = "5";
    let hint = "";

    let sig = adom_core::sign_resolve(hash, ep, hint, secret);
    assert!(adom_core::verify_resolve(
        hash,
        ep,
        Some(&sig),
        hint,
        secret
    ));
}

#[test]
fn verify_resolve_rejects_wrong_sig() {
    let ok = adom_core::verify_resolve(
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
        "1",
        Some("0000000000000000000000000000000000000000000000000000000000000000"),
        "",
        "chave",
    );
    assert!(!ok);
}

// ---------------------------------------------------------------------------
// matches_br_title
// ---------------------------------------------------------------------------

#[test]
fn matches_br_title_exact_match() {
    let ok = adom_core::matches_br_title(
        "guerra nas estrelas",
        "guerra nas estrelas",
        "",
        false,
        None,
        None,
        None,
        true,
    );
    assert!(ok);
}

#[test]
fn matches_br_title_unrelated_title_rejected() {
    let ok = adom_core::matches_br_title(
        "aniversario de fulano",
        "guerra nas estrelas",
        "",
        false,
        None,
        None,
        None,
        true,
    );
    assert!(!ok);
}

#[test]
fn matches_br_title_with_all_names() {
    // Título curto com precisão alta: todos os tokens do título estão no universo.
    let all_names = vec!["Guerra nas Estrelas".to_string()];
    let ok = adom_core::matches_br_title(
        "guerra nas estrelas",
        "guerra nas estrelas",
        "",
        false,
        Some(all_names.as_slice()),
        None,
        None,
        true,
    );
    assert!(ok);
}

// ---------------------------------------------------------------------------
// parse_title_season_episode
// ---------------------------------------------------------------------------

#[test]
fn parse_title_season_episode_s01e04() {
    let p = adom_core::parse_title_season_episode("Breaking.Bad.S01E04.720p");
    assert_eq!(p.seasons, vec![1]);
    assert_eq!(p.episodes, vec![4]);
    assert!(!p.complete);
    assert!(!p.season_pack);
}

#[test]
fn parse_title_season_episode_range() {
    let p = adom_core::parse_title_season_episode("Show.S03E01-03.HDTV");
    assert_eq!(p.seasons, vec![3]);
    assert_eq!(p.episodes, vec![1, 2, 3]);
}

#[test]
fn parse_title_season_episode_complete() {
    let p = adom_core::parse_title_season_episode("Friends Todas as Temporadas");
    assert!(p.complete);
}

#[test]
fn parse_title_season_episode_season_pack() {
    let p = adom_core::parse_title_season_episode("The Office Temporada Completa");
    assert!(p.season_pack);
}

#[test]
fn parse_title_season_episode_1x04() {
    let p = adom_core::parse_title_season_episode("Arquivo X 1x04");
    assert_eq!(p.seasons, vec![1]);
    assert_eq!(p.episodes, vec![4]);
}

#[test]
fn parse_title_season_episode_no_match() {
    let p = adom_core::parse_title_season_episode("Filme.2024.1080p.BluRay");
    assert!(p.seasons.is_empty());
    assert!(p.episodes.is_empty());
    assert!(!p.complete);
    assert!(!p.season_pack);
}

// ---------------------------------------------------------------------------
// matches_name
// ---------------------------------------------------------------------------

#[test]
fn matches_name_sufficient_coverage() {
    assert!(adom_core::matches_name(
        "guerra nas estrelas a nova esperanca",
        "guerra nas estrelas",
        None,
    ));
}

#[test]
fn matches_name_insufficient_coverage() {
    // Só 1 de 3 tokens → 33% < 60%.
    assert!(!adom_core::matches_name(
        "guerra dos tronos",
        "guerra nas estrelas",
        None,
    ));
}

// ---------------------------------------------------------------------------
// sanitize_magnet / default_magnet
// ---------------------------------------------------------------------------

#[test]
fn default_magnet_contains_hash_and_trackers() {
    let hash = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    let magnet = adom_core::default_magnet(hash);
    assert!(magnet.starts_with("magnet:?xt=urn:btih:"));
    assert!(magnet.contains(hash));
    assert!(magnet.contains("&tr="));
}

#[test]
fn sanitize_magnet_none_for_invalid_uri() {
    let result = adom_core::sanitize_magnet(
        Some("http://exemplo.com/torrent"),
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    );
    assert!(result.is_none());
}

#[test]
fn sanitize_magnet_none_for_empty() {
    let result = adom_core::sanitize_magnet(None, "abc");
    assert!(result.is_none());
}

// ---------------------------------------------------------------------------
// extract_info_hash
// ---------------------------------------------------------------------------

#[test]
fn extract_info_hash_hex40() {
    let hash = adom_core::extract_info_hash("A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2");
    assert_eq!(
        hash,
        Some("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2".into())
    );
}

#[test]
fn extract_info_hash_none_for_garbage() {
    let hash = adom_core::extract_info_hash("nao-e-hash");
    assert!(hash.is_none());
}

#[test]
fn extract_info_hash_none_for_empty() {
    let hash = adom_core::extract_info_hash("");
    assert!(hash.is_none());
}

// ---------------------------------------------------------------------------
// br_origin_mark / has_pt_signs
// ---------------------------------------------------------------------------

#[test]
fn br_origin_mark_detects_pt_accent() {
    assert!(adom_core::br_origin_mark("A Paixão de Cristo"));
}

#[test]
fn br_origin_mark_detects_site_tag() {
    assert!(adom_core::br_origin_mark("Filme.2024.BLUDV"));
}

#[test]
fn br_origin_mark_english_title_no_br() {
    assert!(!adom_core::br_origin_mark(
        "The Matrix Reloaded 2003 1080p BluRay"
    ));
}

#[test]
fn has_pt_signs_detects_vocabulary() {
    assert!(adom_core::has_pt_signs("Filme Dublado 2024"));
}

#[test]
fn has_pt_signs_english_only() {
    assert!(!adom_core::has_pt_signs(
        "The Matrix Reloaded 1080p BluRay x264"
    ));
}

// ---------------------------------------------------------------------------
// limit_by_indexer
// ---------------------------------------------------------------------------

#[test]
fn limit_by_indexer_no_limit_passes_all() {
    let indexers: Vec<Option<&str>> = vec![Some("rarbg"), Some("1337x"), Some("rarbg")];
    let exempt = std::collections::HashSet::new();
    let result = adom_core::limit_by_indexer(&indexers, 0.0, &exempt, &HashMap::new());
    assert_eq!(result, vec![0, 1, 2]);
}

#[test]
fn limit_by_indexer_respects_global_cap() {
    let indexers: Vec<Option<&str>> = vec![Some("rarbg"), Some("rarbg"), Some("rarbg")];
    let exempt = std::collections::HashSet::new();
    let result = adom_core::limit_by_indexer(&indexers, 2.0, &exempt, &HashMap::new());
    assert_eq!(result, vec![0, 1]);
}

#[test]
fn limit_by_indexer_exempt_passes_over_cap() {
    let indexers: Vec<Option<&str>> = vec![Some("rarbg"), Some("rarbg"), Some("rarbg")];
    let mut exempt = std::collections::HashSet::new();
    exempt.insert(2);
    let result = adom_core::limit_by_indexer(&indexers, 1.0, &exempt, &HashMap::new());
    assert_eq!(result, vec![0, 2]);
}

#[test]
fn limit_by_indexer_none_indexer_always_passes() {
    let indexers: Vec<Option<&str>> = vec![None, None, Some("rarbg")];
    let exempt = std::collections::HashSet::new();
    let result = adom_core::limit_by_indexer(&indexers, 1.0, &exempt, &HashMap::new());
    assert_eq!(result, vec![0, 1, 2]);
}

#[test]
fn limit_by_indexer_per_indexer_override() {
    let indexers: Vec<Option<&str>> = vec![Some("rarbg"), Some("rarbg"), Some("rarbg")];
    let exempt = std::collections::HashSet::new();
    let mut overrides = HashMap::new();
    overrides.insert("rarbg".to_string(), 3.0);
    let result = adom_core::limit_by_indexer(&indexers, 1.0, &exempt, &overrides);
    assert_eq!(result, vec![0, 1, 2]);
}
