//! Busca do VacaTorrent (`resolvers/profiles/vacatorrent.ts` e
//! `vacatorrent-content.ts`): AJAX `search_posts` (JSON) → seleção → filme:
//! página da obra → página de links → botões; série: página da obra →
//! season-internal → cards da temporada pedida → botões de cada card com a
//! temporada/episódio declarados (`declaredSeriesLocation`). Card que falha
//! deixa a série incompleta, mas o que já veio é aproveitado.

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::{declared_series_location, season_from_card_slug, LinkEvidence};
use futures_util::stream::{self, StreamExt};

use crate::common::{SearchItem, SitePost};
use crate::profile::ResolverProfile;
use crate::search_select;
use crate::sites::vacatorrent::{
    extract_batch_title, extract_movie_links, filter_season_cards, parse_search_json,
    parse_season_internal, post_links_with, series_season_internal_url, VacaParseOptions, VacaWork,
};
use crate::sites::{site_output, SiteOutput};

/// Posts abertos em paralelo (`mapLimit` do profile).
const POST_CONCURRENCY: usize = 3;

/// `fetchMovieLinks`: sem link de download na página da obra = sem botões.
async fn movie_links(
    profile: &ResolverProfile,
    work: &VacaWork,
) -> Result<Vec<ResolverLink>, String> {
    let page = profile.post_html(&work.url).await?;
    let Some(links_url) = extract_movie_links(&page, Some(&work.url)) else {
        return Ok(Vec::new());
    };
    let links_html = profile.post_html(&links_url).await?;
    post_links_with(&links_html, &links_url, &VacaParseOptions::default())
}

/// `fetchSeriesLinks`.
async fn series_links(
    profile: &ResolverProfile,
    work: &VacaWork,
    season: Option<u32>,
) -> Result<Vec<ResolverLink>, String> {
    let page = profile.post_html(&work.url).await?;
    let Some(internal_url) = series_season_internal_url(&page, Some(&work.url)) else {
        return Ok(Vec::new());
    };
    let internal = profile.post_html(&internal_url).await?;
    // `filterSeasonCards` (`vacatorrent-shapes.ts:82-89`): sem temporada pedida
    // ficam todos os cards; com pedida, batches e cards sem temporada ficam e as
    // outras temporadas caem. É a regra do núcleo, não uma cópia daqui.
    let cards = filter_season_cards(
        &parse_season_internal(&internal, Some(&internal_url)),
        season,
    );
    let mut out = Vec::new();
    let mut incomplete = None;
    for card in cards {
        let card_html = match profile.post_html(&card.url).await {
            Ok(html) => html,
            Err(e) => {
                eprintln!("[resolver] vacatorrent: card {}: {e}", card.url);
                incomplete = Some(e);
                continue;
            }
        };
        let card_season = card
            .season
            .map(i64::from)
            .or_else(|| season_from_card_slug(&card.url));
        let batch_title = if card.is_batch {
            extract_batch_title(&card_html)
        } else {
            None
        };
        let opts = VacaParseOptions {
            season: card_season.and_then(|s| u32::try_from(s).ok()),
            real_title: batch_title.clone(),
        };
        let links = match post_links_with(&card_html, &card.url, &opts) {
            Ok(links) => links,
            Err(e) => {
                eprintln!("[resolver] vacatorrent: card {}: {e}", card.url);
                incomplete = Some(e);
                continue;
            }
        };
        for mut link in links {
            let loc = declared_series_location(&LinkEvidence {
                card_season,
                card_title: card.title.clone(),
                is_batch: card.is_batch,
                real_title: batch_title.clone(),
                dn: None,
                link_episode: link.episode.map(i64::from),
            });
            link.season = loc.season.and_then(|s| u32::try_from(s).ok());
            link.episode = loc.episode.and_then(|e| u32::try_from(e).ok());
            out.push(link);
        }
    }
    match incomplete {
        // Série incompleta sem nada aproveitável é falha do post.
        Some(e) if out.is_empty() => Err(e),
        _ => Ok(out),
    }
}

/// `collectLinks` do `/resolve`: a URL é a da OBRA e os botões vivem na
/// página de links (filme) ou nos cards (série, todas as temporadas). Tenta
/// filme e, sem botão, série — o hash do botão desfaz a ambiguidade.
pub async fn collect_links(
    profile: &ResolverProfile,
    post_url: &str,
) -> Result<Vec<ResolverLink>, String> {
    let work = |is_movie| VacaWork {
        url: post_url.to_string(),
        title: String::new(),
        is_movie,
        year: None,
        poster: None,
    };
    let links = movie_links(profile, &work(true)).await.unwrap_or_default();
    if !links.is_empty() {
        return Ok(links);
    }
    Ok(series_links(profile, &work(false), None)
        .await
        .unwrap_or_default())
}

/// `searchPosts` do Vaca.
pub async fn search_items(
    profile: &ResolverProfile,
    query: &str,
) -> Result<Vec<SearchItem>, String> {
    let site: &dyn SiteOutput = site_output(&profile.site_name).ok_or("site_sem_saida")?;
    let rules = search_select::rules_for(&profile.site_name);
    let season = search_select::requested_season(query);
    let normalized = search_select::normalize_query(query, rules);
    // `search_url` do Vaca monta o AJAX (query vazia vira "de").
    let text = profile.search_html(&normalized).await?;
    let works = parse_search_json(&text, &profile.selector.url())?;
    profile.selector.note_success();

    let picked: Vec<VacaWork> = {
        let as_posts: Vec<(VacaWork, SitePost)> = works
            .into_iter()
            .map(|w| {
                let post = SitePost {
                    title: w.title.clone(),
                    url: w.url.clone(),
                    poster: w.poster.clone(),
                    year: w.year,
                    kind: Some(if w.is_movie { "Filme" } else { "Série" }.into()),
                    ..Default::default()
                };
                (w, post)
            })
            .collect();
        search_select::select_posts(
            as_posts,
            |(_, p)| p.title.as_str(),
            &normalized,
            season,
            rules.max_posts,
        )
        .into_iter()
        .map(|(w, _)| w)
        .collect()
    };

    let per_post: Vec<Vec<SearchItem>> = stream::iter(picked)
        .map(|work| async move {
            let links = if work.is_movie {
                movie_links(profile, &work).await
            } else {
                series_links(profile, &work, season).await
            };
            let post = SitePost {
                title: work.title.clone(),
                url: work.url.clone(),
                poster: work.poster.clone(),
                year: work.year,
                kind: Some(if work.is_movie { "Filme" } else { "Série" }.into()),
                ..Default::default()
            };
            match links {
                Ok(links) => site.items_of(&post, links, season),
                Err(e) => {
                    eprintln!(
                        "[resolver] vacatorrent: falha ao obter links do post {} ({e})",
                        work.url
                    );
                    Vec::new()
                }
            }
        })
        .buffered(POST_CONCURRENCY)
        .collect()
        .await;
    Ok(per_post.into_iter().flatten().collect())
}
