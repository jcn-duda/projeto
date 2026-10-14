//! TorrentDosFilmes (`resolvers/profiles/torrentdosfilmes.ts` +
//! `torrentdosfilmes-parsers.ts`). Botões pelo `createTdfDownloadLinks`: o
//! magnet vem direto no `href` (ou um protetor da allowlist base), o episódio
//! usa o escopo `segment-only` com o par ESTREITO (`NARROW_*`, sem desempate) e
//! o áudio é o `NERD_AUDIO` com `desconhecido` inicial. Qualidade e fonte têm
//! classificadores PRÓPRIOS (a fonte sai com `[. ]` trocado por `-`). O título
//! usa a limpeza curta do próprio perfil. Todo `stripTags`/`href` do perfil
//! decodifica com `decodeEntitiesBasic`, a variante histórica, não a rica do
//! núcleo. O feed compacto com `<enclosure>` entra aqui pelo `br_core::rss_xml`
//! (a data do `pubDate` é injetada para o golden ser reprodutível).

use std::sync::LazyLock;

use adom_crawl::profile_parsers::{ResolverLink, BASE_PROTECTOR_SUFFIXES};
use adom_crawl::resolver_matching::is_generic_list_post;
use adom_crawl::resolver_text::strip_tags_with;
use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;
use url::Url;

use super::{host_matches, SiteOutput};
use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::episode::{EpisodeScope, EpisodeStepConfig, NARROW_EPISODE, NARROW_PACK_RESET};
use crate::common::http_date::http_date_now;
use crate::common::release::FB;
use crate::common::rules::{attribute, compile, last_audio_marker, NERD_AUDIO, NERD_LEGENDADO};
use crate::common::{
    release_title, rss_xml, search_page_html, ReleaseTitleConfig, RssConfig, SearchItem, SitePost,
};

pub struct Tdf;

pub static TDF: Tdf = Tdf;

// ─── decodificador do perfil (`decodeEntitiesBasic`) ─────────────────────

static ENT_AMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&#0?38;|&amp;").expect("amp"));
static ENT_QUOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&quot;").expect("quot"));
static ENT_APOS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#8217;|&#039;|&apos;").expect("apos"));
static ENT_NBSP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)&nbsp;").expect("nbsp"));

/// `decodeEntitiesBasic` de `resolvers/text.ts`: quatro substituições em
/// sequência, na mesma ordem do JS (o `&amp;` decodificado pode formar `&quot;`).
pub fn decode_entities_basic(value: &str) -> String {
    let s = ENT_AMP.replace_all(value, "&");
    let s = ENT_QUOT.replace_all(&s, "\"");
    let s = ENT_APOS.replace_all(&s, "'");
    ENT_NBSP.replace_all(&s, " ").into_owned()
}

// ─── episódio (`NARROW_PACK_RESET_RE` / `NARROW_EPISODE_RE`) ─────────────

static PACK: LazyLock<Regex> = LazyLock::new(|| compile(NARROW_PACK_RESET));
static EP: LazyLock<Regex> = LazyLock::new(|| compile(NARROW_EPISODE));

// ─── qualidade e fonte (classificadores do tdf) ──────────────────────────

/// `TDF_QUALITY_RE`: `\b(\d{3,4})\s*P\b` ou `\b(4K)\b`, sobre o contexto em
/// maiúsculas. Sem grupo 1 (é o 4K) a qualidade vira 2160.
static QUALITY: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}(?:([0-9]{3,4})\s*P{B}|(4K){B})"));
/// `TDF_SOURCE_RE`: sem fronteira de palavra, como no TS.
static SOURCE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(REMUX|BLU[- ]?RAY|WEB[-. ]?DL|WEB[-. ]?RIP|HDTV|CAMRIP|CAM)")
        .expect("regex de fonte do tdf")
});

/// `qualityOf`: vale o ÚLTIMO token do contexto.
fn tdf_quality(context: &str) -> Option<u32> {
    let last = QUALITY.captures_iter(context).last()?;
    match last.get(1) {
        Some(digits) => digits.as_str().parse().ok(),
        None => Some(2160),
    }
}

/// `sourceOf`: última fonte do contexto, `[. ]` trocado por `-`.
fn tdf_source(context: &str) -> Option<String> {
    let last = SOURCE.captures_iter(context).last()?;
    let token = last.get(1)?.as_str();
    Some(token.replace(['.', ' '], "-"))
}

// ─── título (`cleanPostTitle` do perfil, variante curta) ─────────────────

static TORRENT_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*Torrent\s*(?:[–-]|&#8211;)?\s*").expect("torrent"));
static RESOLUTION_RUN: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i){B}(?:720p|1080p|2160p|4K)(?:\s*/\s*(?:720p|1080p|2160p|4K|5\.1|dual|dublado|legendado))*",
    )
});
static PIXEL_TOKEN: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i){B}[0-9]{3,4}p{B}"));
static SHOWCASE_WORD: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r"(?i){B}(?:Dublado|Legendado|Dual\s*Áudio|Download|Online|Grátis|Completo|Completa){B}",
    )
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("espaços"));

/// Limpeza do título do post do tdf. Não decodifica entidades e não tira fonte
/// nem canal de áudio (ficam no título da release), diferente do núcleo.
pub fn clean_post_title(title: &str) -> String {
    let s = TORRENT_WORD.replace_all(title, " ");
    let s = RESOLUTION_RUN.replace_all(&s, "");
    let s = PIXEL_TOKEN.replace_all(&s, "");
    let s = SHOWCASE_WORD.replace_all(&s, "");
    SPACES.replace_all(&s, " ").trim().to_string()
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig::new(clean_post_title);

// ─── botões do post ──────────────────────────────────────────────────────

/// `<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)</a>` do coletor do tdf.
static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r#"(?i)<a{FB}[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)</a>"#
    ))
    .expect("âncora do tdf")
});

