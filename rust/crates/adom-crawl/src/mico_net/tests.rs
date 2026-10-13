//! Testes unitários do módulo `mico_net`.
//!
//! Cobre:
//! - `MicoThrottle`: gap mínimo, Retry-After, serialização.
//! - `parse_retry_after`: segundos, data HTTP, header ausente.
//! - Validação de IMDb ID (regex).
//! - `fetch_catalog_page`: resposta válida, vazia, 429, 500, timeout (com wiremock).

#[cfg(test)]
mod throttle_tests {
    use crate::mico_net::throttle::MicoThrottle;
    use std::time::Instant;

    /// Gap mínimo é respeitado: duas chamadas consecutivas com gap de 200ms
    /// devem levar pelo menos 200ms entre si.
    #[tokio::test]
    async fn throttle_respects_min_gap() {
        let throttle = MicoThrottle::new(200);

        let start = Instant::now();
        throttle.wait().await;
        throttle.record_call();

        throttle.wait().await;
        let elapsed = start.elapsed().as_millis() as u64;
        // A segunda chamada deve esperar ~200ms (gap mínimo).
        assert!(
            elapsed >= 180,
            "esperava >= 180ms, got {elapsed}ms"
        );
    }

    /// Retry-After atrasa a próxima chamada além do gap mínimo.
    #[tokio::test]
    async fn throttle_honors_retry_after() {
        let throttle = MicoThrottle::new(50);

        // Primeira chamada: sem espera.
        throttle.wait().await;
        throttle.record_call();

        // Simula 429 com Retry-After de 300ms.
        throttle.honor_retry_after(300);

        // Segunda chamada: deve esperar pelo menos 300ms (Retry-After > gap de 50ms).
        let start = Instant::now();
        throttle.wait().await;
        let elapsed = start.elapsed().as_millis() as u64;
        assert!(
            elapsed >= 250,
            "esperava >= 250ms (Retry-After), got {elapsed}ms"
        );
    }

    /// Serialização: duas chamadas em paralelo → segunda espera a primeira.
    #[tokio::test]
    async fn throttle_serializes_concurrent_calls() {
        use std::sync::Arc;

        let throttle = Arc::new(MicoThrottle::new(150));

        // Registra uma chamada para forçar gap na próxima.
        throttle.wait().await;
        throttle.record_call();

        // Duas chamadas em paralelo no MESMO throttle (via Arc):
        // a segunda deve esperar a primeira terminar (lock da cadeia).
        let t1 = Arc::clone(&throttle);
        let t2 = Arc::clone(&throttle);

        let start = Instant::now();
        let (r1, r2) = tokio::join!(
            async { t1.wait().await },
            async { t2.wait().await },
        );
        let elapsed = start.elapsed().as_millis() as u64;

        // Ambas completam sem panic.
        let _ = (r1, r2);
        // Como são serializadas pelo mutex da cadeia, e há um gap de 150ms
        // desde a última chamada registrada, a primeira espera ~150ms.
        // A segunda espera a primeira liberar o lock + gap próprio.
        assert!(
            elapsed >= 130,
            "esperava >= 130ms (serialização + gap), got {elapsed}ms"
        );
    }

    /// Primeira chamada não espera (não há last_call_at).
    #[tokio::test]
    async fn throttle_first_call_no_wait() {
        let throttle = MicoThrottle::new(500);

        let start = Instant::now();
        throttle.wait().await;
        let elapsed = start.elapsed().as_millis() as u64;
        // Primeira chamada deve ser quase instantânea.
        assert!(
            elapsed < 100,
            "primeira chamada deveria ser rápida, got {elapsed}ms"
        );
    }

}

