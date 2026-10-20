//! Cliente HTTP do scraper BLUDV (busca por título WordPress).
//!
//! - fail-open → `[]` (rede/timeout/layout quebrado nunca panic); o caminho
//!   vivo usa [`BludvOutcome`] para separar ok/empty/failed;
//! - protetor legado (`systemads`/`videosad`) resolvido sob o prazo;
//! - gate de anúncio detectado e **pulado** no caminho de busca (orçamento
//!   0 ms no TS; sem cache de gate nesta fatia);
//! - **todo** hop (base, post, protetor, redirect) passa por
//!   `is_safe_download_url`;
//! - redirect `follow` como o `fetch` do TS, mas MANUAL: o reqwest com
//!   `Policy::none()` não segue sozinho, então cada `Location` é validado;
//! - concorrência limitada (`BLUDV_CONCURRENCY`, default 6) em posts e links,
//!   preservando a ordem do documento;
//! - `raw:v1` com a MESMA chave/valor do Node (`raw:v1:bludv:d|t:<q>` e
//!   `{items}`), lido/gravado só fora do `read_only`.

use std::sync::Arc;

use adom_core::{cache_key, is_safe_download_url};
use reqwest::header::{ACCEPT, LOCATION, REFERER, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, StatusCode, Url};
use tokio::task::JoinSet;

use crate::cache::RawStore;
use crate::http::{now_ms, remaining};

use super::config::{BludvConfig, BLUDV_USER_AGENT};
use super::parse::{
    extract_magnet, has_ad_gate, is_gate_url, is_valid_magnet_uri, parse_download_links,
    parse_posts, parse_size, release_title,
};
use super::types::{BludvDownloadLink, BludvOutcome, BludvPost, BludvRawItem, BludvSearchOpts};

/// Teto de redirects por hop (o `fetch` do Node usa 20).
const MAX_REDIRECTS: usize = 20;

/// Erro de transporte do hop. HTTP não-2xx mantém o status (quem chama decide
/// `live.empty` × `live.failed`); bloqueio/SSRF é falha local, nunca redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
enum FetchError {
    Blocked(String),
    Budget,
    Http(u16),
    Network(String),
    Timeout,
    TooManyRedirects,
}

impl FetchError {
    fn describe(&self) -> String {
        match self {
            FetchError::Blocked(url) => {
                let preview: String = url.chars().take(120).collect();
                format!("URL bloqueada pela guarda SSRF: {preview}")
            }
            FetchError::Budget => "orçamento esgotado".into(),
            FetchError::Http(status) => format!("HTTP {status}"),
            FetchError::Network(err) => format!("rede: {err}"),
            FetchError::Timeout => "prazo esgotado".into(),
            FetchError::TooManyRedirects => "redirects demais".into(),
        }
    }
}

/// Resultado cru de um hop.
enum Exchange {
    Text(String),
    Http(u16),
    Redirect(Option<String>),
}

/// Lote de UM post: itens + se ele é incompleto (gate/anúncio).
struct PostChunk {
    items: Vec<BludvRawItem>,
    incomplete: bool,
}

/// Cliente BLUDV reutilizável.
#[derive(Clone)]
pub struct BludvClient {
    config: Arc<BludvConfig>,
    http: Client,
    raw_store: Option<Arc<dyn RawStore>>,
}

