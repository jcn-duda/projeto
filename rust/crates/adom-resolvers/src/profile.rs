//! Factory de profile: conecta o servidor HTTP (`adom-resolvers`) aos módulos de
//! rede, cache e protetor do `adom-crawl`. Cada profile (comandotorrents,
//! apachetorrent, ...) recebe um [`SiteSelector`] (failover de domínio), dois
//! [`ResolverCache`] (listagem e posts), [`HttpSession`] para sites PHP e o
//! protetor de link até o magnet. Hosts, sufixos, timeout, saltos e User-Agent
//! vêm do registry do crawl (`adom_crawl::site_profiles`) — nada é duplicado.

use std::collections::HashMap;
use std::time::Duration;

use adom_crawl::http_session::HttpSession;
use adom_crawl::net::{fetch_follow_redirects, Allowlist, FetchRedirectsOptions};
use adom_crawl::protector::{self, FollowOptions};
use adom_crawl::resolver_cache::ResolverCache;
use adom_crawl::resolver_site_selector::{is_network_error, SiteSelector};
use adom_crawl::site_profiles::{
    all_site_configs, site_network_config, SiteNetworkConfig, BASE_PROTECTOR_SUFFIXES,
};
use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};
use url::Url;

use crate::listing_parsers;

/// Entradas máximas do cache de listagem por profile.
pub const SEARCH_CACHE_LIMIT: usize = 60;
pub const POST_CACHE_LIMIT: usize = 200;
/// TTL da listagem (ms); curto porque uma falha de fetch fica retida até expirar.
pub const SEARCH_TTL_MS: i64 = 5 * 60_000;
pub const POST_TTL_MS: i64 = 30 * 60_000;
const HTML_ACCEPT: &str = "text/html,application/xhtml+xml";

/// Post extraído da listagem de busca (nome herdado de `resolvers/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolverPost {
    pub title: String,
    pub url: String,
}

/// Profile de um resolver BR. É `Send + Sync`, então `Arc<ResolverProfile>` cabe
/// no `State` do axum.
pub struct ResolverProfile {
    pub site_name: String,
    pub site_url: String,
    pub selector: SiteSelector,
    pub search_cache: ResolverCache<String>,
    pub post_cache: ResolverCache<String>,
    /// Cookies de sessão — só para sites PHP que os exigem (Apache).
    pub session: Option<HttpSession>,
    pub extra_protectors: Vec<String>,
    /// Rede do registry: sem ela `resolve()` não teria prazo nem User-Agent.
    pub network: SiteNetworkConfig,
    /// Allowlist derivada de `network` + `extra_protectors`, montada uma vez.
    pub allowlist: Allowlist,
}

impl ResolverProfile {
    /// Monta o profile: `site_name` é o id do registry (variantes sem o sufixo
    /// `-cardigann` funcionam) e `site_url` é a URL primária do operador.
    pub fn new(site_name: &str, site_url: &str, extra_protectors: Vec<String>) -> Self {
        let network = network_config_for(site_name);
        // A URL do operador vem antes dos hosts do registry: é ela que sabe qual
        // domínio responde hoje.
        let selector = SiteSelector::new(site_name, build_candidates(site_url, &network), None);
        let session = site_needs_session(site_name).then(HttpSession::new);
        let mut protector_suffixes = network.protector_suffixes.clone();
        // `Allowlist::new` normaliza e deduplica os sufixos — não precisa daqui.
        protector_suffixes.extend_from_slice(&extra_protectors);
        let allowlist = Allowlist::new(
            network.candidate_hosts.clone(),
            protector_suffixes,
            network.assert_only_suffixes.clone(),
        );
        Self {
            site_name: site_name.to_string(),
            site_url: site_url.trim().trim_end_matches('/').to_string(),
            selector,
            search_cache: ResolverCache::new(SEARCH_CACHE_LIMIT),
            post_cache: ResolverCache::new(POST_CACHE_LIMIT),
            session,
            extra_protectors,
            network,
            allowlist,
        }
    }

    /// Chave do cache de listagem para uma query.
    pub fn search_cache_key(query: &str) -> String {
        format!("search:{}", query.trim().to_lowercase())
    }

