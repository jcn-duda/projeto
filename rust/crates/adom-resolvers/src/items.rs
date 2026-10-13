//! Da lista de posts aos itens da página: cada post selecionado na busca é
//! aberto e cada BOTÃO dele vira uma linha (`searchPosts` + `getPostLinks` dos
//! profiles TS). O formato da linha é do site (`crate::sites`). Separado de
//! `profile.rs` pela catraca de 400 linhas.

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_matching::button_id;
use futures_util::stream::{self, StreamExt, TryStreamExt};

use crate::common::{SearchItem, SitePost};
use crate::profile::ResolverProfile;
use crate::sites::{site_output, SiteOutput};

/// Posts abertos em paralelo: o `mapLimit` dos profiles TS (`concurrency = 3`).
const POST_CONCURRENCY: usize = 3;

impl ResolverProfile {
    fn site(&self) -> Result<&'static dyn SiteOutput, String> {
        site_output(&self.site_name).ok_or_else(|| format!("site_sem_saida:{}", self.site_name))
    }

    /// Botões de um post (`getPostLinks`): página do post (cache) → parser do site.
    pub async fn post_links(&self, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        let site = self.site()?;
        let html = self.post_html(post_url).await?;
        site.post_links(&html, post_url)
    }

    /// Itens da busca: um por botão de cada post, com índice e total do post.
    /// Um post que falha derruba a busca, como o `mapLimit` sem `try` do TS.
    pub async fn search_items(&self, query: &str) -> Result<Vec<SearchItem>, String> {
        let posts = self.search(query).await?;
        let per_post: Vec<Vec<SearchItem>> = stream::iter(posts)
            .map(|post| async move {
                let links = self.post_links(&post.url).await?;
                let count = links.len();
                let site_post = SitePost {
                    title: post.title,
                    url: post.url,
                    poster: post.poster,
                    ..Default::default()
                };
                Ok::<_, String>(
                    links
                        .into_iter()
                        .enumerate()
                        .map(|(index, link)| SearchItem {
                            post: site_post.clone(),
                            link,
                            index,
                            count,
                        })
                        .collect(),
                )
            })
            .buffered(POST_CONCURRENCY)
            .try_collect()
            .await?;
        Ok(per_post.into_iter().flatten().collect())
    }

    /// Página do Cardigann para os itens; sem saída portada, falha clara.
    pub fn render_items_html(&self, items: &[SearchItem]) -> String {
        match self.site() {
            Ok(site) => site.search_page_html(&self.self_url, items),
            Err(_) => String::new(),
        }
    }

    /// Feed torznab do site, quando ele tem um.
    pub fn render_items_xml(&self, items: &[SearchItem], category: u32) -> Option<String> {
        self.site().ok()?.rss_xml(&self.self_url, items, category)
    }

    /// `/resolve` com índice: o botão escolhido por `pickButton` (hash do href
    /// primeiro, índice depois) e seguido até o magnet.
    pub async fn resolve_button_of(
        &self,
        post_url: &str,
        index: usize,
        hash: Option<&str>,
        count: Option<&str>,
    ) -> Result<String, String> {
        let links = self.post_links(post_url).await?;
        let link = pick_button(&links, index, hash, count).ok_or("no_such_button")?;
        self.resolve(&link.url).await
    }

    /// `/resolve` sem índice: botões do melhor para o pior (`scoreLink`:
    /// dublado primeiro, qualidade depois), até um resolver.
    pub async fn resolve_best_of(&self, post_url: &str) -> Result<String, String> {
        let mut links = self.post_links(post_url).await?;
        links.sort_by_key(|l| std::cmp::Reverse(score_link(l)));
        let mut last_err = "no_links".to_string();
        for link in links {
            match self.resolve(&link.url).await {
                Ok(magnet) => return Ok(magnet),
                Err(e) => last_err = e,
            }
        }
        Err(last_err)
    }
}

/// `scoreLink` do comando/bludv: dublado 100k, desconhecido 50k, legendado 0.
fn score_link(link: &ResolverLink) -> u32 {
    let audio = match link.audio.as_deref() {
        Some("dublado") => 100_000,
        Some("legendado") => 0,
        _ => 50_000,
    };
    audio + link.quality.unwrap_or(0)
}

/// `pickButton` (`resolvers/matching.ts`): o hash do href identifica o botão
/// mesmo se o post mudou; sem hash (ou hash sumido com o mesmo total) vale o
/// índice. Hash sumido com total diferente é post editado: nenhum botão.
fn pick_button<'a>(
    links: &'a [ResolverLink],
    index: usize,
    hash: Option<&str>,
    count: Option<&str>,
) -> Option<&'a ResolverLink> {
    if let Some(hash) = hash.filter(|h| !h.is_empty()) {
        if let Some(found) = links.iter().find(|l| button_id(&l.url) == hash) {
            return Some(found);
        }
        // `Number(count)` do JS: vazio vale 0 e lixo vale NaN, que nunca é igual.
        if let Some(raw) = count {
            let raw = raw.trim();
            let same = if raw.is_empty() {
                links.is_empty()
            } else {
                raw.parse::<f64>().is_ok_and(|n| n == links.len() as f64)
            };
            if !same {
                return None;
            }
        }
    }
    links.get(index)
}
