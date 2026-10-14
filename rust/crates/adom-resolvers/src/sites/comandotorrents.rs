//! ComandoTorrents (`resolvers/profiles/comandotorrents.ts`): âncora de
//! protetor via `createProtectorHrefResolver`, HTML decodificado ANTES do
//! casamento, episódio no escopo `anchor-writes` com desempate (o `matchAll`
//! cru que lança é preservado), título com `stripSource` e poster na linha.

use std::sync::LazyLock;

use crate::common::text::decode_entities;
use crate::common::text::strip_tags;
use adom_crawl::profile_parsers::{ResolverLink, BASE_PROTECTOR_SUFFIXES};
use adom_crawl::resolver_text::escape_html;
use fancy_regex::{Captures, Regex as FancyRegex};

use super::{host_matches, SiteOutput};
use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::episode::{EpisodeRules, EpisodeScope, EpisodeStepConfig, PackMatchAll};
use crate::common::release::FB;
use crate::common::rules::{
    br_audio_from_anchor, br_audio_from_segment, normalize_quality, normalize_source,
    resolve_protector_href,
};
use crate::common::{
    clean_post_title, release_title, search_page_html, ReleaseTitleConfig, SearchItem, SitePost,
};

pub struct Comando;

pub static COMANDO: Comando = Comando;

static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r"(?i)<a{FB}([^>]*)>([\s\S]*?)</a>")).expect("âncora do comando")
});
static EPISODES: LazyLock<EpisodeRules> = LazyLock::new(EpisodeRules::default_rules);

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    strip_source: true,
    ..ReleaseTitleConfig::new(clean_post_title)
};

fn is_protector_host(host: &str) -> bool {
    host_matches(host, BASE_PROTECTOR_SUFFIXES)
}

struct Hooks;

impl CollectorHooks for Hooks {
    fn anchor_re(&self) -> &FancyRegex {
        &ANCHOR
    }
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        _html: &str,
        base_url: Option<&str>,
    ) -> Resolved {
        let attrs = caps.get(1).map_or("", |m| m.as_str());
        resolve_protector_href(attrs, base_url, &is_protector_host)
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        strip_tags(caps.get(2).map_or("", |m| m.as_str()))
    }
    fn strip_tags(&self, value: &str) -> String {
        strip_tags(value)
    }
    fn initial_audio(&self) -> Option<String> {
        Some("desconhecido".into())
    }
    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        br_audio_from_segment(segment)
    }
    fn audio_from_anchor(&self, anchor_text: &str) -> Option<String> {
        br_audio_from_anchor(anchor_text)
    }
    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        let rules = &*EPISODES;
        EpisodeStepConfig {
            scope: EpisodeScope::AnchorWrites,
            pack: &rules.pack,
            range: Some(&rules.range),
            ep: &rules.episode,
            extract: Some(rules),
            pack_match_all: Some(PackMatchAll::Throws),
            tie_break: true,
            ep_range_group: None,
        }
        .step(segment, anchor, state)
    }
    fn quality(&self, context: &str) -> Option<u32> {
        normalize_quality(context)
    }
    fn source(&self, context: &str) -> Option<String> {
        normalize_source(context)
    }
    fn decode_html(&self, html: &str) -> String {
        decode_entities(html)
    }
}

impl SiteOutput for Comando {
    fn routes(&self) -> crate::server::RouteSet {
        crate::server::RouteSet {
            resolve: true,
            dl: false,
            api: false,
        }
    }

    fn name(&self) -> &'static str {
        "comandotorrents"
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
            &|post| match post.poster.as_deref().filter(|p| !p.is_empty()) {
                Some(poster) => format!(
                    r#"<div class="poster"><img src="{}"></div>"#,
                    escape_html(poster)
                ),
                None => String::new(),
            },
            &|post| Some(post.title.clone()),
        )
    }
}
