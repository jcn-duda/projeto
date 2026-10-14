//! NerdFilmes (`resolvers/profiles/nerdfilmes.ts` + `nerdfilmes-parsers.ts` +
//! `nerdfilmes-feeds.ts`). Saída: botões do post pelo `createLinkCollector`
//! (âncora sem `advance`, par estreito de pack/episódio com faixa, áudio
//! `NERD_*`, qualidade/fonte próprias), título da release e a página do
//! Cardigann com a data do post (`escapeXml`). O feed torznab multilinha
//! (sem `<enclosure>`) entra aqui pelo `br_core::rss_xml`.

#[path = "nerdfilmes_parse.rs"]
mod parse;
#[path = "nerdfilmes_text.rs"]
mod text;

use std::sync::LazyLock;

use adom_crawl::profile_parsers::{ResolverLink, BASE_PROTECTOR_SUFFIXES};
use adom_crawl::resolver_text::escape_xml;
use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;
use url::Url;

use super::{host_matches, SiteOutput};
use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::episode::{EpisodeScope, EpisodeStepConfig, NARROW_EPISODE, NARROW_PACK_RESET};
use crate::common::http_date::{days_from_civil, http_date};
use crate::common::release::FB;
use crate::common::rules::{compile, last_audio_marker, NERD_AUDIO, NERD_LEGENDADO};
use crate::common::{
    release_title, rss_xml, search_page_html, ReleaseTitleConfig, RssConfig, SearchItem, SitePost,
};

pub use parse::{parse_post_date, parse_search_posts};
pub use text::clean_nerd_post_title;

pub struct Nerd;

pub static NERD: Nerd = Nerd;

/// `/<a\b[^>]*>[\s\S]*?<\/a>/gi` (a âncora inteira; o grupo 0 é usado).
static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r"(?i)<a{FB}[^>]*>[\s\S]*?</a>")).expect("âncora do nerd")
});
/// Par ESTREITO do nerd: pack sem tie-break e episódio com fim de intervalo.
static NARROW_PACK: LazyLock<Regex> = LazyLock::new(|| compile(NARROW_PACK_RESET));
static NARROW_EP: LazyLock<Regex> = LazyLock::new(|| compile(NARROW_EPISODE));

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig::new(clean_nerd_post_title);

fn is_protector_host(host: &str) -> bool {
    host_matches(host, BASE_PROTECTOR_SUFFIXES)
}

/// Abertura da âncora: do `<a` até o primeiro `>` (o `match(/<a\b[^>]*>/i)` do TS).
fn open_tag(whole: &str) -> &str {
    whole.split_inclusive('>').next().unwrap_or("")
}

struct Hooks;

impl CollectorHooks for Hooks {
    fn anchor_re(&self) -> &FancyRegex {
        &ANCHOR
    }

    /// `resolveHref` do nerd: nunca avança o cursor (todo skip é `advance: false`).
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        _html: &str,
        base_url: Option<&str>,
    ) -> Resolved {
        let whole = caps.get(0).map_or("", |m| m.as_str());
        let skip = Resolved::Skip { advance: false };
        // O href passa por `decodeEntitiesBasic` duas vezes (no `attribute` e no
        // `resolveHref`), como no TS.
        let Some(raw) = text::attr_href(open_tag(whole)).filter(|h| !h.is_empty()) else {
            return skip;
        };
        let href = text::decode_basic(&raw);
        if parse::is_valid_direct_magnet(&href) {
            return Resolved::Url(href);
        }
        // Protetor externo: URL absoluta de host de protetor. Relativo nunca é protetor.
        if let Ok(abs) = Url::parse(&href) {
            if is_protector_host(abs.host_str().unwrap_or("")) {
                return Resolved::Url(href);
            }
        }
        let Some(base) = base_url.filter(|b| !b.is_empty()) else {
            return skip;
        };
        let Ok(base_parsed) = Url::parse(base) else {
            return skip;
        };
        let Ok(target) = base_parsed.join(&href) else {
            return skip;
        };
        if !matches!(target.scheme(), "http" | "https")
            || !parse::is_nerd_same_origin_link_php(&target, base)
        {
            return skip;
        }
        Resolved::Url(target.to_string())
    }

    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        text::strip_tags_rich(caps.get(0).map_or("", |m| m.as_str()))
    }

    fn strip_tags(&self, value: &str) -> String {
        text::strip_tags_rich(value)
    }

    fn initial_audio(&self) -> Option<String> {
        Some("desconhecido".into())
    }

    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        last_audio_marker(segment, &NERD_AUDIO, &NERD_LEGENDADO)
    }

    /// O marcador no texto do PRÓPRIO botão vence a seção: post "Dublado e
    /// Legendado" com o botão "Dual Áudio" é dublado (sem isto o Rust marcava
    /// legendado o dublado BR — medido ao vivo em 2026-10-13).
    fn audio_from_anchor(&self, anchor_text: &str) -> Option<String> {
        last_audio_marker(anchor_text, &NERD_AUDIO, &NERD_LEGENDADO)
    }

    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        EpisodeStepConfig {
            scope: EpisodeScope::AnchorLocal,
            pack: &NARROW_PACK,
            range: None,
            ep: &NARROW_EP,
            extract: None,
            pack_match_all: None,
            tie_break: false,
            ep_range_group: Some(2),
        }
        .step(segment, anchor, state)
    }

    fn quality(&self, context: &str) -> Option<u32> {
        text::quality_of(context)
    }

    fn source(&self, context: &str) -> Option<String> {
        text::source_of(context)
    }
}

