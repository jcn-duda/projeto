//! Bludv (`resolvers/profiles/bludv.ts` + `bludv-parsers.ts`).
//!
//! Peças próprias do site, fora do núcleo comum: neste módulo ficam o coletor de
//! botões e os posts da busca; o cartão da página vai em `bludv_card.rs`, o feed
//! torznab em `bludv_feed.rs` e o portão de anúncio em `bludv_gate.rs`.
//! - o coletor de botões (`createParseDownloadLinks`): âncora SEM decodificação
//!   do HTML inteiro, href decodificado só no botão, magnet direto validado
//!   pelo `xt=urn:btih:` e protetor só por host absoluto (sem base);
//! - os posts da busca (`createParsePosts`): regex própria, href decodificado,
//!   janela do cartão limitada pelo próximo `<div class="post">`;
//! - a página do Cardigann em cartão multilinha (`createSearchPageHtml`), que
//!   NÃO é o layout compacto do núcleo `common::page`.

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::common::text::decode_entities;
use crate::common::text::strip_tags;
use adom_crawl::profile_parsers::{ResolverLink, BASE_PROTECTOR_SUFFIXES};
use adom_crawl::resolver_matching::is_generic_list_post;
use fancy_regex::{Captures, Regex as FancyRegex};
use regex::Regex;
use url::Url;

use super::{host_matches, SiteOutput};
use crate::common::collector::{parse_download_links, CollectorHooks, Resolved, Step};
use crate::common::episode::{EpisodeRules, EpisodeScope, EpisodeStepConfig, PackMatchAll};
use crate::common::http_date::http_date_now;
use crate::common::rules::{
    br_audio_from_anchor, br_audio_from_segment, normalize_quality, normalize_source,
};
use crate::common::{clean_post_title, release_title, ReleaseTitleConfig, SearchItem, SitePost};

#[path = "bludv_card.rs"]
mod card;
#[path = "bludv_feed.rs"]
mod feed;
#[path = "bludv_gate.rs"]
mod gate;

pub use card::{card_html, CardRow};
pub use feed::{feed_with_date, parse_post_date};

pub struct Bludv;

pub static BLUDV: Bludv = Bludv;

/// `MAX_CARD_WINDOW` do TS: janela do cartão do post, em unidades UTF-16.
const MAX_CARD_WINDOW: usize = 8000;
const POST_MARK: &str = r#"<div class="post">"#;

// ─── coletor de botões ───────────────────────────────────────────────────

/// `anchorRe` do coletor: `(["'])` e `\1` pedem backreference, por isso fancy.
static ANCHOR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r#"(?i)<a\s+[^>]*?href\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)</a>"#)
        .expect("âncora do bludv")
});
static EPISODES: LazyLock<EpisodeRules> = LazyLock::new(EpisodeRules::default_rules);

static MAGNET_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^magnet:").expect("esquema magnet"));
static XT_BTIH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)").expect("parâmetro xt=urn:btih")
});

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    strip_source: true,
    with_size: false,
    ..ReleaseTitleConfig::new(clean_post_title)
};

/// `isValidBtihHash`: 40 hex OU 32 base32 (A-Z, 2-7), sem distinguir caixa.
fn is_valid_btih_hash(hash: &str) -> bool {
    let h = hash.trim();
    let hex = h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit());
    let base32 = h.len() == 32
        && h.bytes()
            .all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b));
    hex || base32
}

