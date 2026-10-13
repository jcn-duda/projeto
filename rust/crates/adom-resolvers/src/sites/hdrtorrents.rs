//! HDR Torrents (`resolvers/profiles/hdrtorrents.ts` + `hdrtorrents-parsers.ts`).
//!
//! Três pontos que não são o núcleo comum e por isso moram aqui:
//! - o magnet é DIRETO no HTML do post: a página sintética põe o magnet no
//!   `href` da linha, sem `/resolve`;
//! - o áudio é o `classifyAudio` próprio do HDR (DUAL vence DUBLADO), e o
//!   título da release leva DUBLADO/DUAL/LEGENDADO sem tamanho;
//! - entidades e `isValidMagnetUri` seguem `resolvers/text.ts` e
//!   `bludv-parsers.ts`, não as variantes do `adom-core`/`adom-crawl`: a tabela
//!   de nomes é a curta, o `xt` aceita caixa e espaço, e a magnet não é
//!   normalizada (só decodificada).
//!
//! Divergências conhecidas e aceitas: `\s` das regex é o Unicode (o JS exclui
//! U+0085 e inclui U+FEFF); entidade numérica de surrogate falha aqui (o JS
//! produz um surrogate solto). Ambas ficam fora do golden.

use std::collections::HashSet;
use std::sync::LazyLock;

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::escape_xml;
use regex::Regex;
use url::Url;

use super::SiteOutput;
use crate::common::rules::{normalize_quality, normalize_source};
use crate::common::{
    clean_post_title, release_title, ReleaseTitleConfig, SearchItem, SitePost, UNKNOWN_SIZE,
};

#[path = "hdrtorrents_text.rs"]
mod text;

use text::{decode_entities_ts, decode_uri_component, strip_tags_ts};

/// Card da listagem (`HDRWork` do TS).
#[derive(Debug, Clone, PartialEq)]
pub struct HdrWork {
    pub url: String,
    pub title: String,
    pub year: Option<u32>,
    pub poster: Option<String>,
    /// "Filme", "Série" ou "Desenho".
    pub kind: Option<&'static str>,
    pub quality: Option<String>,
}

pub struct Hdr;

pub static HDR: Hdr = Hdr;

// ─── regex (paridade com o JS: `\b` ASCII via `(?-u:\b)`, `\d` = `[0-9]`) ──

static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a(?-u:\b)[^>]*?(?-u:\b)href=["']([^"']+)["'][^>]*?(?-u:\b)class=["'][^"']*media-card-link[^"']*["'][^>]*>([\s\S]*?)</a>"#)
        .expect("card da listagem")
});
static CARD_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-title[^"']*["'][\s\S]*?>([\s\S]*?)$"#)
        .expect("título")
});
static CARD_YEAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-year[^"']*["'][\s\S]*?>\s*\(?([0-9]{4})\)?"#)
        .expect("ano")
});
static CARD_TYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*badge-tipo[^"']*["'][\s\S]*?>([\s\S]*?)</(?:span|div|a)"#)
        .expect("tipo")
});
static CARD_QUALITY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)class=["'][^"']*badge-qualidade[^"']*["'][\s\S]*?>([\s\S]*?)</(?:span|div|a)"#,
    )
    .expect("qualidade")
});
static CARD_POSTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*media-card-cover[^"']*["'][\s\S]*?>\s*<img[\s\S]*?(?-u:\b)(?:data-)?src=["']([^"']+)["']"#)
        .expect("capa")
});
static KIND_SERIE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)s[ée]rie").expect("série"));
static KIND_DESENHO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)desenho|anima").expect("desenho"));
static KIND_FILME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)filme").expect("filme"));

static ROW_SPLIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div[^>]*class=["'][^"']*download-row[^"']*["'][^>]*>"#).expect("linha")
});
static ROW_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)class=["'][^"']*download-name[^"']*"[^>]*>([\s\S]*?)</div"#)
        .expect("nome da linha")
});
static ROW_MAGNET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a(?-u:\b)[^>]*href=["'](magnet:[^"']+)["']"#).expect("magnet da linha")
});
static TECH_SIZE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)Tamanho[\s\S]{0,40}?([0-9.,]+\s*(?:TB|GB|MB|KB))").expect("tamanho")
});

