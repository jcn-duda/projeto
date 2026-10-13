//! Vaca Torrent (`resolvers/profiles/vacatorrent*.ts`): botões do post, título da
//! release e página do Cardigann. Formas de página em `vacatorrent_shapes.rs` e a
//! busca JSON em `vacatorrent_search.rs`.
//!
//! Paridade com o JS: `\b` é ASCII (`(?-u:\b)` / `FB`). Diferenças vivas dos
//! cards preservadas (R-4): fonte `BLRAY`, pack com `\bbatch\b`, faixa com
//! `[.\-s]*`, título sem faixa de episódio, e o desempate de episódio com o
//! `matchAll` cru que LANÇA (vira `Err` e derruba o post inteiro).

use std::sync::LazyLock;

use adom_crawl::profile_parsers::{ResolverLink, BASE_PROTECTOR_SUFFIXES};
use adom_crawl::resolver_text::escape_html;
use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;

use super::{host_matches, SiteOutput};
use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::episode::{EpisodeRules, EpisodeScope, EpisodeStepConfig, PackMatchAll};
use crate::common::release::FB;
use crate::common::rules::{
    compile, normalize_quality, normalize_source_with, resolve_protector_href, VACA_SOURCE_MATCH,
};
use crate::common::{release_title, search_page_html, ReleaseTitleConfig, SearchItem, SitePost};

#[path = "vacatorrent_search.rs"]
mod search;
#[path = "vacatorrent_shapes.rs"]
mod shapes;

use self::shapes::{decode_entities, strip_tags};
pub use search::{parse_search_json, unwrap_search_json, VacaWork};
pub use shapes::{
    decode_data_u, extract_batch_title, extract_movie_links, is_watch_anchor,
    normalize_batch_title, normalize_episode_markup, parse_season_internal,
    repair_mangled_entities, series_season_internal_url, VacaSeasonCard,
};

pub struct Vaca;

pub static VACA: Vaca = Vaca;

/// Pack do vaca (`packPattern`): `\bbatch\b` e `\bPACK\b` além dos rótulos padrão.
const VACA_PACK: &str = r"(?i){B}(?:TEMPORADA\s+COMPLETA|TODAS\s+AS\s+TEMPORADAS|S[EÉ]RIE\s+COMPLETA|PACK\s+COMPLETO|PACOTE\s+COMPLETO|{B}PACK{B}|{B}BATCH{B}){B}";
/// Faixa de episódios (`rangePattern`): separador `[.\-s]*` como nos cards.
const VACA_RANGE: &str = r"(?i)(?:EPIS[ÓO]DIOS?|EP|CAP[ÍI]TULOS?|CAP|E)[.\-s]*[0-9]{1,3}[.\s-]*(?:A|AO|[-–—])[.\s-]*[0-9]{1,3}{B}";

static EPISODES: LazyLock<EpisodeRules> =
    LazyLock::new(|| EpisodeRules::new(VACA_PACK, VACA_RANGE));

static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(r"(?i)<a{FB}([^>]*)>([\s\S]*?)</a>")).expect("âncora do vaca")
});

/// Marcadores de áudio do `classifyAudio` do vaca (texto já em maiúsculas).
static AUDIO_PT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("PORTUGU[ÊE]S|PORTUGUES").expect("regex áudio pt"));
static AUDIO_FOREIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("INGL[ÊE]S|INGLES|ESPANHOL|JAPON[ÊE]S|COREANO|LEGENDAD|ORIGINAL")
        .expect("regex áudio estrangeiro")
});

/// `classifyAudio`: PT com idioma estrangeiro é `dual`; só PT, `dublado`; só estrangeiro, `legendado`.
fn classify_audio(context: &str) -> Option<String> {
    let text = context.to_uppercase();
    let has_pt = AUDIO_PT.is_match(&text);
    let has_foreign = AUDIO_FOREIGN.is_match(&text);
    let label = match (has_pt, has_foreign) {
        (true, true) => "dual",
        (true, false) => "dublado",
        (false, true) => "legendado",
        (false, false) => return None,
    };
    Some(label.to_string())
}

/// Protetores do vaca: base do TS + `systemtech.space` do site.
fn is_vaca_protector_host(host: &str) -> bool {
    host_matches(host, BASE_PROTECTOR_SUFFIXES) || host_matches(host, &["systemtech.space"])
}

/// Opções de `parseDownloadLinks(html, url, options)`: temporada e título real do batch.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VacaParseOptions {
    pub season: Option<u32>,
    pub real_title: Option<String>,
}

