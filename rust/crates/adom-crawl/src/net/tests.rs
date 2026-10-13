//! Testes unitários do módulo de rede.
//!
//! Foco nas funções puras (allowlist, cookie_jar) que não precisam de mock
//! HTTP. Testes de integração do redirect chain ficam para o CLI ou harness.

#[cfg(test)]
#[allow(clippy::module_inception)]
mod tests {
    use std::collections::HashMap;

    use crate::net::allowlist::Allowlist;
    use crate::net::cookie_jar::CookieJar;
    use crate::net::types::CrawlFetchError;

    // ── Allowlist ──────────────────────────────────────────────────────

    fn test_allowlist() -> Allowlist {
        Allowlist::new(
            vec!["vaqueirofilmes1.com".into()],
            vec!["systemads1.com".into(), "temreceita.com".into()],
            vec!["t.co".into(), "vacadb.org".into()],
        )
    }

    #[test]
    fn allowlist_host_exato() {
        let al = test_allowlist();
        assert!(al.has_allowed_host("vaqueirofilmes1.com"));
        assert!(al.has_allowed_host("systemads1.com"));
        assert!(al.has_allowed_host("t.co"));
    }

    #[test]
    fn allowlist_subdominio() {
        let al = test_allowlist();
        assert!(al.has_allowed_host("www.vaqueirofilmes1.com"));
        assert!(al.has_allowed_host("sub.systemads1.com"));
    }

    #[test]
    fn allowlist_host_bloqueado() {
        let al = test_allowlist();
        assert!(!al.has_allowed_host("malicioso.com"));
        assert!(!al.has_allowed_host("evil.systemads1.com.evil.com"));
    }

    #[test]
    fn allowlist_assert_valida_http() {
        let al = test_allowlist();
        let url = al.assert_allowed_url("https://vaqueirofilmes1.com/filme/123");
        assert!(url.is_ok());
        assert_eq!(url.unwrap().host_str(), Some("vaqueirofilmes1.com"));
    }

    #[test]
    fn allowlist_assert_bloqueia_ftp() {
        let al = test_allowlist();
        let err = al
            .assert_allowed_url("ftp://vaqueirofilmes1.com/file")
            .unwrap_err();
        assert!(matches!(err, CrawlFetchError::UnsupportedProtocol));
    }

    #[test]
    fn allowlist_assert_bloqueia_host_desconhecido() {
        let al = test_allowlist();
        let err = al
            .assert_allowed_url("https://malicioso.com/phish")
            .unwrap_err();
        assert!(matches!(err, CrawlFetchError::BlockedHost { .. }));
    }

    #[test]
    fn allowlist_assert_bloqueia_url_invalida() {
        let al = test_allowlist();
        let err = al.assert_allowed_url("not a url").unwrap_err();
        assert!(matches!(err, CrawlFetchError::InvalidUrl));
    }

    #[test]
    fn allowlist_is_detail_host() {
        let al = test_allowlist();
        assert!(al.is_detail_host("vaqueirofilmes1.com"));
        assert!(al.is_detail_host("www.vaqueirofilmes1.com"));
        // Protetor NÃO é detail host.
        assert!(!al.is_detail_host("systemads1.com"));
        // Assert-only NÃO é detail host.
        assert!(!al.is_detail_host("t.co"));
    }

    #[test]
    fn allowlist_is_protector_host() {
        let al = test_allowlist();
        assert!(al.is_protector_host("systemads1.com"));
        assert!(al.is_protector_host("temreceita.com"));
        assert!(!al.is_protector_host("vaqueirofilmes1.com"));
    }

    #[test]
    fn allowlist_is_assert_only_host() {
        let al = test_allowlist();
        assert!(al.is_assert_only_host("t.co"));
        assert!(al.is_assert_only_host("vacadb.org"));
        assert!(!al.is_assert_only_host("systemads1.com"));
    }

    #[test]
    fn allowlist_all_suffixes() {
        let al = test_allowlist();
        let all = al.all_suffixes();
        assert_eq!(all.len(), 5);
        assert!(all.contains(&"vaqueirofilmes1.com"));
        assert!(all.contains(&"systemads1.com"));
        assert!(all.contains(&"t.co"));
    }

