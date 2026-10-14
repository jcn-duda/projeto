//! Implementação de `ResolverCallbacks` para `ResolverProfile`.
//!
//! Separado de `profile.rs` pela catraca de 400 linhas. Cada método é a costura
//! entre o contrato HTTP do server (axum) e a lógica do profile: a busca devolve
//! um item por BOTÃO de post (`crate::items`) e a página/feed saem do formato do
//! site (`crate::sites`), o mesmo que a definição do Jackett lê do TS.

use std::collections::{HashMap, HashSet};

use adom_crawl::nested_url::{self, UnwrapSeed as NestedSeed};

use crate::common::SearchItem;
use crate::profile::ResolverProfile;
use crate::search_select;
use crate::server::{ResolverCallbacks, RouteSet, SearchItems, UnwrapSeed, UnwrappedUrl};
use crate::sites::site_output;

fn to_items(values: &SearchItems) -> Vec<SearchItem> {
    values
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect()
}

#[async_trait::async_trait]
impl ResolverCallbacks for ResolverProfile {
    async fn search(&self, q: &str) -> Result<SearchItems, String> {
        let items = self.search_items(q).await?;
        Ok(items
            .iter()
            .filter_map(|item| serde_json::to_value(item).ok())
            .collect())
    }

    fn render_html(&self, items: &SearchItems) -> String {
        self.render_items_html(&to_items(items))
    }

    async fn resolve_best(&self, url: &str) -> Result<String, String> {
        self.resolve_best_of(url).await
    }

    async fn resolve_button(
        &self,
        url: &str,
        index: usize,
        hash: Option<&str>,
        count: Option<&str>,
    ) -> Result<String, String> {
        self.resolve_button_of(url, index, hash, count).await
    }

    /// `unwrapResolverUrl` do site-profile: o Cardigann pode embrulhar o
    /// `/resolve` no próprio `/resolve` (até 3 saltos); os campos do nível mais
    /// interno vencem. Índice presente e não inteiro ≥ 0 é `invalid_index`.
    fn unwrap_resolver_url(&self, value: &str, seed: UnwrapSeed) -> Result<UnwrappedUrl, String> {
        let mut fields = HashMap::new();
        fields.insert("index".to_string(), seed.index);
        fields.insert("hash".to_string(), seed.hash);
        fields.insert("count".to_string(), seed.count);
        let out =
            nested_url::unwrap_resolver_url(value, &self.self_url, &NestedSeed { fields }, None);
        let field = |name: &str| {
            out.fields
                .get(name)
                .cloned()
                .flatten()
                .filter(|v| !v.is_empty())
        };
        let index = match field("index") {
            None => None,
            Some(raw) => Some(
                raw.trim()
                    .parse::<usize>()
                    .map_err(|_| "invalid_index".to_string())?,
            ),
        };
        Ok(UnwrappedUrl {
            url: out.url,
            index,
            hash: field("hash"),
            count: field("count"),
        })
    }

    /// `capsXml()` do profile; sem `/api` no TS a rota nem é registrada.
    fn caps_xml(&self) -> String {
        site_output(&self.site_name)
            .and_then(|s| s.caps_xml())
            .unwrap_or_default()
    }

    /// `emptyXml`: o feed do próprio site sem itens (o bludv fixa 2000).
    fn empty_xml(&self, category: u32, _type_: &str) -> String {
        site_output(&self.site_name)
            .and_then(|s| s.rss_xml(&self.self_url, &[], s.empty_feed_category(category)))
            .unwrap_or_default()
    }

    fn render_xml(&self, items: &SearchItems, category: u32) -> String {
        let mut items = to_items(items);
        if self.site_name == "nerdfilmes" {
            // `handleApi` do nerd: o mesmo botão de um post não repete no feed.
            let mut seen = HashSet::new();
            items.retain(|i| seen.insert(format!("{}|{}", i.post.url, i.link.url)));
        }
        self.render_items_xml(&items, category)
            .unwrap_or_else(|| self.empty_xml(category, ""))
    }

    fn routes(&self) -> RouteSet {
        site_output(&self.site_name).map_or(RouteSet::ALL, |s| s.routes())
    }

    /// O nerd decide o feed vazio pela query normalizada (`normalizeQuery`).
    fn api_query_is_empty(&self, q: &str) -> bool {
        if self.site_name == "nerdfilmes" {
            let rules = search_select::rules_for(&self.site_name);
            return search_select::normalize_query(q, rules).is_empty();
        }
        q.trim().is_empty()
    }
}