struct Hooks {
    opts: VacaParseOptions,
}

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
        let anchor_text = strip_tags(caps.get(2).map_or("", |m| m.as_str()));
        // "Veja Online"/player nunca é botão: skip SEM avançar o cursor.
        if is_watch_anchor(attrs, &anchor_text) {
            return Resolved::Skip { advance: false };
        }
        resolve_protector_href(attrs, base_url, &is_vaca_protector_host)
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        strip_tags(caps.get(2).map_or("", |m| m.as_str()))
    }
    fn strip_tags(&self, value: &str) -> String {
        strip_tags(value)
    }
    fn initial_audio(&self) -> Option<String> {
        None
    }
    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        classify_audio(segment)
    }
    fn audio_from_anchor(&self, anchor_text: &str) -> Option<String> {
        classify_audio(anchor_text)
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
        normalize_source_with(context, &VACA_SOURCE_MATCH)
    }
    fn decode_html(&self, html: &str) -> String {
        decode_entities(html)
    }
    /// `extrasOf`: temporada e título real entram em todo botão emitido.
    fn extras(&self, link: &mut ResolverLink) {
        link.season = self.opts.season;
        link.real_title = self.opts.real_title.clone();
    }
}

/// `parseDownloadLinks(html, baseUrl, options)`: normaliza o markup por episódio
/// e roda o coletor. `Err` é o `throw` do desempate que o TS deixa subir.
pub fn post_links_with(
    html: &str,
    post_url: &str,
    opts: &VacaParseOptions,
) -> Result<Vec<ResolverLink>, String> {
    let normalized = normalize_episode_markup(html);
    parse_download_links(&Hooks { opts: opts.clone() }, &normalized, Some(post_url))
}

/// `cleanMarkTitle`: tira "Vaca Torrent", "Download", "Baixar", "ver online" e
/// o áudio do título do post, em passos separados (a ordem é a do TS).
static CLEAN_STEPS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)\s*Vaca\s+Torrent\s*",
        r"(?i)\s*Download\s*",
        r"(?i)\s*Baixar\s*",
        r"(?i)\s*ver\s+online\s*",
        r"(?i)\s*(?:dublado|dublada|legendado|legendada){B}",
    ]
    .iter()
    .map(|p| compile(p))
    .collect()
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("regex espaços"));

pub fn clean_mark_title(title: &str) -> String {
    let mut out = decode_entities(title);
    for re in CLEAN_STEPS.iter() {
        out = re.replace_all(&out, " ").into_owned();
    }
    SPACES.replace_all(&out, " ").trim().to_string()
}

fn has_real_title(link: &ResolverLink) -> bool {
    link.real_title.as_deref().is_some_and(|t| !t.is_empty())
}

/// `titleOf`: o título real do batch vence o título do post.
fn title_of(post: &SitePost, link: &ResolverLink) -> String {
    match link.real_title.as_deref().filter(|t| !t.is_empty()) {
        Some(real) => real.to_string(),
        None => post.title.clone(),
    }
}

/// `seasonOf`/`episodeOf`/`yearOf`: só valem sem título real (o batch já traz o nome).
fn season_of(_post: &SitePost, link: &ResolverLink) -> String {
    match link.season.filter(|_| !has_real_title(link)) {
        Some(s) => format!("S{s:02}"),
        None => String::new(),
    }
}

fn episode_of(_post: &SitePost, link: &ResolverLink) -> String {
    match link.episode.filter(|_| !has_real_title(link)) {
        Some(e) => format!("E{e:02}"),
        None => String::new(),
    }
}

fn year_of(post: &SitePost, link: &ResolverLink) -> String {
    match post.year.filter(|y| *y != 0 && !has_real_title(link)) {
        Some(y) => format!(" ({y})"),
        None => String::new(),
    }
}

/// `audioTagOf` do vaca: `dual` vira DUAL (o default do núcleo não tem).
fn audio_tag_of(link: &ResolverLink) -> Option<String> {
    match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO".into()),
        Some("dual") => Some("DUAL".into()),
        Some("legendado") => Some("LEGENDADO".into()),
        _ => None,
    }
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    title_of: Some(title_of),
    audio_tag_of: Some(audio_tag_of),
    season_of: Some(season_of),
    episode_of: Some(episode_of),
    year_of: Some(year_of),
    ..ReleaseTitleConfig::new(clean_mark_title)
};

impl SiteOutput for Vaca {
    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        post_links_with(html, post_url, &VacaParseOptions::default())
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