    /// URL de busca sobre o domínio **ativo** do seletor, no caminho `/?s=` do TS
    /// (`comandotorrents.ts:298`, `nerdfilmes.ts:281`); Apache e HDR têm caminho próprio.
    pub fn search_url(&self, query: &str) -> Result<String, String> {
        let base = self.selector.url();
        let mut url = Url::parse(&base).map_err(|_| format!("invalid_url:{base}"))?;
        url.set_path("/");
        // `query_pairs_mut` codifica a query; espaço vira `+` (o TS usa `%20`).
        url.query_pairs_mut().append_pair("s", query);
        Ok(url.to_string())
    }

    /// HTML da listagem de uma query.
    pub async fn search_html(&self, query: &str) -> Result<String, String> {
        let url = self.search_url(query)?;
        let key = Self::search_cache_key(query);
        self.cached_html(&self.search_cache, &key, SEARCH_TTL_MS, &url)
            .await
    }

    /// Busca posts de uma query (cache → fetch → parse → cache).
    pub async fn search(&self, query: &str) -> Result<Vec<ResolverPost>, String> {
        let html = self.search_html(query).await?;
        Ok(parse_search_posts(
            &self.site_name,
            &html,
            &self.selector.url(),
        ))
    }

    /// HTML de um post/página de download, com cache chaveado pela URL.
    pub async fn post_html(&self, url: &str) -> Result<String, String> {
        let key = format!("post:{url}");
        self.cached_html(&self.post_cache, &key, POST_TTL_MS, url)
            .await
    }

    /// Fetch de HTML com cache FIFO+TTL e coalescing de chamadas simultâneas.
    /// O loader do `ResolverCache` não tem canal de erro: uma falha gravaria
    /// string vazia como resposta válida, então descartamos o cache inteiro.
    async fn cached_html(
        &self,
        cache: &ResolverCache<String>,
        key: &str,
        ttl_ms: i64,
        url: &str,
    ) -> Result<String, String> {
        let owned = url.to_string();
        let html = cache
            .cached(key, ttl_ms, || async {
                self.fetch(&owned).await.unwrap_or_default()
            })
            .await;
        if html.is_empty() {
            cache.clear().await;
            return Err(format!("fetch_failed:{owned}"));
        }
        Ok(html)
    }