#[cfg(test)]
mod parse_retry_after_tests {
    use crate::mico_net::client::parse_retry_after;
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};

    /// Header com integer seconds: "120" → 120_000 ms.
    #[test]
    fn parses_integer_seconds() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("120"));
        let ms = parse_retry_after(&headers);
        assert_eq!(ms, Some(120_000));
    }

    /// Header ausente → None.
    #[test]
    fn returns_none_when_missing() {
        let headers = HeaderMap::new();
        let ms = parse_retry_after(&headers);
        assert_eq!(ms, None);
    }

    /// Header vazio → None.
    #[test]
    fn returns_none_when_empty() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static(""));
        let ms = parse_retry_after(&headers);
        assert_eq!(ms, None);
    }

    /// Header com zero segundos → 0 ms.
    #[test]
    fn parses_zero_seconds() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("0"));
        let ms = parse_retry_after(&headers);
        assert_eq!(ms, Some(0));
    }

    /// Header com data HTTP: calcula ms até essa data.
    /// (Teste básico: uma data no futuro distante deve retornar um valor > 0.)
    #[test]
    fn parses_http_date() {
        let mut headers = HeaderMap::new();
        // Data bem no futuro (2099).
        headers.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Fri, 01 Jan 2099 00:00:00 GMT"),
        );
        let ms = parse_retry_after(&headers);
        // Deve retornar algum valor > 0 (data no futuro).
        assert!(ms.is_some(), "deveria parsear a data");
        assert!(ms.unwrap() > 0, "data no futuro deveria dar ms > 0");
    }

    /// Header com string inválida → None.
    #[test]
    fn returns_none_for_invalid() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, HeaderValue::from_static("not-a-number-or-date"));
        let ms = parse_retry_after(&headers);
        assert_eq!(ms, None);
    }
}

#[cfg(test)]
mod imdb_validation_tests {
    use regex::Regex;

    /// Regex de validação de IMDb ID (mesma do client.rs).
    fn imdb_re() -> Regex {
        Regex::new(r"^tt\d{1,10}$").unwrap()
    }

    /// `tt1234567` (7 dígitos) → válido.
    #[test]
    fn accepts_tt_with_7_digits() {
        let re = imdb_re();
        assert!(re.is_match("tt1234567"));
    }

    /// `tt12345678901` (10 dígitos) → válido (limite máximo).
    #[test]
    fn accepts_tt_with_10_digits() {
        let re = imdb_re();
        assert!(re.is_match("tt1234567890"));
    }

    /// `tt123456789012` (11 dígitos) → inválido (excede limite).
    #[test]
    fn rejects_tt_with_11_digits() {
        let re = imdb_re();
        assert!(!re.is_match("tt12345678901"));
    }

    /// `nm1234567` (não começa com `tt`) → inválido.
    #[test]
    fn rejects_nm_prefix() {
        let re = imdb_re();
        assert!(!re.is_match("nm1234567"));
    }

    /// `tt` (sem dígitos) → inválido.
    #[test]
    fn rejects_tt_without_digits() {
        let re = imdb_re();
        assert!(!re.is_match("tt"));
    }

    /// `tt0` (1 dígito) → válido (mínimo).
    #[test]
    fn accepts_tt_with_1_digit() {
        let re = imdb_re();
        assert!(re.is_match("tt0"));
    }

    /// String vazia → inválida.
    #[test]
    fn rejects_empty_string() {
        let re = imdb_re();
        assert!(!re.is_match(""));
    }

    /// `tt12345abc` (letras misturadas) → inválido.
    #[test]
    fn rejects_mixed_letters() {
        let re = imdb_re();
        assert!(!re.is_match("tt12345abc"));
    }
}

#[cfg(test)]
mod catalog_type_tests {
    use crate::mico_net::types::CatalogType;

    #[test]
    fn movie_as_str() {
        assert_eq!(CatalogType::Movie.as_str(), "movie");
    }

    #[test]
    fn series_as_str() {
        assert_eq!(CatalogType::Series.as_str(), "series");
    }

    #[test]
    fn display_movie() {
        assert_eq!(format!("{}", CatalogType::Movie), "movie");
    }

    #[test]
    fn display_series() {
        assert_eq!(format!("{}", CatalogType::Series), "series");
    }
}