// classifyAudio: roda sobre o texto em caixa-alta, como no TS.
static AUDIO_LEG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"LEGENDAD|\[\s*LEG\s*\]|\(\s*LEG\s*\)").expect("legendado"));
static AUDIO_DUAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"DUAL[-\s]*[AÁ]UDIO|AUDIO[-\s]*DUPLO").expect("dual"));
static AUDIO_DUB: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"DUBLAD|(?-u:\b)DUB(?-u:\b)|NACIONAL|PORTUGU[ÊE]S").expect("dublado")
});
static EP_SHORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[Ee]([0-9]{1,3})(?-u:\b)").expect("ep"));
static EP_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)EPIS[ÓO]DIO\s*([0-9]+)").expect("episódio"));
static DN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[?&]dn=([^&]+)").expect("dn"));
static XT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)").expect("xt"));

// ─── magnet e áudio ───────────────────────────────────────────────────────

/// `isValidBtihHash` do `bludv-parsers.ts`: 40 hex ou 32 base32.
fn is_valid_btih(hash: &str) -> bool {
    let h = hash.trim();
    (h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        || (h.len() == 32
            && h.bytes()
                .all(|b| b.is_ascii_alphabetic() || (b'2'..=b'7').contains(&b)))
}

/// `isValidMagnetUri` do `bludv-parsers.ts`: `xt=urn:btih:` válido em qualquer
/// posição da query; `xt` e `urn:btih:` sem diferença de caixa.
fn is_valid_magnet_ts(value: &str) -> bool {
    if !value
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("magnet:"))
    {
        return false;
    }
    let Some(q) = value.find('?') else {
        return false;
    };
    let mut found = false;
    for param in value[q + 1..].split('&') {
        let Some(caps) = XT.captures(param) else {
            continue;
        };
        if !is_valid_btih(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

/// `classifyAudio` do HDR: DUAL vence DUBLADO ("DUBLADO DUAL AUDIO").
fn classify_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if AUDIO_LEG.is_match(&text) {
        Some("legendado")
    } else if AUDIO_DUAL.is_match(&text) {
        Some("dual")
    } else if AUDIO_DUB.is_match(&text) {
        Some("dublado")
    } else {
        None
    }
}

/// `extractEpisodeFromName`: `E01` solto, senão `EPISÓDIO 12`.
fn extract_episode(name: &str) -> Option<u32> {
    EP_SHORT
        .captures(name)
        .or_else(|| EP_WORD.captures(name))
        .and_then(|c| c[1].parse::<u32>().ok())
}

/// `dn=` do magnet, decodificado; ausente vira vazio.
fn magnet_dn(magnet: &str) -> Result<String, String> {
    match DN.captures(magnet) {
        Some(caps) => decode_uri_component(&caps[1]),
        None => Ok(String::new()),
    }
}

/// `extractSizeFromTechSheet`: a ficha publica uma vez por obra, em `<dd>`.
fn tech_sheet_size(html: &str) -> Option<String> {
    TECH_SIZE.captures(html).map(|c| c[1].replacen(',', ".", 1))
}

// ─── parsers ──────────────────────────────────────────────────────────────

/// `parseListingHtml(html, baseUrl)`: um card por `.media-card-link`, sem repetir URL.
/// O título do TS é o texto depois do primeiro `>` da tag do título até o fim
/// do bloco, então o ano da `<span>` entra nele (ex.: "Título (2026)").
pub fn parse_listing_html(html: &str, base_url: &str) -> Result<Vec<HdrWork>, String> {
    let base = Url::parse(base_url).ok();
    let root = format!("{base_url}/");
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for caps in BLOCK.captures_iter(html) {
        let href = decode_entities_ts(&caps[1])?;
        let inner = &caps[2];
        if inner.is_empty() {
            continue;
        }
        let Some(resolved) = base
            .as_ref()
            .and_then(|b| b.join(&href).ok())
            .map(String::from)
        else {
            continue;
        };
        if resolved == base_url || resolved == root {
            continue;
        }
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let title = match CARD_TITLE.captures(inner) {
            Some(c) => strip_tags_ts(&c[1])?,
            None => String::new(),
        };
        if title.is_empty() {
            continue;
        }
        let year = CARD_YEAR
            .captures(inner)
            .and_then(|c| c[1].parse::<u32>().ok());
        let type_text = match CARD_TYPE.captures(inner) {
            Some(c) => strip_tags_ts(&c[1])?,
            None => String::new(),
        };
        let kind = if KIND_SERIE.is_match(&type_text) {
            Some("Série")
        } else if KIND_DESENHO.is_match(&type_text) {
            Some("Desenho")
        } else if KIND_FILME.is_match(&type_text) {
            Some("Filme")
        } else {
            None
        };
        let quality = match CARD_QUALITY.captures(inner) {
            Some(c) => Some(strip_tags_ts(&c[1])?).filter(|q| !q.is_empty()),
            None => None,
        };
        let poster = match CARD_POSTER.captures(inner) {
            Some(c) => Some(decode_entities_ts(&c[1])?),
            None => None,
        };
        out.push(HdrWork {
            url: resolved,
            title,
            year,
            poster,
            kind,
            quality,
        });
    }
    Ok(out)
}

/// `parseContentMagnets(html)`: uma linha `.download-row` por magnet direto.
fn parse_content_magnets(html: &str) -> Result<Vec<ResolverLink>, String> {
    if html.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for row in ROW_SPLIT.split(html).skip(1) {
        let name = match ROW_NAME.captures(row) {
            Some(c) => strip_tags_ts(&c[1])?,
            None => String::new(),
        };
        let Some(caps) = ROW_MAGNET.captures(row) else {
            continue;
        };
        let magnet = decode_entities_ts(&caps[1])?;
        if !is_valid_magnet_ts(&magnet) {
            continue;
        }
        let dn = magnet_dn(&magnet)?;
        out.push(ResolverLink {
            quality: normalize_quality(&name).or_else(|| normalize_quality(&dn)),
            size: None,
            audio: classify_audio(&name).map(String::from),
            episode: extract_episode(&name),
            episode_last: None,
            season: None,
            source: normalize_source(&name).or_else(|| normalize_source(&dn)),
            real_title: None,
            description: (!name.is_empty()).then(|| name.clone()),
            url: magnet,
        });
    }
    if let Some(size) = tech_sheet_size(html) {
        for link in &mut out {
            if link.size.is_none() {
                link.size = Some(size.clone());
            }
        }
    }
    Ok(out)
}

// ─── saída ────────────────────────────────────────────────────────────────

/// Áudio do botão no título: DUBLADO, DUAL ou LEGENDADO (sem tamanho na tag).
fn audio_tag(link: &ResolverLink) -> Option<String> {
    match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO".into()),
        Some("dual") => Some("DUAL".into()),
        Some("legendado") => Some("LEGENDADO".into()),
        _ => None,
    }
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    with_size: false,
    audio_tag_of: Some(audio_tag),
    ..ReleaseTitleConfig::new(clean_post_title)
};

/// Página sintética do Cardigann: o href de cada linha É o magnet (sem /resolve).
/// Não usa o `search_page_html` do núcleo: o layout tem a linha `post` e o
/// tamanho sentinela, e a descrição cai no título do post.
fn search_page(items: &[SearchItem]) -> String {
    let rows: String = items
        .iter()
        .map(|item| {
            let title = release_title(&TITLE, &item.post, &item.link, Some(item.index));
            let description = match item.link.description.as_deref().filter(|d| !d.is_empty()) {
                Some(d) => d.to_string(),
                None => item.post.title.clone(),
            };
            let size = item
                .link
                .size
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(UNKNOWN_SIZE);
            format!(
                r#"<div class="release"><div class="title"><a href="{}">{}</a></div><div class="size">{}</div><div class="post"><a href="{}">{}</a></div><div class="description">{}</div><div class="seeders">1</div></div>"#,
                escape_xml(&item.link.url),
                escape_xml(&title),
                escape_xml(size),
                escape_xml(&item.post.url),
                escape_xml(&item.post.url),
                escape_xml(&description),
            )
        })
        .collect();
    format!(r#"<!doctype html><html><body><div class="posts">{rows}</div></body></html>"#)
}

impl SiteOutput for Hdr {
    fn name(&self) -> &'static str {
        "hdrtorrents"
    }

    fn post_error_is_empty(&self) -> bool {
        true
    }

    fn post_links(&self, html: &str, _post_url: &str) -> Result<Vec<ResolverLink>, String> {
        parse_content_magnets(html)
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    fn search_page_html(&self, _self_url: &str, items: &[SearchItem]) -> String {
        search_page(items)
    }
}
