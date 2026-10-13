//! Seletor de domínio com failover para resolvers BR.
//!
//! Port de `resolvers/site-selector.ts`. Mantém lista de URLs candidatas
//! (primary + CSV do .env + fallbacks) e faz probe quando o site falha N
//! vezes consecutivas, trocando para o primeiro candidato que responder OK.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::Client;
use url::Url;

/// User-Agent usado no probe (mesmo do TS `USER_AGENT`).
const PROBE_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";

/// Timeout do probe individual (ms).
const PROBE_TIMEOUT_MS: u64 = 5_000;

/// Opções configuráveis do seletor.
#[derive(Debug, Clone)]
pub struct SiteSelectorOptions {
    /// TTL entre probes consecutivos (ms). Default: 30 min.
    pub probe_ttl_ms: u64,
    /// Falhas consecutivas antes de disparar probe. Default: 2.
    pub fails_before_probe: u32,
}

impl Default for SiteSelectorOptions {
    fn default() -> Self {
        Self {
            probe_ttl_ms: 30 * 60_000,
            fails_before_probe: 2,
        }
    }
}

/// Estado interno mutável do seletor (protegido por Mutex).
struct Inner {
    /// URL ativa atual.
    current: String,
    /// Contador de falhas consecutivas.
    consecutive_fails: u32,
    /// Instant do último probe (para TTL).
    last_probe_at: Option<Instant>,
    /// Listener de mudança de domínio.
    change_listeners: Vec<Box<dyn Fn(&str) + Send + Sync>>,
}

/// Seletor de domínio com failover automático.
///
/// Quando o site ativo falha N vezes consecutivas, faz probe em cada
/// candidato com `GET /?s=teste` e troca para o primeiro que responder OK.
pub struct SiteSelector {
    /// Rótulo do seletor (ex.: nome do site) para logs.
    tag: String,
    /// URLs candidatas (deduplicadas, ordem: primary, CSV, fallbacks).
    candidates: Vec<String>,
    /// Estado mutável compartilhado.
    inner: Arc<Mutex<Inner>>,
    /// TTL entre probes.
    probe_ttl_ms: u64,
    /// Falhas antes de probe.
    fails_before_probe: u32,
}

impl SiteSelector {
    /// Cria um novo seletor com a lista de candidatos deduplicada.
    ///
    /// `candidates` deve vir na ordem de preferência: primary, CSV, fallbacks.
    /// URLs vazias são ignoradas; duplicatas são removidas (mantém a primeira).
    pub fn new(tag: &str, candidates: Vec<String>, options: Option<SiteSelectorOptions>) -> Self {
        let opts = options.unwrap_or_default();

        // Deduplica candidatos mantendo ordem.
        let mut seen = std::collections::HashSet::new();
        let unique: Vec<String> = candidates
            .into_iter()
            .filter(|u| !u.is_empty() && seen.insert(u.clone()))
            .collect();

        let current = unique.first().cloned().unwrap_or_default();

        Self {
            tag: tag.to_string(),
            candidates: unique,
            inner: Arc::new(Mutex::new(Inner {
                current,
                consecutive_fails: 0,
                last_probe_at: None,
                change_listeners: Vec::new(),
            })),
            probe_ttl_ms: opts.probe_ttl_ms,
            fails_before_probe: opts.fails_before_probe,
        }
    }

    /// Retorna o domínio ativo atual.
    pub fn url(&self) -> String {
        self.inner.lock().unwrap().current.clone()
    }

    /// Retorna todos os hosts candidatos (hostnames únicos, sem esquema).
    pub fn hosts(&self) -> Vec<String> {
        let mut seen = std::collections::HashSet::new();
        self.candidates
            .iter()
            .filter_map(|u| parse_host(u))
            .filter(|h| seen.insert(h.clone()))
            .collect()
    }