impl BludvClient {
    pub fn new(config: BludvConfig) -> Result<Self, String> {
        // `Policy::none()` de propósito: o redirect é seguido por [`Self::get_text`]
        // com a guarda SSRF em CADA hop. Deixar o reqwest seguir sozinho
        // atravessaria um `Location` privado sem validação.
        let http = Client::builder()
            .user_agent(BLUDV_USER_AGENT)
            .redirect(Policy::none())
            .build()
            .map_err(|err| format!("cliente HTTP BLUDV: {err}"))?;
        Ok(Self {
            config: Arc::new(config),
            http,
            raw_store: None,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(BludvConfig::from_env())
    }

    /// Injeta o store do `raw:v1` (compartilhado com o Node no gateway). Sem
    /// ele o caminho vivo continua funcionando, só sem cache bruto.
    pub fn with_raw_store(mut self, store: Arc<dyn RawStore>) -> Self {
        self.raw_store = Some(store);
        self
    }

    pub fn config(&self) -> &BludvConfig {
        &self.config
    }

    /// Busca por título, fail-open (só os itens). [`Self::search_outcome`]
    /// preserva o motivo da falha para o `live` da fonte.
    pub async fn search(&self, query: &str, opts: &BludvSearchOpts) -> Vec<BludvRawItem> {
        match self.search_outcome(query, opts).await {
            BludvOutcome::Ok(items) => items,
            BludvOutcome::Disabled | BludvOutcome::BlockedUrl => Vec::new(),
            BludvOutcome::Http(status) => {
                eprintln!("[bludv] HTTP {status}");
                Vec::new()
            }
            BludvOutcome::Failed(err) => {
                eprintln!("[bludv] {err}");
                Vec::new()
            }
        }
    }

    /// Desfecho tipado da consulta (caminho vivo e sombra usam o mesmo parse).
    pub async fn search_outcome(&self, query: &str, opts: &BludvSearchOpts) -> BludvOutcome {
        if !self.config.enabled || query.trim().is_empty() {
            return BludvOutcome::Disabled;
        }
        if !self.config.base_url_allowed() {
            eprintln!("[bludv] BLUDV_URL bloqueada pela guarda SSRF");
            return BludvOutcome::BlockedUrl;
        }

        // WordPress BR engasga com ":".
        let q = query.replace(':', " ");
        let q = collapse_ws(&q);
        if q.is_empty() {
            return BludvOutcome::Disabled;
        }

        let cache_key = raw_cache_key(&q, opts.dubbed_only);
        if !opts.read_only {
            if let Some(items) = self.read_cache(&cache_key) {
                return BludvOutcome::Ok(items);
            }
        }

        let deadline = now_ms() + self.config.timeout_ms as i64;
        let Some(search_url) = search_page_url(&self.config.base_url, &q) else {
            return BludvOutcome::Failed("URL de busca inválida".into());
        };
        let html = match self.get_text(search_url.as_str(), None, deadline).await {
            Ok(html) => html,
            Err(err) => return outcome_from_fetch(err),
        };

        let posts: Vec<BludvPost> = parse_posts(&html)
            .into_iter()
            .take(self.config.max_posts)
            .collect();
        let (items, incomplete, gate_posts) = self.collect_posts(&posts, opts, deadline).await;

        if !opts.read_only
            && self.config.raw_cache_enabled()
            && !incomplete
            && items.len() <= self.config.raw_max_items
        {
            let ttl = if items.is_empty() {
                self.config.raw_empty_ttl
            } else {
                self.config.raw_ttl_br
            };
            if ttl > 0 {
                if let Some(store) = &self.raw_store {
                    let value = serde_json::json!({ "items": &items });
                    store.set(&cache_key, &value, ttl, now_ms());
                }
            }
        }

        eprintln!(
            "[bludv] {} post(s) → {} magnet(s){}",
            posts.len(),
            items.len(),
            if gate_posts > 0 {
                format!(
                    " [portão de anúncio em {gate_posts}/{} post(s)]",
                    posts.len()
                )
            } else {
                String::new()
            }
        );
        BludvOutcome::Ok(items)
    }

    fn read_cache(&self, key: &str) -> Option<Vec<BludvRawItem>> {
        if !self.config.raw_cache_enabled() {
            return None;
        }
        let store = self.raw_store.as_ref()?;
        let value = store.get(key, now_ms())?;
        let items = value.get("items")?.as_array()?;
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(serde_json::from_value::<BludvRawItem>(item.clone()).ok()?);
        }
        Some(out)
    }

    /// Posts com concorrência limitada e ordem do documento preservada.
    async fn collect_posts(
        &self,
        posts: &[BludvPost],
        opts: &BludvSearchOpts,
        deadline: i64,
    ) -> (Vec<BludvRawItem>, bool, usize) {
        let limit = self.config.concurrency.max(1);
        let mut results: Vec<Option<Result<PostChunk, String>>> =
            (0..posts.len()).map(|_| None).collect();
        let mut set: JoinSet<(usize, Result<PostChunk, String>)> = JoinSet::new();
        let mut next = 0usize;

        while next < posts.len() && set.len() < limit {
            spawn_post(&mut set, self, next, posts[next].clone(), *opts, deadline);
            next += 1;
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((index, result)) => results[index] = Some(result),
                // Panic de uma task: o lote fica incompleto e o post é dropado,
                // como o `onItemError: 'drop'` do Node.
                Err(err) => {
                    eprintln!("[bludv] post abortado: {err}");
                }
            }
            if next < posts.len() {
                spawn_post(&mut set, self, next, posts[next].clone(), *opts, deadline);
                next += 1;
            }
        }

        let mut items = Vec::new();
        let mut incomplete = false;
        let mut gate_posts = 0usize;
        for result in results.into_iter() {
            match result {
                Some(Ok(chunk)) => {
                    incomplete |= chunk.incomplete;
                    if chunk.incomplete {
                        gate_posts += 1;
                    }
                    items.extend(chunk.items);
                }
                Some(Err(err)) => {
                    incomplete = true;
                    eprintln!("[bludv] post: {err}");
                }
                None => incomplete = true,
            }
        }
        (items, incomplete, gate_posts)
    }

