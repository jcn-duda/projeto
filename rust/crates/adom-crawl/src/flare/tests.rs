//! Testes unitários do módulo flare (complementares aos testes inline de cada submódulo).
//!
//! Foco em funções puras que não dependem do módulo `net` do Agente 1.
//! Testes de integração com escalonamento real requerem mock HTTP e serão
//! adicionados quando o maestro integrar `fetch_text_direct`.

use super::challenge::is_cloudflare_challenge;
use super::session::{build_flare_headers, FlareSession, FlareSessions};
use super::types::{FlareError, FlareSolution};
use std::time::Duration;

// ── FlareError ──────────────────────────────────────────────────────────────

#[test]
fn flare_error_display_solver_not_reachable() {
    let err = FlareError::SolverNotReachable("connection refused".into());
    let msg = format!("{}", err);
    assert!(msg.contains("FlareSolverr não acessível"));
    assert!(msg.contains("connection refused"));
}

#[test]
fn flare_error_display_solver_failed() {
    let err = FlareError::SolverFailed {
        status: 500,
        body: "internal error".into(),
    };
    let msg = format!("{}", err);
    assert!(msg.contains("500"));
    assert!(msg.contains("internal error"));
}

#[test]
fn flare_error_display_challenge_not_resolved() {
    let err = FlareError::ChallengeNotResolved;
    let msg = format!("{}", err);
    assert!(msg.contains("Desafio Cloudflare não resolvido"));
}

#[test]
fn flare_error_display_direct_error() {
    let err = FlareError::DirectError("timeout after 15s".into());
    let msg = format!("{}", err);
    assert!(msg.contains("Erro no fetch direto"));
    assert!(msg.contains("timeout after 15s"));
}

#[test]
fn flare_error_display_timeout() {
    let err = FlareError::Timeout;
    let msg = format!("{}", err);
    assert!(msg.contains("Timeout"));
}

#[test]
fn flare_error_is_std_error() {
    // Verifica que FlareError implementa std::error::Error
    let err: Box<dyn std::error::Error> =
        Box::new(FlareError::ChallengeNotResolved);
    assert!(err.to_string().contains("Desafio"));
}

// ── FlareSolution ───────────────────────────────────────────────────────────

#[test]
fn flare_solution_clone() {
    let sol = FlareSolution {
        body: "<html>ok</html>".into(),
        cookies: vec![("cf_clearance".into(), "abc".into())],
        user_agent: "TestUA/1.0".into(),
        final_url: "https://example.com".into(),
    };
    let cloned = sol.clone();
    assert_eq!(cloned.body, sol.body);
    assert_eq!(cloned.cookies.len(), 1);
    assert_eq!(cloned.user_agent, sol.user_agent);
    assert_eq!(cloned.final_url, sol.final_url);
}

// ── FlareSessions — cenários adicionais ─────────────────────────────────────

#[test]
fn sessions_overwrite_existing_host() {
    let mut map = FlareSessions::new(60_000);
    map.store(
        "example.com".into(),
        FlareSession::new("old".into(), "OldUA".into(), Duration::from_secs(60)),
    );
    map.store(
        "example.com".into(),
        FlareSession::new("new".into(), "NewUA".into(), Duration::from_secs(60)),
    );
    let session = map.get("example.com").unwrap();
    assert_eq!(session.cookies, "new");
    assert_eq!(session.user_agent, "NewUA");
    assert_eq!(map.len(), 1);
}

#[test]
fn sessions_store_for_hosts_deduplicates_same_host() {
    let mut map = FlareSessions::new(60_000);
    let session = FlareSession::new("abc".into(), "UA".into(), Duration::from_secs(60));
    map.store_for_hosts(vec!["same.com".into(), "same.com".into()], session);
    // HashMap naturalmente deduplica
    assert_eq!(map.len(), 1);
}

#[test]
fn sessions_empty_on_creation() {
    let map = FlareSessions::new(60_000);
    assert!(map.is_empty());
    assert_eq!(map.len(), 0);
    assert!(map.get("anything.com").is_none());
}

// ── build_flare_headers — cenários adicionais ───────────────────────────────

#[test]
fn build_flare_headers_case_insensitive_hostname() {
    let mut map = FlareSessions::new(60_000);
    // Armazena com lowercase
    map.store(
        "example.com".into(),
        FlareSession::new("cookie=1".into(), "UA".into(), Duration::from_secs(60)),
    );
    // URL com hostname misto — extract_hostname faz lowercase
    let headers = build_flare_headers(&map, "https://EXAMPLE.COM/path");
    assert_eq!(headers.get("Cookie").unwrap(), "cookie=1");
}

#[test]
fn build_flare_headers_with_port_in_url() {
    let mut map = FlareSessions::new(60_000);
    map.store(
        "example.com".into(),
        FlareSession::new("cookie=1".into(), "UA".into(), Duration::from_secs(60)),
    );
    // URL com porta — extract_hostname extrai só o host
    let headers = build_flare_headers(&map, "https://example.com:8080/path");
    assert_eq!(headers.get("Cookie").unwrap(), "cookie=1");
}

#[test]
fn build_flare_headers_invalid_url() {
    let map = FlareSessions::new(60_000);
    let headers = build_flare_headers(&map, "not a valid url");
    assert!(headers.is_empty());
}

// ── is_cloudflare_challenge — cenários adicionais ───────────────────────────

#[test]
fn challenge_detection_combined_header_and_body() {
    // Header cf-mitigated E body com desafio — deve detectar
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("cf-mitigated", "challenge".parse().unwrap());
    assert!(is_cloudflare_challenge(
        503,
        &headers,
        "Just a moment - Cloudflare"
    ));
}

#[test]
fn challenge_detection_body_only_no_header() {
    // Sem header cf-mitigated, mas body com desafio
    let headers = reqwest::header::HeaderMap::new();
    assert!(is_cloudflare_challenge(
        403,
        &headers,
        "<html><body><h1>cf_chl_jschl_tk</h1></body></html>"
    ));
}

#[test]
fn challenge_detection_header_only_no_body_match() {
    // Header cf-mitigated: challenge, body limpo — deve detectar pelo header
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("cf-mitigated", "challenge".parse().unwrap());
    assert!(is_cloudflare_challenge(200, &headers, "<html>clean page</html>"));
}

#[test]
fn challenge_detection_cf_mitigated_other_value() {
    // Header cf-mitigated com valor diferente de "challenge" — não detecta pelo header
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert("cf-mitigated", "something_else".parse().unwrap());
    // Body também limpo
    assert!(!is_cloudflare_challenge(
        200,
        &headers,
        "<html>clean</html>"
    ));
}

// ── Defaults ────────────────────────────────────────────────────────────────

#[test]
fn defaults_are_correct() {
    use super::types::defaults;
    assert_eq!(defaults::SOLVER_URL, "http://127.0.0.1:8191");
    assert_eq!(defaults::TIMEOUT_MS, 55_000);
    assert_eq!(defaults::SESSION_TTL_MS, 1_200_000);
    assert_eq!(defaults::DIRECT_TIMEOUT_MS, 15_000);
    assert_eq!(defaults::MAX_HOPS, 10);
}

#[test]
fn direct_challenge_msg_is_lowercase() {
    use super::types::DIRECT_CHALLENGE_MSG;
    assert_eq!(DIRECT_CHALLENGE_MSG, "challenge");
    // Garante que é lowercase para matching case-sensitive no escalate
    assert!(!DIRECT_CHALLENGE_MSG.contains('C'));
}