    /// Registra falha. Se atingir o threshold e o TTL expirou, faz probe.
    ///
    /// Retorna a URL ativa após o processamento (pode ter mudado se o probe
    /// encontrou um candidato melhor).
    pub async fn note_failure(&self) -> String {
        // Incrementa contador.
        {
            let mut inner = self.inner.lock().unwrap();
            inner.consecutive_fails += 1;
        }

        // Verifica se deve fazer probe.
        let should_probe = {
            let inner = self.inner.lock().unwrap();
            if inner.consecutive_fails < self.fails_before_probe {
                return inner.current.clone();
            }
            if let Some(last) = inner.last_probe_at {
                if last.elapsed() < Duration::from_millis(self.probe_ttl_ms) {
                    return inner.current.clone();
                }
            }
            self.candidates.len() > 1
        };

        if !should_probe {
            return self.inner.lock().unwrap().current.clone();
        }

        // Faz probe.
        if let Some(winner) = self.probe().await {
            let mut inner = self.inner.lock().unwrap();
            inner.last_probe_at = Some(Instant::now());
            inner.consecutive_fails = 0;

            if winner != inner.current {
                let old = inner.current.clone();
                inner.current = winner.clone();
                // Notifica listeners fora do lock seria ideal, mas para
                // simplicidade e segurança (evitar deadlock) notificamos aqui.
                for listener in &inner.change_listeners {
                    listener(&winner);
                }
                eprintln!(
                    "[{}] domínio ativo mudou: {} → {}",
                    self.tag,
                    old,
                    winner
                );
            }
            inner.current.clone()
        } else {
            let mut inner = self.inner.lock().unwrap();
            inner.last_probe_at = Some(Instant::now());
            inner.consecutive_fails = 0;
            inner.current.clone()
        }
    }

    /// Registra sucesso: zera o contador de falhas consecutivas.
    pub fn note_success(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.consecutive_fails = 0;
    }

    /// Registra um callback para quando o domínio ativo mudar.
    pub fn on_domain_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) {
        let mut inner = self.inner.lock().unwrap();
        inner.change_listeners.push(listener);
    }

    /// Tenta cada candidato com `GET /?s=teste` e retorna o primeiro que
    /// responder com status OK (2xx).
    async fn probe(&self) -> Option<String> {
        let client = Client::builder()
            .timeout(Duration::from_millis(PROBE_TIMEOUT_MS))
            .build()
            .ok()?;

        for url in &self.candidates {
            let probe_url = format!("{}/?s=teste", url.trim_end_matches('/'));
            let result = client
                .get(&probe_url)
                .header("User-Agent", PROBE_USER_AGENT)
                .header("Accept", "text/html,application/xhtml+xml")
                .send()
                .await;

            if let Ok(resp) = result {
                if resp.status().is_success() {
                    return Some(url.clone());
                }
            }
        }
        None
    }
}

/// Extrai o hostname de uma URL (lowercase).
///
/// Porta de `parseHost` do TS (`new URL(s).hostname.toLowerCase()`).
fn parse_host(url_str: &str) -> Option<String> {
    Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
}