    async fn collect_post(
        &self,
        post: &BludvPost,
        opts: &BludvSearchOpts,
        deadline: i64,
    ) -> Result<PostChunk, String> {
        let html = self
            .get_text(&post.url, Some(&self.config.base_url), deadline)
            .await
            .map_err(|err| err.describe())?;
        let mut links = parse_download_links(&html);
        // Gate: detecta e descarta (sem solve de anúncio no caminho de busca).
        let had_gate = has_ad_gate(&html) || links.iter().any(|l| is_gate_url(&l.url, &post.url));
        if had_gate {
            eprintln!("[bludv] portão de anúncio ativo — {}", post.url);
        }
        links.retain(|l| !is_gate_url(&l.url, &post.url));
        if opts.dubbed_only {
            links.retain(|l| l.audio != "legendado");
        }
        links.truncate(self.config.max_links_per_post);

        let items = self
            .resolve_links(&links, &post.title, &post.url, deadline)
            .await;
        Ok(PostChunk {
            items,
            incomplete: had_gate,
        })
    }

    /// Links de UM post com concorrência limitada e ordem preservada.
    async fn resolve_links(
        &self,
        links: &[BludvDownloadLink],
        post_title: &str,
        referer: &str,
        deadline: i64,
    ) -> Vec<BludvRawItem> {
        let limit = self.config.concurrency.max(1);
        let mut results: Vec<Option<Option<BludvRawItem>>> = vec![None; links.len()];
        let mut set: JoinSet<(usize, Option<BludvRawItem>)> = JoinSet::new();
        let mut next = 0usize;

        while next < links.len() && set.len() < limit {
            spawn_link(
                &mut set,
                self,
                next,
                links[next].clone(),
                post_title.to_string(),
                referer.to_string(),
                deadline,
            );
            next += 1;
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((index, item)) => results[index] = Some(item),
                Err(err) => eprintln!("[bludv] link abortado: {err}"),
            }
            if next < links.len() {
                spawn_link(
                    &mut set,
                    self,
                    next,
                    links[next].clone(),
                    post_title.to_string(),
                    referer.to_string(),
                    deadline,
                );
                next += 1;
            }
        }
        results.into_iter().flatten().flatten().collect()
    }

    async fn resolve_link(
        &self,
        link: &BludvDownloadLink,
        post_title: &str,
        referer: &str,
        deadline: i64,
    ) -> Option<BludvRawItem> {
        let magnet = self.resolve_magnet(link, referer, deadline).await?;
        Some(BludvRawItem {
            title: release_title(post_title, link),
            magnet,
            seeders: 1.0,
            size: link.size.as_deref().and_then(parse_size),
            tracker: "BLUDV".into(),
            audio: link.audio.clone(),
            is_br: true,
        })
    }

    async fn resolve_magnet(
        &self,
        link: &BludvDownloadLink,
        referer: &str,
        deadline: i64,
    ) -> Option<String> {
        if is_valid_magnet_uri(&link.url) {
            return Some(link.url.clone());
        }
        let html = self
            .get_text(&link.url, Some(referer), deadline)
            .await
            .ok()?;
        extract_magnet(&html)
    }

    /// GET de HTML seguindo redirects MANUALMENTE, com a guarda SSRF em cada
    /// hop e o prazo absoluto compartilhado entre eles.
    async fn get_text(
        &self,
        url: &str,
        referer: Option<&str>,
        deadline: i64,
    ) -> Result<String, FetchError> {
        let mut current = url.to_string();
        for hop in 0..=MAX_REDIRECTS {
            // Guarda SSRF em CADA hop — post/protetor/redirect são HTML de terceiro.
            if !fetch_url_allowed(&current, &self.config) {
                return Err(FetchError::Blocked(current));
            }
            let Some(budget) = remaining(deadline) else {
                return Err(FetchError::Budget);
            };
            let mut request = self
                .http
                .get(&current)
                .header(ACCEPT, "text/html,application/xhtml+xml")
                .header(USER_AGENT, BLUDV_USER_AGENT)
                .timeout(budget);
            if let Some(r) = referer {
                request = request.header(REFERER, r);
            }
            let exchange = async move {
                let response = request.send().await.map_err(|e| e.to_string())?;
                let status = response.status();
                if status.is_redirection() {
                    let target = response
                        .headers()
                        .get(LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    return Ok::<Exchange, String>(Exchange::Redirect(target));
                }
                if !status.is_success() {
                    return Ok(Exchange::Http(status.as_u16()));
                }
                response
                    .text()
                    .await
                    .map(Exchange::Text)
                    .map_err(|e| e.to_string())
            };
            match tokio::time::timeout(budget, exchange).await {
                Ok(Ok(Exchange::Text(text))) => return Ok(text),
                Ok(Ok(Exchange::Http(status))) => return Err(FetchError::Http(status)),
                Ok(Ok(Exchange::Redirect(target))) => {
                    let Some(location) = target else {
                        // 3xx sem Location: não há para onde ir.
                        return Err(FetchError::Http(StatusCode::FOUND.as_u16()));
                    };
                    let base =
                        Url::parse(&current).map_err(|err| FetchError::Network(err.to_string()))?;
                    let next = base
                        .join(&location)
                        .map_err(|err| FetchError::Network(err.to_string()))?;
                    if next.scheme() != "http" && next.scheme() != "https" {
                        return Err(FetchError::Blocked(next.to_string()));
                    }
                    if hop == MAX_REDIRECTS {
                        return Err(FetchError::TooManyRedirects);
                    }
                    current = next.to_string();
                }
                Ok(Err(err)) => return Err(FetchError::Network(err)),
                Err(_) => return Err(FetchError::Timeout),
            }
        }
        Err(FetchError::TooManyRedirects)
    }
}

