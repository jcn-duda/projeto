//! Busca do TorrentGalaxy: a listagem já traz título, tamanho, data e poster —
//! o MAGNET vive na página de detalhe. Por isso a busca é LAZY: o `/search`
//! devolve as linhas apontando para o `/resolve` (que abre o post e extrai o
//! magnet), sem abrir os 50 posts de uma busca (51 requisições ao site).
//!
//! Medido em 2026-10-24: a listagem de "batman" tem 50 `div.tgxtablerow` e a
//! página de detalhe tem o magnet no botão `dl-magnet`.

use std::time::{SystemTime, UNIX_EPOCH};

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_matching::matches_resolver_query;

use crate::common::{SearchItem, SitePost};
use crate::listing_parsers::torrentgalaxy::parse_rows;
use crate::profile::ResolverProfile;
use crate::search_select;
use crate::sites::torrentgalaxy::{clean_title, relative_to_date};

/// Agora em ms: a data relativa do TGx ("1 month, 4 weeks") é convertida
/// contra este instante.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// Itens da busca: um por linha da listagem (o botão é o magnet do detalhe).
///
/// O filtro é o do projeto (título, temporada, ano e corte em `max_posts`):
/// a linha do TGx já vem com o nome do release, então o casamento local é o
/// mesmo dos outros sites.
pub async fn search_items(
    profile: &ResolverProfile,
    query: &str,
) -> Result<Vec<SearchItem>, String> {
    let rules = search_select::rules_for(&profile.site_name);
    let season = search_select::requested_season(query);
    let year = search_select::requested_year(query);
    let normalized = search_select::normalize_query(query, rules);
    let html = profile.search_html(&normalized).await?;
    let rows = parse_rows(&html, &profile.selector.url());
    let now = now_ms();
    let mut items: Vec<SearchItem> = Vec::new();
    for row in rows {
        let title = clean_title(&row.title);
        if title.is_empty() {
            continue;
        }
        if !matches_resolver_query(&title, &normalized) {
            continue;
        }
        if !search_select::matches_season(&title, season) {
            continue;
        }
        if !search_select::matches_year(&title, year) {
            continue;
        }
        if items.len() >= rules.max_posts {
            break;
        }
        items.push(SearchItem {
            post: SitePost {
                title,
                url: row.url.clone(),
                poster: row.poster.clone(),
                date: row.date.as_deref().and_then(|d| relative_to_date(d, now)),
                year: None,
                kind: row.category.clone(),
            },
            // O botão é o magnet que vive na página de detalhe: aqui o link
            // carrega a URL do post — o `/resolve` abre e extrai o magnet.
            link: ResolverLink {
                url: row.url.clone(),
                size: row.size.clone(),
                ..Default::default()
            },
            index: 0,
            count: 1,
        });
    }
    Ok(items)
}