/// Classifica se uma mensagem de erro é erro de rede (vs. erro de lógica).
///
/// Port de `isNetworkError` do TS. Prefixos excluídos (não são rede):
/// `http_`, `blocked_host`, `unsupported_protocol`, `missing_redirect`,
/// `not_detail_page`, `no_magnet`, `too_many_redirects` + `extra_excluded`.
///
/// Retorna `true` se a mensagem NÃO começa com nenhum dos prefixos excluídos.
pub fn is_network_error(message: &str, extra_excluded: &str) -> bool {
    if message.is_empty() {
        return false;
    }

    let excluded_prefixes = [
        "http_",
        "blocked_host",
        "unsupported_protocol",
        "missing_redirect",
        "not_detail_page",
        "no_magnet",
        "too_many_redirects",
    ];

    // Verifica se começa com algum prefixo excluído fixo.
    for prefix in &excluded_prefixes {
        if message.starts_with(prefix) {
            return false;
        }
    }

    // Verifica prefixos extras (separados por '|').
    if !extra_excluded.is_empty() {
        for prefix in extra_excluded.split('|') {
            let trimmed = prefix.trim();
            if !trimmed.is_empty() && message.starts_with(trimmed) {
                return false;
            }
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_returns_first_candidate() {
        let selector = SiteSelector::new(
            "test",
            vec![
                "https://site1.com".into(),
                "https://site2.com".into(),
            ],
            None,
        );
        assert_eq!(selector.url(), "https://site1.com");
    }

    #[test]
    fn note_success_resets_counter() {
        let selector = SiteSelector::new(
            "test",
            vec!["https://site1.com".into()],
            Some(SiteSelectorOptions {
                fails_before_probe: 3,
                ..Default::default()
            }),
        );

        // Simula falhas (sem probe real, só 1 candidato).
        let inner = selector.inner.clone();
        {
            let mut i = inner.lock().unwrap();
            i.consecutive_fails = 2;
        }
        selector.note_success();
        let i = inner.lock().unwrap();
        assert_eq!(i.consecutive_fails, 0);
    }

    #[tokio::test]
    async fn note_failure_below_threshold_no_probe() {
        let selector = SiteSelector::new(
            "test",
            vec![
                "https://site1.com".into(),
                "https://site2.com".into(),
            ],
            Some(SiteSelectorOptions {
                fails_before_probe: 3,
                probe_ttl_ms: 1000,
            }),
        );

        // Primeira falha: não deve fazer probe (threshold = 3).
        let result = selector.note_failure().await;
        assert_eq!(result, "https://site1.com");

        let inner = selector.inner.lock().unwrap();
        assert_eq!(inner.consecutive_fails, 1);
        assert!(inner.last_probe_at.is_none());
    }

    #[test]
    fn hosts_returns_unique_hosts() {
        let selector = SiteSelector::new(
            "test",
            vec![
                "https://site1.com".into(),
                "https://site2.com".into(),
                "https://site1.com".into(), // duplicata
            ],
            None,
        );
        let hosts = selector.hosts();
        assert_eq!(hosts.len(), 2);
        assert!(hosts.contains(&"site1.com".to_string()));
        assert!(hosts.contains(&"site2.com".to_string()));
    }

    #[test]
    fn is_network_error_classifies_correctly() {
        // http_404 NÃO é erro de rede (é erro HTTP de lógica).
        assert!(!is_network_error("http_404 not found", ""));

        // ECONNRESET É erro de rede.
        assert!(is_network_error("ECONNRESET connection reset", ""));

        // blocked_host NÃO é erro de rede.
        assert!(!is_network_error("blocked_host not allowed", ""));

        // Timeout genérico É erro de rede.
        assert!(is_network_error("timeout exceeded", ""));

        // Mensagem vazia não é erro de rede.
        assert!(!is_network_error("", ""));

        // Prefixo extra personalizado.
        assert!(!is_network_error("custom_error something", "custom_error"));
        assert!(is_network_error("other_error something", "custom_error"));
    }

    #[test]
    fn on_domain_change_registers_listener() {
        let selector = SiteSelector::new(
            "test",
            vec!["https://site1.com".into()],
            None,
        );

        let called = Arc::new(Mutex::new(false));
        let called_clone = called.clone();
        selector.on_domain_change(Box::new(move |_url| {
            *called_clone.lock().unwrap() = true;
        }));

        let inner = selector.inner.lock().unwrap();
        assert_eq!(inner.change_listeners.len(), 1);
    }

    #[test]
    fn empty_candidates_handled_gracefully() {
        let selector = SiteSelector::new("test", vec![], None);
        assert_eq!(selector.url(), "");
        assert!(selector.hosts().is_empty());
    }

    #[test]
    fn parse_host_extracts_hostname() {
        assert_eq!(parse_host("https://Example.COM/path"), Some("example.com".into()));
        assert_eq!(parse_host("http://sub.site.org:8080"), Some("sub.site.org".into()));
        assert_eq!(parse_host("not-a-url"), None);
    }
}
