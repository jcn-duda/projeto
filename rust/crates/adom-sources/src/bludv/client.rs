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
//!   `{items}`), lido/gravado no caminho vivo.

use std::sync::Arc;

use adom_core::cache_key;
use reqwest::redirect::Policy;
use reqwest::{Client, Url};

use crate::cache::RawStore;
use crate::http::now_ms;

use super::config::{BludvConfig, BLUDV_USER_AGENT};
use super::parse::parse_posts;
use super::types::{BludvOutcome, BludvPost, BludvRawItem, BludvSearchOpts};

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

    /// Desfecho tipado da consulta (o caminho vivo usa o mesmo parse).
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
        if let Some(items) = self.read_cache(&cache_key) {
            return BludvOutcome::Ok(items);
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

        if self.config.raw_cache_enabled()
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

// Hop HTTP (redirect manual com guarda SSRF em cada `Location`).
#[path = "client_fetch.rs"]
mod fetch;

// Coleta de posts/links com concorrência limitada.
#[path = "client_posts.rs"]
mod posts;
use posts::outcome_from_fetch;

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