    #[test]
    fn allowlist_normaliza_minusculas_e_deduplica() {
        let al = Allowlist::new(
            vec!["Example.COM".into(), "example.com".into()],
            vec!["  ".into()],
            vec![],
        );
        // "example.com" deve aparecer uma vez só.
        assert_eq!(al.all_suffixes().len(), 1);
        assert!(al.has_allowed_host("example.com"));
    }

    // ── CookieJar ──────────────────────────────────────────────────────

    #[test]
    fn cookie_jar_store_and_restore() {
        let mut jar = CookieJar::new();
        // Simula harvest: parseia raw Set-Cookie.
        jar.parse_and_store("systemads1.com", "session=abc; Path=/; HttpOnly");
        let header = jar.headers_for("systemads1.com");
        assert_eq!(header, Some("session=abc".into()));
    }

    #[test]
    fn cookie_jar_mesmo_hostname_reenvia() {
        let mut jar = CookieJar::new();
        jar.parse_and_store("systemads1.com", "token=xyz; Path=/");
        // Mesmo hostname → envia.
        assert!(jar.headers_for("systemads1.com").is_some());
        // Case-insensitive.
        assert!(jar.headers_for("SystemAds1.COM").is_some());
    }

    #[test]
    fn cookie_jar_hostname_diferente_nao_envia() {
        let mut jar = CookieJar::new();
        jar.parse_and_store("systemads1.com", "token=xyz");
        // Host diferente → NÃO envia.
        assert!(jar.headers_for("temreceita.com").is_none());
    }

    #[test]
    fn cookie_jar_com_seed() {
        // O seed é um mapa `host → "nome=valor"` (UM par por entrada, como no TS).
        // Múltiplos cookies para o mesmo host exigem múltiplas entradas ou
        // parseamento via `parse_and_store` com string separada por `,`.
        let mut seed = HashMap::new();
        seed.insert("vacadb.org".into(), "enc_liberado=1".into());
        let jar = CookieJar::with_seed(seed);
        let header = jar.headers_for("vacadb.org");
        assert!(header.is_some());
        let h = header.unwrap();
        assert!(h.contains("enc_liberado=1"));
    }

    #[test]
    fn cookie_jar_seed_nao_vaza_para_outro_host() {
        let mut seed = HashMap::new();
        seed.insert("vacadb.org".into(), "enc_liberado=1".into());
        let jar = CookieJar::with_seed(seed);
        assert!(jar.headers_for("systemads1.com").is_none());
    }

    #[test]
    fn cookie_jar_multiplos_cookies() {
        let mut jar = CookieJar::new();
        jar.parse_and_store("systemads1.com", "session=abc; Path=/, theme=dark; Path=/");
        let header = jar.headers_for("systemads1.com").unwrap();
        assert!(header.contains("session=abc"));
        assert!(header.contains("theme=dark"));
    }

    #[test]
    fn cookie_jar_valor_com_igual() {
        let mut jar = CookieJar::new();
        jar.parse_and_store("host.com", "token=abc=def; Path=/");
        let header = jar.headers_for("host.com").unwrap();
        // O valor deve conter o "=" extra.
        assert!(header.contains("token=abc=def"));
    }

    #[test]
    fn cookie_jar_vazio_retorna_none() {
        let jar = CookieJar::new();
        assert!(jar.headers_for("qualquer.com").is_none());
    }

    // ── CrawlFetchError Display ────────────────────────────────────────

    #[test]
    fn error_display_messages() {
        assert_eq!(CrawlFetchError::InvalidUrl.to_string(), "invalid_url");
        assert_eq!(
            CrawlFetchError::UnsupportedProtocol.to_string(),
            "unsupported_protocol"
        );
        assert_eq!(
            CrawlFetchError::BlockedHost {
                host: "evil.com".into()
            }
            .to_string(),
            "blocked_host:evil.com"
        );
        assert_eq!(
            CrawlFetchError::HttpError { status: 404 }.to_string(),
            "http_404"
        );
        assert_eq!(CrawlFetchError::Timeout.to_string(), "timeout");
        assert_eq!(
            CrawlFetchError::TooManyRedirects.to_string(),
            "too_many_redirects"
        );
    }
}