    /// Segue a cadeia de protetores até o magnet (`followProtectedUrl` do TS). A
    /// URL entra na allowlist ANTES do laço — no TS era o callback `assertAllowedUrl`.
    pub async fn resolve(&self, url: &str) -> Result<String, String> {
        let magnet_only = url.trim_start().to_ascii_lowercase().starts_with("magnet:");
        if !magnet_only {
            self.allowlist
                .assert_allowed_url(url)
                .map_err(|e| e.to_string())?;
        }
        let client = protector::build_protector_client().map_err(|e| e.to_string())?;
        let hosts = self.protector_hosts();
        // `suffixes` é o que DESCOBRE a URL do protetor no HTML; `protector_hosts`
        // é só o gate. Sem os extras aqui, um protetor novo nunca seria encontrado.
        let mut suffixes = self.network.protector_suffixes.clone();
        suffixes.extend_from_slice(&self.extra_protectors);
        let site_referer = self.selector.url();
        let referer = (!magnet_only).then_some(site_referer.as_str());
        protector::follow_protected_url(FollowOptions {
            url,
            referer,
            protector_hosts: &hosts,
            suffixes: &suffixes,
            max_hops: self.network.max_hops,
            timeout: Duration::from_millis(self.network.timeout_ms),
            user_agent: &self.network.user_agent,
            client: &client,
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// Hosts que o protetor aceita como destino de salto.
    fn protector_hosts(&self) -> Vec<String> {
        self.allowlist
            .all_suffixes()
            .into_iter()
            .map(String::from)
            .collect()
    }

    /// Fetch com allowlist por hop, cookies da sessão e contabilidade de failover.
    /// Usa `net::fetch_follow_redirects` porque os headers colhem o `Set-Cookie`.
    async fn fetch(&self, url: &str) -> Result<String, String> {
        let mut headers: HashMap<String, String> = HashMap::new();
        if let Some(session) = &self.session {
            let cookie = session.get_cookie_header();
            if !cookie.is_empty() {
                headers.insert("cookie".to_string(), cookie);
            }
        }
        let opts = FetchRedirectsOptions {
            timeout_ms: self.network.timeout_ms,
            max_hops: self.network.max_hops,
            allowlist: self.allowlist.clone(),
            user_agent: self.network.user_agent.clone(),
            accept: HTML_ACCEPT.to_string(),
            headers,
            cookie_jar: None,
            on_request: None,
        };
        match fetch_follow_redirects(url, opts).await {
            Ok(response) => {
                if !response.is_ok() {
                    let msg = format!("http_{}", response.status);
                    self.account_failure(&msg).await;
                    return Err(msg);
                }
                self.selector.note_success();
                self.harvest_cookies(&response.headers);
                Ok(response.body)
            }
            Err(err) => {
                // `CrawlFetchError` já emite os prefixos que `is_network_error` conhece.
                let msg = err.to_string();
                self.account_failure(&msg).await;
                Err(msg)
            }
        }
    }

    /// Erro de rede conta falha no seletor (dispara probe/troca de domínio); erro
    /// de lógica não derruba o domínio ativo.
    async fn account_failure(&self, message: &str) {
        if is_network_error(message, "") {
            self.selector.note_failure().await;
        } else {
            self.selector.note_success();
        }
    }

    /// Colhe `Set-Cookie`; `FetchResponse.headers` é `HashMap` e colapsa múltiplos.
    fn harvest_cookies(&self, headers: &HashMap<String, String>) {
        let Some(session) = &self.session else { return };
        if let Some(raw) = headers.get("set-cookie") {
            let mut header_map = HeaderMap::new();
            if let Ok(value) = HeaderValue::from_str(raw) {
                header_map.append(SET_COOKIE, value);
            }
            session.harvest_from_headers(&header_map);
        }
    }
}

/// Rede do site no registry, tolerando variantes: o registry usa ids como
/// `apachetorrent-cardigann`, o operador chama de `apachetorrent`.
fn network_config_for(site_name: &str) -> SiteNetworkConfig {
    if let Some(found) = lookup_site_config(site_name) {
        return found.clone();
    }
    // Site desconhecido: defaults do crawl + base de protetores compartilhada.
    let mut config = SiteNetworkConfig::new(site_name);
    config.protector_suffixes = BASE_PROTECTOR_SUFFIXES
        .iter()
        .map(|s| s.to_string())
        .collect();
    config
}

/// Busca no registry: nome exato → `nome-cardigann` → prefixo mais curto.
fn lookup_site_config(site_name: &str) -> Option<&'static SiteNetworkConfig> {
    let needle = site_name.trim().to_lowercase();
    if let Some(found) = site_network_config(&needle) {
        return Some(found);
    }
    if let Some(found) = site_network_config(&format!("{needle}-cardigann")) {
        return Some(found);
    }
    all_site_configs()
        .into_iter()
        .filter(|c| c.site_id.to_lowercase().starts_with(&needle))
        .min_by_key(|c| c.site_id.len())
}

/// Candidatos: URL do operador primeiro, depois hosts do registry, sem duplicar host.
fn build_candidates(site_url: &str, network: &SiteNetworkConfig) -> Vec<String> {
    let primary = site_url.trim().trim_end_matches('/');
    if primary.is_empty() {
        return Vec::new();
    }
    let primary_host = Url::parse(primary)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()));
    let mut candidates = vec![primary.to_string()];
    for host in &network.candidate_hosts {
        if primary_host.as_deref() != Some(host.as_str()) {
            candidates.push(format!("https://{host}"));
        }
    }
    candidates
}

/// Sites que precisam de sessão: ApacheTorrent exige PHPSESSID + token
/// (`apachetorrent.ts:12`). VacaTorrent usa cookies por *seed* (`vacatorrent.ts:285`).
fn site_needs_session(site_name: &str) -> bool {
    site_name.to_lowercase().contains("apache")
}

/// Converte o HTML da listagem em posts.
///
/// Delega ao parser do site correspondente em `listing_parsers`. Cada parser
/// extrai title + url (+ poster opcional) e filtra posts genéricos.
fn parse_search_posts(site_name: &str, html: &str, base_url: &str) -> Vec<ResolverPost> {
    listing_parsers::parse_listing_posts(site_name, html, base_url)
        .into_iter()
        .map(|p| ResolverPost {
            title: p.title,
            url: p.url,
        })
        .collect()
}

#[cfg(test)]
#[path = "profile_tests.rs"]
mod tests;
