//! Cliente HTTP do scraper BLUDV (busca por título WordPress).
//!
//! - fail-open → `[]` (rede/timeout/layout quebrado nunca panic);
//! - protetor legado (`systemads`/`videosad`) resolvido sob o prazo;
//! - gate de anúncio detectado e **pulado** no caminho de busca (orçamento
//!   0 ms no TS; sem cache de gate nesta fatia);
//! - **todo** hop (base, post, protetor) passa por `is_safe_download_url`;
//! - `redirect: none` — alinhado ao Jackett; sem seguir hops cegos.

use std::sync::Arc;

use adom_core::is_safe_download_url;
use reqwest::header::{ACCEPT, REFERER, USER_AGENT};
use reqwest::redirect::Policy;
use reqwest::{Client, Url};

use super::config::{BludvConfig, BLUDV_USER_AGENT};
use super::parse::{
    extract_magnet, is_gate_url, is_valid_magnet_uri, parse_download_links, parse_posts, parse_size,
    release_title,
};
use super::types::{BludvDownloadLink, BludvPost, BludvRawItem, BludvSearchOpts};
use crate::http::{now_ms, remaining};

/// Cliente BLUDV reutilizável.
#[derive(Clone)]
pub struct BludvClient {
    config: Arc<BludvConfig>,
    http: Client,
}

impl BludvClient {
    pub fn new(config: BludvConfig) -> Result<Self, String> {
        // Mesma régua do download Jackett: nunca seguir redirect automático.
        let http = Client::builder()
            .user_agent(BLUDV_USER_AGENT)
            .redirect(Policy::none())
            .build()
            .map_err(|err| format!("cliente HTTP BLUDV: {err}"))?;
        Ok(Self {
            config: Arc::new(config),
            http,
        })
    }

    pub fn from_env() -> Result<Self, String> {
        Self::new(BludvConfig::from_env())
    }

    pub fn config(&self) -> &BludvConfig {
        &self.config
    }

    /// Busca por título. Fail-open: sempre `Vec`.
    pub async fn search(&self, query: &str, opts: &BludvSearchOpts) -> Vec<BludvRawItem> {
        if !self.config.enabled || query.trim().is_empty() {
            return Vec::new();
        }
        if !self.config.base_url_allowed() {
            eprintln!("[bludv] BLUDV_URL bloqueada pela guarda SSRF");
            return Vec::new();
        }

        // WordPress BR engasga com ":".
        let q = query.replace(':', " ");
        let q = collapse_ws(&q);
        if q.is_empty() {
            return Vec::new();
        }

        let deadline = now_ms() + self.config.timeout_ms as i64;
        let search_url = match search_page_url(&self.config.base_url, &q) {
            Some(u) => u,
            None => return Vec::new(),
        };

        let html = match self.get_text(search_url.as_str(), None, deadline).await {
            Ok(h) => h,
            Err(err) => {
                eprintln!("[bludv] {err}");
                return Vec::new();
            }
        };

        let posts: Vec<BludvPost> = parse_posts(&html)
            .into_iter()
            .take(self.config.max_posts)
            .collect();

        let mut items = Vec::new();
        for post in &posts {
            match self.collect_from_post(post, opts, deadline).await {
                Ok(chunk) => items.extend(chunk),
                Err(err) => {
                    eprintln!("[bludv] post {}: {err}", post.url);
                }
            }
        }

        eprintln!(
            "[bludv] {} post(s) → {} magnet(s)",
            posts.len(),
            items.len()
        );
        items
    }

    async fn collect_from_post(
        &self,
        post: &BludvPost,
        opts: &BludvSearchOpts,
        deadline: i64,
    ) -> Result<Vec<BludvRawItem>, String> {
        let html = self
            .get_text(&post.url, Some(&self.config.base_url), deadline)
            .await?;
        let mut links = parse_download_links(&html);
        // Gate: detecta e descarta (sem solve de anúncio no caminho de busca).
        let had_gate = links
            .iter()
            .any(|l| is_gate_url(&l.url, &post.url));
        if had_gate {
            eprintln!("[bludv] portão de anúncio ativo — {}", post.url);
        }
        links.retain(|l| !is_gate_url(&l.url, &post.url));
        if opts.dubbed_only {
            links.retain(|l| l.audio != "legendado");
        }
        links.truncate(self.config.max_links_per_post);

        let mut out = Vec::new();
        for link in links {
            if now_ms() >= deadline {
                break;
            }
            match self.resolve_magnet(&link, &post.url, deadline).await {
                Some(magnet) => {
                    out.push(BludvRawItem {
                        title: release_title(&post.title, &link),
                        magnet,
                        seeders: 1.0,
                        size: link.size.as_deref().and_then(parse_size),
                        tracker: "BLUDV".into(),
                        audio: link.audio.clone(),
                        is_br: true,
                    });
                }
                None => continue,
            }
        }
        Ok(out)
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
        let html = self.get_text(&link.url, Some(referer), deadline).await.ok()?;
        extract_magnet(&html)
    }

    async fn get_text(
        &self,
        url: &str,
        referer: Option<&str>,
        deadline: i64,
    ) -> Result<String, String> {
        // Guarda SSRF em CADA hop — post/protetor são HTML de terceiro.
        if !fetch_url_allowed(url, &self.config) {
            let preview: String = url.chars().take(160).collect();
            return Err(format!("bludv: URL bloqueada pela guarda SSRF: {preview}"));
        }
        let Some(budget) = remaining(deadline) else {
            return Err("bludv: orçamento esgotado".into());
        };
        let mut request = self
            .http
            .get(url)
            .header(ACCEPT, "text/html,application/xhtml+xml")
            .header(USER_AGENT, BLUDV_USER_AGENT)
            .timeout(budget);
        if let Some(r) = referer {
            request = request.header(REFERER, r);
        }
        let exchange = async move {
            let response = request.send().await.map_err(|e| e.to_string())?;
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status().as_u16()));
            }
            response.text().await.map_err(|e| e.to_string())
        };
        match tokio::time::timeout(budget, exchange).await {
            Ok(Ok(text)) => Ok(text),
            Ok(Err(err)) => Err(err),
            Err(_) => Err("bludv: prazo esgotado".into()),
        }
    }
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
/// post não pode puxar `169.254.169.254` ou outro privado arbitrário.
fn fetch_url_allowed(url: &str, cfg: &BludvConfig) -> bool {
    if url.is_empty() {
        return false;
    }
    if is_safe_download_url(url, false) {
        return true;
    }
    cfg.allow_private_url
        && is_safe_download_url(url, true)
        && same_origin(url, &cfg.base_url)
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
    use std::sync::Arc;

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
        // Privado fora da origem da base — HTML injetado não passa.
        assert!(!fetch_url_allowed(
            "http://169.254.169.254/systemads/meta",
            &cfg
        ));
        assert!(!fetch_url_allowed("http://127.0.0.1:99/systemads/x", &cfg));
        assert!(!fetch_url_allowed("file:///etc/passwd", &cfg));
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
        })
        .expect("client");

        let err = client
            .get_text(&trap_url, None, now_ms() + 1_000)
            .await
            .expect_err("loopback deve ser barrado");
        assert!(
            err.contains("guarda SSRF"),
            "erro esperado de SSRF, obteve: {err}"
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
        })
        .expect("client");
        let err = client
            .get_text("file:///etc/passwd", None, now_ms() + 1_000)
            .await
            .expect_err("file:// deve ser barrado");
        assert!(err.contains("guarda SSRF"), "obteve: {err}");
    }
}
