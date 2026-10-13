//! Implementação de `ResolverCallbacks` para `ResolverProfile`.
//!
//! Separado de `profile.rs` pela catraca de 400 linhas. Cada método é a costura
//! entre o contrato HTTP do server (axum) e a lógica do profile: a busca devolve
//! um item por BOTÃO de post (`crate::items`) e a página/feed saem do formato do
//! site (`crate::sites`), o mesmo que a definição do Jackett lê do TS.

use std::collections::HashMap;

use adom_crawl::nested_url::{self, UnwrapSeed as NestedSeed};

use crate::common::SearchItem;
use crate::profile::ResolverProfile;
use crate::server::{ResolverCallbacks, SearchItems, UnwrapSeed, UnwrappedUrl};

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

    fn caps_xml(&self) -> String {
        r#"<?xml version="1.0" encoding="UTF-8"?>
<caps><server version="1.0"/><limits max="100" default="50"/>
<searching><search available="yes"/><tv-search available="yes"/></searching></caps>"#
            .to_string()
    }

    fn empty_xml(&self, _category: u32, _type_: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>{}</title><response offset="0" total="0"/></channel></rss>"#,
            self.site_name
        )
    }

    fn render_xml(&self, items: &SearchItems, category: u32) -> String {
        let items = to_items(items);
        self.render_items_xml(&items, category)
            .unwrap_or_else(|| self.empty_xml(category, ""))
    }
}