/// `isValidMagnetUri`: magnet com pelo menos um `xt=urn:btih:` e TODOS os
/// `xt=urn:btih:` com hash válido, em qualquer posição da query.
fn is_valid_magnet_uri(value: &str) -> bool {
    if !MAGNET_SCHEME.is_match(value) {
        return false;
    }
    let query = value.find('?').map_or("", |q| &value[q + 1..]);
    let mut found = false;
    for param in query.split('&') {
        let Some(caps) = XT_BTIH.captures(param) else {
            continue;
        };
        if !is_valid_btih_hash(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

/// `hasAllowedHost` contra a base de protetores (o bludv não tem extra).
fn is_protector_host(host: &str) -> bool {
    host_matches(host, BASE_PROTECTOR_SUFFIXES)
}

struct Hooks;

impl CollectorHooks for Hooks {
    fn anchor_re(&self) -> &FancyRegex {
        &ANCHOR
    }
    /// `resolveHref` do bludv: href decodificado e aparado; magnet direto ou
    /// URL ABSOLUTA de protetor. Nunca avança o cursor (`advance` é false).
    fn resolve_href(
        &self,
        caps: &Captures<'_, str>,
        _html: &str,
        _base_url: Option<&str>,
    ) -> Resolved {
        let href = decode_entities(caps.get(2).map_or("", |m| m.as_str()).trim());
        if is_valid_magnet_uri(&href) {
            return Resolved::Url(href);
        }
        let Ok(parsed) = Url::parse(&href) else {
            return Resolved::Skip { advance: false };
        };
        if !is_protector_host(parsed.host_str().unwrap_or("")) {
            return Resolved::Skip { advance: false };
        }
        Resolved::Url(href)
    }
    fn anchor_text_of(&self, caps: &Captures<'_, str>) -> String {
        strip_tags(caps.get(3).map_or("", |m| m.as_str()))
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
    /// `episodeStep` com escopo `anchor-local`: o sinal da âncora vale só para o
    /// botão. `packMatchAll` é o clone `/g` do padrão de pack (sem `throw`).
    fn episode_step(
        &self,
        segment: &str,
        anchor: &str,
        state: Option<u32>,
    ) -> Result<Step, String> {
        let rules = &*EPISODES;
        EpisodeStepConfig {
            scope: EpisodeScope::AnchorLocal,
            pack: &rules.pack,
            range: Some(&rules.range),
            ep: &rules.episode,
            extract: Some(rules),
            pack_match_all: Some(PackMatchAll::Regex(&rules.pack)),
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
}

// ─── posts da busca ──────────────────────────────────────────────────────

/// Post da busca com a descrição (`post.original`, "Título Original"), que o
/// cartão mostra e que não cabe em `SitePost`.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchEntry {
    pub post: SitePost,
    pub original: Option<String>,
}

/// `<div class="post">…<div class="title"><a href>…</a>`: a regex do TS é SEM
/// flag `i` e usa `\1` para casar as aspas do href.
static RE_POST: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        r#"<div class="post">[\s\S]*?<div class="title">\s*<a\s+[^>]*?href=(["'])([^"']+)\1[^>]*>([\s\S]*?)</a>"#,
    )
    .expect("cartão do bludv")
});
static RE_POSTER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"<img[^>]+src="([^"]+)""#).expect("poster do bludv"));
static RE_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9]{2}/[0-9]{2}/[0-9]{4})").expect("data do bludv"));
static RE_ORIGINAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)T[íi]tulo\s*Original:[^<\n]{0,60}(?:<[^>]+>\s*)?([^<\n]{2,80})")
        .expect("título original do bludv")
});

/// Início do próximo `<div class="post">` depois de `start` (ou o fim do HTML).
fn next_post_start(html: &str, start: usize) -> usize {
    html[start + 1..]
        .find(POST_MARK)
        .map_or(html.len(), |i| start + 1 + i)
}

/// Fim da janela de `units` unidades UTF-16 a partir de `start` (o `slice` do
/// JS conta UTF-16, não bytes). Nunca corta um caractere ao meio.
fn utf16_window_end(html: &str, start: usize, units: usize) -> usize {
    let mut used = 0usize;
    for (offset, ch) in html[start..].char_indices() {
        if used + ch.len_utf16() > units {
            return start + offset;
        }
        used += ch.len_utf16();
    }
    html.len()
}

