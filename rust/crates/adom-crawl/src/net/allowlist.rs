//! Allowlist de hosts para o raspador de sites BR.
//!
//! Porta do `resolvers/protector.ts` + `resolvers/site-profile.ts`: três listas
//! de sufixos de domínio (candidatos, protetores e hosts-só-de-salto) validam
//! cada URL antes do fetch. Host fora da lista = `BlockedHost`.

use url::Url;

use crate::net::types::CrawlFetchError;

/// Allowlist de hosts confiáveis do raspador.
///
/// - `candidate_hosts`: domínios do site (ex: `vaqueirofilmes1.com`).
/// - `protector_suffixes`: protetores de link (ex: `systemads1.com`).
/// - `assert_only`: hosts só de passagem/salto (ex: `t.co`, `vacadb.org`).
///
/// A união dos três forma o conjunto total de sufixos permitidos.
#[derive(Debug, Clone)]
pub struct Allowlist {
    candidate_hosts: Vec<String>,
    protector_suffixes: Vec<String>,
    assert_only: Vec<String>,
    /// União deduplicada de todos os sufixos (candidate + protector + assert_only).
    all: Vec<String>,
}

impl Allowlist {
    /// Cria uma allowlist normalizada (minúsculas, sem vazios, sem repetições).
    pub fn new(
        candidate_hosts: Vec<String>,
        protector_suffixes: Vec<String>,
        assert_only: Vec<String>,
    ) -> Self {
        let candidate_hosts = normalize_suffixes(candidate_hosts);
        let protector_suffixes = normalize_suffixes(protector_suffixes);
        let assert_only = normalize_suffixes(assert_only);

        // União deduplicada preservando ordem de inserção.
        let mut all: Vec<String> = Vec::new();
        for s in candidate_hosts
            .iter()
            .chain(protector_suffixes.iter())
            .chain(assert_only.iter())
        {
            if !all.contains(s) {
                all.push(s.clone());
            }
        }

        Self {
            candidate_hosts,
            protector_suffixes,
            assert_only,
            all,
        }
    }

    /// Valida e parseia a URL: protocolo http/https e host na allowlist.
    ///
    /// Porta do `assertAllowedUrl` do `protector.ts`.
    pub fn assert_allowed_url(&self, value: &str) -> Result<Url, CrawlFetchError> {
        let url = Url::parse(value).map_err(|_| CrawlFetchError::InvalidUrl)?;

        let scheme = url.scheme();
        if scheme != "http" && scheme != "https" {
            return Err(CrawlFetchError::UnsupportedProtocol);
        }

        let host = url.host_str().unwrap_or("").to_lowercase();
        if !self.has_allowed_host(&host) {
            return Err(CrawlFetchError::BlockedHost { host });
        }

        Ok(url)
    }

    /// True quando o hostname casa com algum sufixo da allowlist total.
    ///
    /// Regra: `host == suffix || host.ends_with(".{suffix}")`.
    /// Porta do `hasAllowedHost` do `protector.ts`.
    pub fn has_allowed_host(&self, hostname: &str) -> bool {
        let host = hostname.to_lowercase();
        self.all
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    }

    /// True quando o hostname é um host candidato (domínio do site).
    ///
    /// Porta do `isDetailHost` do `site-profile.ts`.
    pub fn is_detail_host(&self, hostname: &str) -> bool {
        let host = hostname.to_lowercase();
        self.candidate_hosts
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    }

    /// True quando o hostname é um protetor de link.
    pub fn is_protector_host(&self, hostname: &str) -> bool {
        let host = hostname.to_lowercase();
        self.protector_suffixes
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    }

    /// True quando o hostname é host só de salto (assert_only).
    ///
    /// Porta do `isAssertOnlyHost` do `site-profile.ts`.
    pub fn is_assert_only_host(&self, hostname: &str) -> bool {
        let host = hostname.to_lowercase();
        self.assert_only
            .iter()
            .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
    }

    /// Todos os sufixos (candidate + protector + assert_only) como slice de refs.
    pub fn all_suffixes(&self) -> Vec<&str> {
        self.all.iter().map(|s| s.as_str()).collect()
    }
}

/// Normaliza sufixos: trim, minúsculas, descarta vazios e repetições.
///
/// Porta do `normalizeHostSuffixes` do `protector.ts`.
fn normalize_suffixes(input: Vec<String>) -> Vec<String> {
    let mut seen = Vec::new();
    for part in input {
        let normalized = part.trim().to_lowercase();
        if !normalized.is_empty() && !seen.contains(&normalized) {
            seen.push(normalized);
        }
    }
    seen
}
