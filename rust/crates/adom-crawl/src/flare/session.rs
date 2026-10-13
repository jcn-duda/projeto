//! Sessões do FlareSolverr por hostname — reuso de cookies e User-Agent.
//! Porte fiel de `resolvers/flare.ts` (FlareSessions map).

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Sessão ativa do FlareSolverr para um hostname.
/// Contém cookies de desafio resolvidos e o User-Agent do browser.
#[derive(Debug, Clone)]
pub struct FlareSession {
    /// Cookies concatenados: `"cf_clearance=xxx; __cf_bm=yyy"`.
    pub cookies: String,
    /// User-Agent do browser usado pelo FlareSolverr.
    pub user_agent: String,
    /// Momento em que a sessão expira.
    pub expires_at: Instant,
}

impl FlareSession {
    /// Cria uma sessão que expira em `ttl` a partir de agora.
    pub fn new(cookies: String, user_agent: String, ttl: Duration) -> Self {
        Self {
            cookies,
            user_agent,
            expires_at: Instant::now() + ttl,
        }
    }

    /// Verdadeiro se a sessão ainda é válida.
    pub fn is_valid(&self) -> bool {
        Instant::now() < self.expires_at
    }
}

/// Mapa de sessões ativas por hostname.
/// Permite reuso de cookies `cf_clearance` entre requisições ao mesmo host.
pub struct FlareSessions {
    sessions: HashMap<String, FlareSession>,
    session_ttl: Duration,
}

impl FlareSessions {
    /// Cria um mapa vazio com o TTL configurado.
    pub fn new(session_ttl_ms: u64) -> Self {
        Self {
            sessions: HashMap::new(),
            session_ttl: Duration::from_millis(session_ttl_ms),
        }
    }

    /// TTL configurado (para criação de novas sessões).
    pub fn session_ttl(&self) -> Duration {
        self.session_ttl
    }

    /// Retorna a sessão do hostname, se existir e não estiver expirada.
    pub fn get(&self, hostname: &str) -> Option<&FlareSession> {
        self.sessions.get(hostname).filter(|s| s.is_valid())
    }

    /// Armazena uma sessão para um hostname.
    pub fn store(&mut self, hostname: String, session: FlareSession) {
        self.sessions.insert(hostname, session);
    }

    /// Armazena a mesma sessão para múltiplos hostnames.
    /// Útil quando o pedido foi para um host mas a resolução DNS foi para outro.
    pub fn store_for_hosts(&mut self, hosts: Vec<String>, session: FlareSession) {
        for host in hosts {
            self.sessions.insert(host, session.clone());
        }
    }

    /// Remove todas as sessões.
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// Remove sessões expiradas do mapa.
    pub fn remove_expired(&mut self) {
        self.sessions.retain(|_, s| s.is_valid());
    }

    /// Quantidade de sessões armazenadas (incluindo expiradas).
    pub fn len(&self) -> usize {
        self.sessions.len()
    }