/// `createParsePosts` do bludv: posts da página de busca, na ordem do HTML,
/// sem repetir URL e sem os títulos genéricos de lista.
pub fn parse_search_entries(html: &str, base_url: &str) -> Vec<SearchEntry> {
    let Ok(base) = Url::parse(base_url) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in RE_POST.captures_iter(html) {
        // O backtracking do JS não falha; um estouro do fancy para a leitura.
        let Ok(caps) = caps else {
            break;
        };
        let Some(whole) = caps.get(0) else {
            continue;
        };
        let raw = decode_entities(caps.get(2).map_or("", |m| m.as_str()).trim());
        let Ok(url) = base.join(&raw) else {
            continue;
        };
        let url = url.to_string();
        if !seen.insert(url.clone()) {
            continue;
        }
        let start = whole.start();
        let end = next_post_start(html, start).min(utf16_window_end(html, start, MAX_CARD_WINDOW));
        let block = &html[start..end];
        let title = strip_tags(caps.get(3).map_or("", |m| m.as_str()));
        if is_generic_list_post(&title) {
            continue;
        }
        let poster = RE_POSTER
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let date = RE_DATE
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string());
        let original = RE_ORIGINAL
            .captures(block)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string());
        out.push(SearchEntry {
            post: SitePost {
                kind: None,
                title,
                url,
                poster,
                date,
                year: None,
            },
            original,
        });
    }
    out
}

/// Só os posts (título, URL e poster), como o `parsePosts` do profile.
pub fn parse_search_posts(html: &str, base_url: &str) -> Vec<SitePost> {
    parse_search_entries(html, base_url)
        .into_iter()
        .map(|entry| entry.post)
        .collect()
}

impl SiteOutput for Bludv {
    fn name(&self) -> &'static str {
        "bludv"
    }

    fn search_posts(&self, html: &str, base_url: &str) -> Vec<SitePost> {
        parse_search_posts(html, base_url)
    }

    /// Um post que falha sai do lote; a busca continua. O TS faz isso no `mapLimit`
    /// compartilhado (`concurrency.ts` captura, loga `post sem botões` e filtra),
    /// não no perfil. Sem este override o portão de anúncio de um post virava 502
    /// no `/search` inteiro, e o Jackett passava a tratar o card como fonte caída
    /// ("The tracker seems to be down") — o TS devolvia 200 com o que existisse.
    /// O motivo do portão continua visível: no log do drop e no 502 do `/resolve`.
    fn post_error_is_empty(&self) -> bool {
        true
    }

    fn post_links(&self, html: &str, post_url: &str) -> Result<Vec<ResolverLink>, String> {
        // Fase 4: o portão de anúncio só vira motivo quando não sobrou botão, na
        // mesma ordem do TS (`assertNoAdGate` depois do parse). Errar com link
        // aproveitável presente faria o detector jogar fora release boa.
        let links = parse_download_links(&Hooks, html, Some(post_url))?;
        gate::assert_blocked(html, links.len())?;
        Ok(links)
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    /// Sem a descrição do post: o trait só carrega `SearchItem`. Quem monta a
    /// página da busca com `post.original` usa `card_html` direto.
    fn search_page_html(&self, self_url: &str, items: &[SearchItem]) -> String {
        let rows: Vec<CardRow<'_>> = items
            .iter()
            .map(|item| CardRow {
                item,
                original: None,
            })
            .collect();
        card_html(self_url, &rows)
    }

    /// Fase 4: feed torznab do BLUDV (`bludv_feed.rs`). O TS usa
    /// `createBludvRssXml` com `withDescription: true` e `seedersComment`. O
    /// `pubDate` vem da data do post (`parsePostDate`); sem data, do relógio
    /// real — e é por isso que o golden chama `feed_with_date` com a data
    /// congelada pelo oráculo.
    fn rss_xml(&self, self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        Some(feed_with_date(self_url, items, category, &http_date_now()))
    }
}