fn is_protector_host(host: &str) -> bool {
    host_matches(host, BASE_PROTECTOR_SUFFIXES)
}

struct Hooks;

impl CollectorHooks for Hooks {
    fn anchor_re(&self) -> &FancyRegex {
        &ANCHOR
    }
    /// `resolveHref` do tdf: magnet cru por prefixo case-sensitive; senão URL
    /// ABSOLUTA com host de protetor. Qualquer outra coisa é descartada sem
    /// avançar o cursor (a âncora é transparente).
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        _html: &str,
        _base_url: Option<&str>,
    ) -> Resolved {
        let raw = decode_entities_basic(caps.get(1).map_or("", |m| m.as_str()));
        if raw.starts_with("magnet:?") {
            return Resolved::Url(raw);
        }
        let Ok(parsed) = Url::parse(&raw) else {
            return Resolved::Skip { advance: false };
        };
        if !is_protector_host(parsed.host_str().unwrap_or("")) {
            return Resolved::Skip { advance: false };
        }
        Resolved::Url(raw)
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        strip_tags_with(
            caps.get(2).map_or("", |m| m.as_str()),
            decode_entities_basic,
        )
    }
    fn strip_tags(&self, value: &str) -> String {
        strip_tags_with(value, decode_entities_basic)
    }
    fn initial_audio(&self) -> Option<String> {
        Some("desconhecido".into())
    }
    fn audio_from_segment(&self, segment: &str) -> Option<String> {
        last_audio_marker(segment, &NERD_AUDIO, &NERD_LEGENDADO)
    }
    /// `scope: 'segment-only'`, par estreito, sem desempate: a âncora nunca
    /// escreve no estado do episódio.
    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        EpisodeStepConfig {
            scope: EpisodeScope::SegmentOnly,
            pack: &PACK,
            range: None,
            ep: &EP,
            extract: None,
            pack_match_all: None,
            tie_break: false,
            ep_range_group: None,
        }
        .step(segment, anchor, state)
    }
    fn quality(&self, context: &str) -> Option<u32> {
        tdf_quality(context)
    }
    fn source(&self, context: &str) -> Option<String> {
        tdf_source(context)
    }
}

// ─── busca ───────────────────────────────────────────────────────────────

/// `<div class="title"><a ...>...</a>` (theme ComandoFilmes), `\b` ASCII.
static CARD: LazyLock<Regex> = LazyLock::new(|| {
    compile(
        r#"(?i)<div{B}[^>]*class=["'][^"']*{B}title{B}[^"']*["'][^>]*>\s*<a{B}([^>]*)>([\s\S]*?)</a>"#,
    )
});

/// `parsePosts` do tdf: o `title` do atributo vence o texto da âncora (o
/// theme trunca o texto com reticências). Post sem href ou genérico sai. A
/// URL é resolvida contra a base do site. Duplicado: a posição é a do 1º,
/// o valor é o do último (semântica do `new Map` do JS).
pub fn parse_search_posts(html: &str, base_url: &str) -> Vec<SitePost> {
    let mut found: Vec<SitePost> = Vec::new();
    for caps in CARD.captures_iter(html) {
        let attrs = caps.get(1).map_or("", |m| m.as_str());
        let inner = caps.get(2).map_or("", |m| m.as_str());
        let href = attribute(attrs, "href").unwrap_or_default();
        if href.is_empty() {
            continue;
        }
        let title_source = attribute(attrs, "title")
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| inner.to_string());
        let clean = strip_tags_with(&title_source, decode_entities_basic);
        if is_generic_list_post(&clean) {
            continue;
        }
        let Some(url) = join_url(&decode_entities_basic(&href), base_url) else {
            continue;
        };
        found.push(SitePost {
            kind: None,
            title: clean,
            url,
            poster: None,
            date: None,
            year: None,
        });
    }
    let mut out: Vec<SitePost> = Vec::new();
    for post in found {
        match out.iter().position(|p| p.url == post.url) {
            Some(i) => out[i] = post,
            None => out.push(post),
        }
    }
    out
}

/// `new URL(href, base).href`. `None` quando não resolve (o TS lança).
fn join_url(href: &str, base_url: &str) -> Option<String> {
    let base = Url::parse(base_url).ok()?;
    base.join(href).ok().map(|u| u.to_string())
}

/// Feed torznab compacto do tdf com a data de publicação injetada. O TS
/// carimba `new Date().toUTCString()` em cada item; o oráculo congela o
/// relógio e o Rust recebe a data por parâmetro para o golden ser reprodutível.
pub fn feed_with_date(
    self_url: &str,
    items: &[SearchItem],
    category: u32,
    pub_date: &str,
) -> String {
    let cfg = RssConfig {
        self_url,
        channel_title: "TorrentDosFilmes V2",
        title_of: &|post: &SitePost, link: &ResolverLink| release_title(&TITLE, post, link, None),
        pub_date_of: &|_post: &SitePost| pub_date.to_string(),
        with_description: false,
        seeders_comment: None,
        with_enclosure: true,
        compact: true,
    };
    rss_xml(&cfg, items, category)
}

impl SiteOutput for Tdf {
    fn name(&self) -> &'static str {
        "torrentdosfilmes"
    }

    fn search_posts(&self, html: &str, base_url: &str) -> Vec<SitePost> {
        parse_search_posts(html, base_url)
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
            &|_| String::new(),
            &|post| Some(post.title.clone()),
        )
    }

    fn rss_xml(&self, self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        // O `rss_xml` do trait usa o relógio real; o golden usa `feed_with_date`.
        let now = http_date_now();
        Some(feed_with_date(self_url, items, category, &now))
    }
}
