//! Detecção de desafio Cloudflare em respostas HTTP.
//! Porte fiel de `resolvers/flare.ts:69-72`.

use regex::Regex;
use std::sync::OnceLock;

/// Regex que detecta indicadores de desafio Cloudflare no body HTML.
/// Cobre: "Just a moment", cf-chl, __cf_chl, challenge-platform,
/// cf-browser-verification, cf_chl.
static CHALLENGE_BODY_RE: OnceLock<Regex> = OnceLock::new();

fn challenge_body_regex() -> &'static Regex {
    CHALLENGE_BODY_RE.get_or_init(|| {
        Regex::new(
            r"(?i)Just a moment|cf-chl|__cf_chl|challenge-platform|cf-browser-verification|cf_chl",
        )
        .expect("regex de desafio Cloudflare deve compilar")
    })
}

/// Detecta se a resposta HTTP é um desafio Cloudflare.
///
/// Critérios (qualquer um basta):
/// - Header `cf-mitigated` com valor `challenge`
/// - Body contém padrão regex de desafio (case insensitive)
///
/// O parâmetro `status` é incluído para compatibilidade com o contrato,
/// mas a detecção atual não filtra por status (desafio pode vir com 403 ou 503).
pub fn is_cloudflare_challenge(
    _status: u16,
    headers: &reqwest::header::HeaderMap,
    body: &str,
) -> bool {
    // 1. Header `cf-mitigated: challenge`
    if let Some(value) = headers.get("cf-mitigated") {
        if let Ok(v) = value.to_str() {
            if v.eq_ignore_ascii_case("challenge") {
                return true;
            }
        }
    }

    // 2. Regex no body
    challenge_body_regex().is_match(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderMap;

    fn make_headers() -> HeaderMap {
        HeaderMap::new()
    }

    #[test]
    fn detects_just_a_moment() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            403,
            &headers,
            "<html><body>Just a moment, please...</body></html>"
        ));
    }

    #[test]
    fn detects_cf_chl() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            503,
            &headers,
            r#"<form action="/cf-chl-2"></form>"#
        ));
    }

    #[test]
    fn detects_cf_chl_underscore() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            403,
            &headers,
            r#"<input name="__cf_chl" value="abc" />"#
        ));
    }

    #[test]
    fn detects_challenge_platform() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            403,
            &headers,
            r#"<div id="challenge-platform"></div>"#
        ));
    }

    #[test]
    fn detects_cf_browser_verification() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            403,
            &headers,
            r#"<div id="cf-browser-verification"></div>"#
        ));
    }

    #[test]
    fn detects_cf_chl_underscore_variant() {
        let headers = make_headers();
        assert!(is_cloudflare_challenge(
            403,
            &headers,
            r#"<script>var cf_chl_tk="abc";</script>"#
        ));
    }

    #[test]
    fn detects_cf_mitigated_header() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-mitigated", "challenge".parse().unwrap());
        assert!(is_cloudflare_challenge(200, &headers, "<html>ok</html>"));
    }

    #[test]
    fn detects_cf_mitigated_header_case_insensitive() {
        let mut headers = HeaderMap::new();
        headers.insert("cf-mitigated", "Challenge".parse().unwrap());
        assert!(is_cloudflare_challenge(200, &headers, "<html>ok</html>"));
    }

    #[test]
    fn no_challenge_in_clean_body() {
        let headers = make_headers();
        assert!(!is_cloudflare_challenge(
            200,
            &headers,
            "<html><body><h1>Bem-vindo</h1><p>Conteúdo normal.</p></body></html>"
        ));
    }

    #[test]
    fn no_challenge_with_empty_body() {
        let headers = make_headers();
        assert!(!is_cloudflare_challenge(200, &headers, ""));
    }

    #[test]
    fn no_challenge_with_unrelated_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "text/html".parse().unwrap());
        assert!(!is_cloudflare_challenge(200, &headers, "<html>ok</html>"));
    }
}
