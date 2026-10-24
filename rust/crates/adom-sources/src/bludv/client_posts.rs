//! Coleta de posts e links do BLUDV: concorrência limitada e ordem do
//! documento preservada (o `onItemError: 'drop'` do Node).

use tokio::task::JoinSet;

use super::super::parse::{
    extract_magnet, has_ad_gate, is_gate_url, is_valid_magnet_uri, parse_download_links,
    parse_size, release_title,
};
use super::super::types::{
    BludvDownloadLink, BludvOutcome, BludvPost, BludvRawItem, BludvSearchOpts,
};
use super::fetch::FetchError;
use super::BludvClient;

/// Lote de UM post: itens + se ele é incompleto (gate/anúncio).
pub(super) struct PostChunk {
    items: Vec<BludvRawItem>,
    incomplete: bool,
}

impl BludvClient {
    /// Posts com concorrência limitada e ordem do documento preservada.
    pub(super) async fn collect_posts(
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
pub(super) fn outcome_from_fetch(err: FetchError) -> BludvOutcome {
    match err {
        FetchError::Http(status) => BludvOutcome::Http(status),
        other => BludvOutcome::Failed(other.describe()),
    }
}
