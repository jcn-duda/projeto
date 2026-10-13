//! Implementação de `ResolverCallbacks` para `ResolverProfile`.
//!
//! Separado de `profile.rs` pela catraca de 400 linhas. Cada método é a costura
//! entre o contrato HTTP do server (axum) e a lógica de rede/cache/protetor do
//! profile. Parsers de listagem ainda não portados: `search` devolve JSON
//! básico e `render_html`/`render_xml` são templates mínimos.

use crate::profile::ResolverProfile;
use crate::server::{ResolverCallbacks, SearchItems, UnwrapSeed, UnwrappedUrl};

#[async_trait::async_trait]
impl ResolverCallbacks for ResolverProfile {
    async fn search(&self, q: &str) -> Result<SearchItems, String> {
        let posts = ResolverProfile::search(self, q).await?;
        Ok(posts
            .into_iter()
            .map(|p| serde_json::json!({ "title": p.title, "url": p.url }))
            .collect())
    }

    fn render_html(&self, items: &SearchItems) -> String {
        let mut html = String::from("<html><body>");
        for item in items {
            let title = item["title"].as_str().unwrap_or("");
            let url = item["url"].as_str().unwrap_or("");
            html.push_str(&format!(
                r#"<div class="release"><a href="{}">{}</a></div>"#,
                url, title
            ));
        }
        html.push_str("</body></html>");
        html
    }

    async fn resolve_best(&self, url: &str) -> Result<String, String> {
        ResolverProfile::resolve(self, url).await
    }

    async fn resolve_button(
        &self,
        url: &str,
        _index: usize,
        _hash: Option<&str>,
        _count: Option<&str>,
    ) -> Result<String, String> {
        // Sem parser de port ainda, resolve_best é o único caminho.
        ResolverProfile::resolve(self, url).await
    }

    fn unwrap_resolver_url(&self, value: &str, seed: UnwrapSeed) -> Result<UnwrappedUrl, String> {
        // Desempacotamento simples: sem aninhamento (o TS faz até 3 saltos).
        let index = seed.index.as_deref().and_then(|s| s.parse::<usize>().ok());
        Ok(UnwrappedUrl {
            url: value.to_string(),
            index,
            hash: seed.hash,
            count: seed.count,
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

    fn render_xml(&self, items: &SearchItems, _category: u32) -> String {
        let mut xml = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>{}</title>"#,
            self.site_name
        );
        for item in items {
            let title = item["title"].as_str().unwrap_or("");
            xml.push_str(&format!("<item><title>{title}</title></item>"));
        }
        xml.push_str("</channel></rss>");
        xml
    }
}