    /// Verdadeiro se não há sessões armazenadas.
    pub fn is_empty(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// Monta os headers HTTP a partir de uma sessão ativa.
/// Se existe sessão válida para o hostname da URL, retorna Cookie + User-Agent.
/// Senão, retorna HashMap vazio.
pub fn build_flare_headers(sessions: &FlareSessions, url: &str) -> HashMap<String, String> {
    let hostname = match extract_hostname(url) {
        Some(h) => h,
        None => return HashMap::new(),
    };

    match sessions.get(&hostname) {
        Some(session) => {
            let mut headers = HashMap::with_capacity(2);
            headers.insert("Cookie".to_string(), session.cookies.clone());
            headers.insert("User-Agent".to_string(), session.user_agent.clone());
            headers
        }
        None => HashMap::new(),
    }
}

/// Extrai o hostname de uma URL.
fn extract_hostname(url: &str) -> Option<String> {
    // Usa o crate `url` para parsing robusto.
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_is_valid_before_expiry() {
        let s = FlareSession::new(
            "cf_clearance=abc".into(),
            "Mozilla/5.0".into(),
            Duration::from_secs(60),
        );
        assert!(s.is_valid());
    }

    #[test]
    fn session_expires_after_ttl() {
        let s = FlareSession::new(
            "cf_clearance=abc".into(),
            "Mozilla/5.0".into(),
            Duration::from_millis(1),
        );
        // Aguarda o TTL expirar.
        std::thread::sleep(Duration::from_millis(5));
        assert!(!s.is_valid());
    }

    #[test]
    fn sessions_store_and_get() {
        let mut map = FlareSessions::new(60_000);
        let session = FlareSession::new(
            "cf_clearance=xyz".into(),
            "TestUA/1.0".into(),
            Duration::from_secs(60),
        );
        map.store("example.com".into(), session);
        assert!(map.get("example.com").is_some());
        assert!(map.get("other.com").is_none());
    }

    #[test]
    fn sessions_get_returns_none_for_expired() {
        let mut map = FlareSessions::new(60_000);
        let session = FlareSession::new(
            "cf_clearance=xyz".into(),
            "TestUA/1.0".into(),
            Duration::from_millis(1),
        );
        map.store("example.com".into(), session);
        std::thread::sleep(Duration::from_millis(5));
        assert!(map.get("example.com").is_none());
    }

    #[test]
    fn sessions_store_for_hosts_maps_multiple() {
        let mut map = FlareSessions::new(60_000);
        let session = FlareSession::new(
            "cf_clearance=abc".into(),
            "TestUA/1.0".into(),
            Duration::from_secs(60),
        );
        map.store_for_hosts(
            vec!["requested.com".into(), "resolved.com".into()],
            session,
        );
        assert!(map.get("requested.com").is_some());
        assert!(map.get("resolved.com").is_some());
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn sessions_clear_removes_all() {
        let mut map = FlareSessions::new(60_000);
        map.store(
            "a.com".into(),
            FlareSession::new("".into(), "".into(), Duration::from_secs(60)),
        );
        map.store(
            "b.com".into(),
            FlareSession::new("".into(), "".into(), Duration::from_secs(60)),
        );
        assert_eq!(map.len(), 2);
        map.clear();
        assert!(map.is_empty());
    }

    #[test]
    fn sessions_remove_expired_keeps_valid() {
        let mut map = FlareSessions::new(60_000);
        map.store(
            "expired.com".into(),
            FlareSession::new("".into(), "".into(), Duration::from_millis(1)),
        );
        map.store(
            "valid.com".into(),
            FlareSession::new("".into(), "".into(), Duration::from_secs(60)),
        );
        std::thread::sleep(Duration::from_millis(5));
        map.remove_expired();
        assert!(map.get("expired.com").is_none());
        assert!(map.get("valid.com").is_some());
    }

    #[test]
    fn build_flare_headers_with_active_session() {
        let mut map = FlareSessions::new(60_000);
        map.store(
            "example.com".into(),
            FlareSession::new(
                "cf_clearance=abc; __cf_bm=def".into(),
                "FlareUA/5.0".into(),
                Duration::from_secs(60),
            ),
        );
        let headers = build_flare_headers(&map, "https://example.com/page");
        assert_eq!(headers.get("Cookie").unwrap(), "cf_clearance=abc; __cf_bm=def");
        assert_eq!(headers.get("User-Agent").unwrap(), "FlareUA/5.0");
    }

    #[test]
    fn build_flare_headers_without_session() {
        let map = FlareSessions::new(60_000);
        let headers = build_flare_headers(&map, "https://example.com/page");
        assert!(headers.is_empty());
    }

    #[test]
    fn build_flare_headers_with_expired_session() {
        let mut map = FlareSessions::new(60_000);
        map.store(
            "example.com".into(),
            FlareSession::new(
                "cf_clearance=abc".into(),
                "FlareUA/5.0".into(),
                Duration::from_millis(1),
            ),
        );
        std::thread::sleep(Duration::from_millis(5));
        let headers = build_flare_headers(&map, "https://example.com/page");
        assert!(headers.is_empty());
    }

    #[test]
    fn extract_hostname_from_valid_url() {
        assert_eq!(
            extract_hostname("https://www.Example.COM/path"),
            Some("www.example.com".into())
        );
    }

    #[test]
    fn extract_hostname_from_invalid_url() {
        assert_eq!(extract_hostname("not a url"), None);
    }
}
