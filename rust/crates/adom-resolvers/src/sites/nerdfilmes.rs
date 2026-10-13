//! NerdFilmes (`resolvers/profiles/nerdfilmes.ts` + `nerdfilmes-parsers.ts` +
//! `nerdfilmes-feeds.ts`). Saída: botões do post pelo `createLinkCollector`
//! (âncora sem `advance`, par estreito de pack/episódio com faixa, áudio
//! `NERD_*`, qualidade/fonte próprias), título da release e a página do
//! Cardigann com a data do post (`escapeXml`). O feed torznab fica de fora: o
//! TS não o exporta pelo objeto do profile (`rssXml` não está em `server.ts`).

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
use crate::common::release::FB;
use crate::common::rules::{compile, last_audio_marker, NERD_AUDIO, NERD_LEGENDADO};
use crate::common::{release_title, search_page_html, ReleaseTitleConfig, SearchItem, SitePost};

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
}