/// `<div class="date">` entre size e description, só com data não vazia.
fn date_row(post: &SitePost) -> String {
    match post.date.as_deref().filter(|d| !d.is_empty()) {
        Some(date) => format!(r#"<div class="date">{}</div>"#, escape_xml(date)),
        None => String::new(),
    }
}

/// Extrai o primeiro ano (19xx/20xx) do título. `\b` e `\d` restritos a ASCII
/// pela regra de paridade com o JS (`(?-u:\b)`, `[0-9]`).
fn extract_year(title: &str) -> Option<u32> {
    static YEAR_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?-u:\b)((?:19|20)[0-9]{2})(?-u:\b)").expect("ano do título")
    });
    YEAR_RE.find(title).and_then(|m| m.as_str().parse().ok())
}

/// Milissegundos de um dia: o `Date.UTC` do JS trabalha em ms.
const DAY_MS: i64 = 86_400_000;

/// Parse ISO 8601 em ms desde a época (o mesmo subconjunto do `iso_from_js_date`
/// do `nerdfilmes_parse.rs`, mas sem converter para ISO de saída). O JS aceita
/// `2024-05-01T10:00:00.000Z`, `2024-05-01T10:00:00-03:00`, `2023-01-02` etc.
fn parse_iso_to_ms(date: &str) -> Option<i64> {
    static ISO: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(Z|[+-][0-9]{2}:[0-9]{2})?)?$",
        )
        .expect("iso")
    });
    let caps = ISO.captures(date)?;
    let num = |i: usize, default: i64| -> i64 {
        caps.get(i)
            .map_or(default, |m| m.as_str().parse().unwrap_or(default))
    };
    let (y, mo, d) = (num(1, 1970), num(2, 1), num(3, 1));
    let (h, mi, s) = (num(4, 0), num(5, 0), num(6, 0));
    let ms_frac = caps.get(7).map_or(0, |m| {
        let digits: String = m.as_str().chars().take(3).collect();
        format!("{digits:0<3}").parse::<i64>().unwrap_or(0)
    });
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || s > 59 {
        return None;
    }
    let offset_ms = match caps.get(8).map(|m| m.as_str()) {
        None | Some("Z") => 0,
        Some(off) => {
            let sign = if off.starts_with('-') { -1 } else { 1 };
            let hh: i64 = off[1..3].parse().ok()?;
            let mm: i64 = off[4..6].parse().ok()?;
            sign * (hh * 60 + mm) * 60_000
        }
    };
    Some(
        days_from_civil(y, mo, d) * DAY_MS + h * 3_600_000 + mi * 60_000 + s * 1000 + ms_frac
            - offset_ms,
    )
}

/// `pubDate` formatado como HTTP date (o TS chama `.toUTCString()`).
fn pub_date_http(post: &SitePost) -> String {
    if let Some(date) = post.date.as_deref().filter(|d| !d.is_empty()) {
        if let Some(ms) = parse_iso_to_ms(date) {
            return http_date(ms);
        }
    }
    let year = extract_year(&post.title).unwrap_or(2000);
    // `new Date(Date.UTC(year, 0, 1)).toUTCString()` — 1 Jan, 00:00:00 UTC.
    http_date(days_from_civil(i64::from(year), 1, 1) * DAY_MS)
}

/// `rssXml`: feed torznab multilinha sem `<enclosure>`.
fn nerdfilmes_rss_xml(self_url: &str, items: &[SearchItem], category: u32) -> String {
    let cfg = RssConfig {
        self_url,
        channel_title: "NerdFilmesTorrent / XNerdFilmes",
        title_of: &|post: &SitePost, link: &ResolverLink| release_title(&TITLE, post, link, None),
        pub_date_of: &|post: &SitePost| pub_date_http(post),
        with_description: false,
        seeders_comment: None,
        with_enclosure: false,
        compact: false,
    };
    rss_xml(&cfg, items, category)
}

impl SiteOutput for Nerd {
    fn name(&self) -> &'static str {
        "nerdfilmes"
    }

    fn search_posts(&self, html: &str, base_url: &str) -> Vec<SitePost> {
        parse_search_posts(html, base_url)
    }

    fn post_date(&self, html: &str) -> Option<String> {
        parse_post_date(html)
    }

    /// Mesma regra do TS: o `mapLimit` compartilhado engole o post que falha e a
    /// busca segue com os outros. O nerd não loga a falha (só o bludv tem
    /// `onError`); aqui o log do drop é o do `items_for_posts`, único no port.
    fn post_error_is_empty(&self) -> bool {
        true
    }

    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        parse_download_links(&Hooks, html, Some(post_url))
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    fn search_page_html(&self, self_url: &str, items: &[SearchItem]) -> String {
        search_page_html(
            self_url,
            items,
            &|post, link, index| self.release_title(post, link, index),
            &date_row,
            &|post| Some(post.title.clone()),
        )
    }

    fn rss_xml(&self, self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        Some(nerdfilmes_rss_xml(self_url, items, category))
    }
}
