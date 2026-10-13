//! Busca do HDR Torrents (`resolvers/profiles/hdrtorrents.ts`): a busca do
//! site é quebrada, então o catálogo é raspado pela LISTAGEM (`/`,
//! `/pagina/N/`) e a query casa localmente. Cache com SWR: vencido, a busca
//! usa o último catálogo bom na hora e o refresh corre em fundo, com prazo
//! longo (ninguém espera); só o cold start paga o prazo curto.

use std::sync::LazyLock;
use std::time::{Duration, Instant};

use adom_crawl::net::Allowlist;
use reqwest::header::{ACCEPT, USER_AGENT};
use tokio::sync::Mutex;

use crate::common::{SearchItem, SitePost};
use crate::profile::ResolverProfile;
use crate::search_select;
use crate::sites::hdrtorrents::{parse_listing_html, HdrWork};

/// 20 páginas × 20 cards ≈ 400 obras: o catálogo corrente.
const MAX_LISTING_PAGES: u32 = 20;
/// Prazo da raspagem que uma busca espera (a busca BR tem 20s de teto).
const LISTING_BUDGET: Duration = Duration::from_millis(10_000);
/// Prazo do aquecimento e do refresh de fundo: com 10s o catálogo saía sempre
/// parcial e variava a cada raspagem (medido em produção no TS).
const LISTING_WARM_BUDGET: Duration = Duration::from_millis(120_000);
const LISTING_TTL: Duration = Duration::from_secs(30 * 60);
const LISTING_PARTIAL_TTL: Duration = Duration::from_secs(2 * 60);
/// Página com menos cards que isto (metade do normal) é fim do catálogo.
const END_OF_CATALOG: usize = 10;

#[derive(Default)]
struct Listing {
    items: Vec<HdrWork>,
    partial: bool,
    expires_at: Option<Instant>,
    has_good: bool,
    refreshing: bool,
}

static LISTING: LazyLock<Mutex<Listing>> = LazyLock::new(|| Mutex::new(Listing::default()));

/// O que a raspagem precisa, sem prender o profile (o refresh de fundo é
/// `'static`).
#[derive(Clone)]
struct Scraper {
    base: String,
    allowlist: Allowlist,
    user_agent: String,
    timeout: Duration,
}

impl Scraper {
    fn of(profile: &ResolverProfile) -> Self {
        Self {
            base: profile.selector.url(),
            allowlist: profile.allowlist.clone(),
            user_agent: profile.network.user_agent.clone(),
            timeout: Duration::from_millis(profile.network.timeout_ms),
        }
    }

    async fn page(&self, client: &reqwest::Client, n: u32) -> Result<Vec<HdrWork>, String> {
        let url = if n <= 1 {
            format!("{}/", self.base)
        } else {
            format!("{}/pagina/{n}/", self.base)
        };
        self.allowlist
            .assert_allowed_url(&url)
            .map_err(|e| e.to_string())?;
        let res = client
            .get(&url)
            .header(USER_AGENT, &self.user_agent)
            .header(ACCEPT, "text/html,application/xhtml+xml")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("http_{}", res.status().as_u16()));
        }
        let html = res.text().await.map_err(|e| e.to_string())?;
        parse_listing_html(&html, &self.base)
    }

    /// `scrapeListings`: páginas em ordem até o fim do catálogo, o teto ou o prazo.
    async fn scrape(&self, budget: Duration) -> Result<(Vec<HdrWork>, bool), String> {
        let client = reqwest::Client::builder()
            .timeout(self.timeout)
            .build()
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + budget;
        let mut all: Vec<HdrWork> = Vec::new();
        let mut partial = false;
        for n in 1..=MAX_LISTING_PAGES {
            if Instant::now() > deadline {
                partial = true;
                break;
            }
            let items = self.page(&client, n).await?;
            let count = items.len();
            for item in items {
                if !all.iter().any(|seen| seen.url == item.url) {
                    all.push(item);
                }
            }
            if count < END_OF_CATALOG {
                break;
            }
        }
        Ok((all, partial))
    }
}

fn store(listing: &mut Listing, items: Vec<HdrWork>, partial: bool) {
    let ttl = if partial {
        LISTING_PARTIAL_TTL
    } else {
        LISTING_TTL
    };
    listing.items = items;
    listing.partial = partial;
    listing.expires_at = Some(Instant::now() + ttl);
    listing.has_good = true;
}

/// Refresh em fundo com o prazo longo; erro só vira log.
fn spawn_refresh(scraper: Scraper) {
    tokio::spawn(async move {
        let result = scraper.scrape(LISTING_WARM_BUDGET).await;
        let mut listing = LISTING.lock().await;
        listing.refreshing = false;
        match result {
            Ok((items, partial)) => store(&mut listing, items, partial),
            Err(e) => eprintln!("[resolver] hdrtorrents: refresh em background falhou ({e})"),
        }
    });
}

/// `fetchAllListingsDetailed`: cache → SWR → cold start (prazo curto, sob o
/// lock: buscas concorrentes esperam a MESMA raspagem).
async fn listings(profile: &ResolverProfile) -> Result<(Vec<HdrWork>, bool), String> {
    let mut listing = LISTING.lock().await;
    if listing.expires_at.is_some_and(|t| t > Instant::now()) {
        return Ok((listing.items.clone(), listing.partial));
    }
    if listing.has_good {
        if !listing.refreshing {
            listing.refreshing = true;
            spawn_refresh(Scraper::of(profile));
        }
        return Ok((listing.items.clone(), listing.partial));
    }
    let (items, partial) = Scraper::of(profile).scrape(LISTING_BUDGET).await?;
    store(&mut listing, items.clone(), partial);
    Ok((items, partial))
}

/// Aquece o catálogo no boot (`warm()` do TS): a primeira busca já o encontra.
pub fn warm(profile: &ResolverProfile) {
    let scraper = Scraper::of(profile);
    tokio::spawn(async move {
        let mut listing = LISTING.lock().await;
        if listing.has_good {
            return;
        }
        match scraper.scrape(LISTING_WARM_BUDGET).await {
            Ok((items, partial)) => {
                eprintln!(
                    "[resolver] hdrtorrents: warm → {} item(s){}",
                    items.len(),
                    if partial { " (parcial)" } else { "" }
                );
                store(&mut listing, items, partial);
            }
            Err(e) => eprintln!("[resolver] hdrtorrents: warm falhou ({e})"),
        }
    });
}

/// `searchPosts` do HDR: catálogo → match local → conteúdo de cada post.
pub async fn search_items(
    profile: &ResolverProfile,
    query: &str,
) -> Result<Vec<SearchItem>, String> {
    let rules = search_select::rules_for(&profile.site_name);
    let season = search_select::requested_season(query);
    let normalized = search_select::normalize_query(query, rules);
    let (works, _partial) = match listings(profile).await {
        Ok(found) => {
            profile.selector.note_success();
            found
        }
        Err(e) => {
            profile.account_failure(&e).await;
            return Err(e);
        }
    };
    let posts: Vec<SitePost> = works
        .into_iter()
        .map(|w| SitePost {
            title: w.title,
            url: w.url,
            poster: w.poster,
            year: w.year,
            kind: w.kind.map(str::to_string),
            ..Default::default()
        })
        .collect();
    let posts = search_select::select_posts(
        posts,
        |p| p.title.as_str(),
        &normalized,
        season,
        rules.max_posts,
    );
    profile.items_for_posts(posts, season).await
}