fn spawn_post(
    set: &mut JoinSet<(usize, Result<PostChunk, String>)>,
    client: &BludvClient,
    index: usize,
    post: BludvPost,
    opts: BludvSearchOpts,
    deadline: i64,
) {
    let client = client.clone();
    set.spawn(async move {
        let result = client.collect_post(&post, &opts, deadline).await;
        (index, result)
    });
}

fn spawn_link(
    set: &mut JoinSet<(usize, Option<BludvRawItem>)>,
    client: &BludvClient,
    index: usize,
    link: BludvDownloadLink,
    post_title: String,
    referer: String,
    deadline: i64,
) {
    let client = client.clone();
    set.spawn(async move {
        let item = client
            .resolve_link(&link, &post_title, &referer, deadline)
            .await;
        (index, item)
    });
}

/// Status HTTP → desfecho vivo: 429/5xx é falha; 4xx é host vivo sem resposta
/// para esta obra (vazio suspeito, como o 4xx do Prowlarr/Torrentio).
fn outcome_from_fetch(err: FetchError) -> BludvOutcome {
    match err {
        FetchError::Http(status) => BludvOutcome::Http(status),
        other => BludvOutcome::Failed(other.describe()),
    }
}

/// Chave do `raw:v1` idêntica à do Node (`bludv.ts:197`).
fn raw_cache_key(query: &str, dubbed_only: bool) -> String {
    cache_key(
        "raw",
        &["bludv", if dubbed_only { "d" } else { "t" }, query],
    )
}

fn search_page_url(base: &str, query: &str) -> Option<Url> {
    let base = base.trim_end_matches('/');
    let mut url = Url::parse(&format!("{base}/")).ok()?;
    url.query_pairs_mut().append_pair("s", query);
    Some(url)
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// URL permitida para fetch BLUDV?
///
/// Usa o mesmo `is_safe_download_url` do Jackett. A flag `allow_private_url`
/// só amplia a **origem da base** (loopback de teste / instalador) — HTML do
/// post (e o `Location` de um redirect) não pode puxar `169.254.169.254` ou
/// outro privado arbitrário.
fn fetch_url_allowed(url: &str, cfg: &BludvConfig) -> bool {
    if url.is_empty() {
        return false;
    }
    if is_safe_download_url(url, false) {
        return true;
    }
    cfg.allow_private_url && is_safe_download_url(url, true) && same_origin(url, &cfg.base_url)
}

fn same_origin(url: &str, base: &str) -> bool {
    let Ok(target) = Url::parse(url) else {
        return false;
    };
    let Ok(base) = Url::parse(base) else {
        return false;
    };
    target.scheme() == base.scheme()
        && target.host_str() == base.host_str()
        && target.port_or_known_default() == base.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn search_url_encode_query() {
        let url = search_page_url("https://bludv.example", "Chefão Parte II").unwrap();
        assert!(url.as_str().contains("s=Chef"));
        assert!(url.query().unwrap().contains("s="));
    }

    #[test]
    fn deadline_helper_zero() {
        assert!(remaining(now_ms() - 1).is_none());
    }

    #[test]
    fn fetch_url_allowed_publico_e_origem() {
        let cfg = BludvConfig {
            allow_private_url: true,
            base_url: "http://127.0.0.1:9".into(),
            ..BludvConfig::default()
        };
        assert!(fetch_url_allowed("https://cdn.example/systemads/a", &cfg));
        assert!(fetch_url_allowed("http://127.0.0.1:9/filme/x", &cfg));
        // Privado fora da origem da base — HTML injetado/redirect não passa.
        assert!(!fetch_url_allowed(
            "http://169.254.169.254/systemads/meta",
            &cfg
        ));
        assert!(!fetch_url_allowed("http://127.0.0.1:99/systemads/x", &cfg));
        assert!(!fetch_url_allowed("file:///etc/passwd", &cfg));
    }

    #[test]
    fn chave_do_raw_v1_igual_ao_node() {
        assert_eq!(
            raw_cache_key("Coringa 2019", true),
            "raw:v1:bludv:d:Coringa 2019"
        );
        assert_eq!(
            raw_cache_key("Coringa 2019", false),
            "raw:v1:bludv:t:Coringa 2019"
        );
    }

    /// Hop privado fora da origem → Err sem GET (fail-open).
    #[tokio::test]
    async fn hop_inseguro_sem_get() {
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_h = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind trap");
        let addr = listener.local_addr().expect("addr");
        let trap_url = format!("http://{addr}/systemads/ssrf-bait");
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else {
                    break;
                };
                hits_h.fetch_add(1, Ordering::SeqCst);
                let _ = sock.try_write(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
            }
        });

        let client = BludvClient::new(BludvConfig {
            enabled: true,
            base_url: "https://bludv.example".into(),
            max_posts: 3,
            max_links_per_post: 12,
            concurrency: 6,
            timeout_ms: 500,
            allow_private_url: false,
            ..BludvConfig::default()
        })
        .expect("client");

        let err = client
            .get_text(&trap_url, None, now_ms() + 1_000)
            .await
            .expect_err("loopback deve ser barrado");
        assert!(
            err.describe().contains("guarda SSRF"),
            "erro esperado de SSRF, obteve: {err:?}"
        );
        // Pequena folga: se o GET tivesse saído, o accept já teria incrementado.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "GET não pode ter atingido o trap"
        );
    }

    #[tokio::test]
    async fn esquema_nao_http_sem_get() {
        let client = BludvClient::new(BludvConfig {
            enabled: true,
            base_url: "https://bludv.example".into(),
            max_posts: 3,
            max_links_per_post: 12,
            concurrency: 6,
            timeout_ms: 500,
            allow_private_url: true, // mesmo com privado liberado, file:// cai
            ..BludvConfig::default()
        })
        .expect("client");
        let err = client
            .get_text("file:///etc/passwd", None, now_ms() + 1_000)
            .await
            .expect_err("file:// deve ser barrado");
        assert!(err.describe().contains("guarda SSRF"), "obteve: {err:?}");
    }
}
