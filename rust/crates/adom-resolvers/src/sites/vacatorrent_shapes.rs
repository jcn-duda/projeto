//! Formas de página do VacaTorrent (`resolvers/profiles/vacatorrent-shapes.ts`):
//! link da página de botões do filme, URL do season-internal, cards de temporada
//! e batch, título do batch, normalização do markup por episódio e âncora de
//! assistir. Paridade com o JS: `\b` é ASCII (`(?-u:\b)` / `FB`), `\d` é `[0-9]`.

use std::collections::HashSet;
use std::sync::LazyLock;

use adom_crawl::profile_parsers::b64_decode;
use adom_crawl::resolver_text::strip_tags_with;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use url::Url;

use crate::common::release::FB;
use crate::common::rules::{attribute, compile};

/// `new URL(href, baseUrl).href` do JS: `None` quando a URL não resolve.
pub(crate) fn resolve_url(href: &str, base: Option<&str>) -> Option<String> {
    match base {
        Some(b) => Url::parse(b)
            .and_then(|base| base.join(href))
            .ok()
            .map(|u| u.to_string()),
        None => Url::parse(href).ok().map(|u| u.to_string()),
    }
}

// ─── texto (`decodeEntities` de `resolvers/text.ts`) ─────────────────────
// O vaca usa a tabela PEQUENA desse módulo, não o `decode_entities` do
// adom-core (que é o de `src/utils/title-normalization.ts`, com mais nomes:
// `&ordf;` é o caso que diverge). Por isso o decoder fica aqui.

/// `NAMED_ENTITIES` do `resolvers/text.ts`: só estes nomes são decodificados.
fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        "hellip" => "…",
        "ndash" => "–",
        "mdash" => "—",
        "rsquo" => "’",
        "lsquo" => "‘",
        "ldquo" => "“",
        "rdquo" => "”",
        "laquo" => "«",
        "raquo" => "»",
        _ => return None,
    })
}

static HEX_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&#x([0-9a-f]+);").expect("regex &#x"));
static DEC_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"&#([0-9]+);").expect("regex &#"));
static NAMED_ENTITY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)&([a-z]+);").expect("regex entidade nomeada"));

/// Ponto de código como texto; fora de escalar Unicode a entidade fica intacta.
fn codepoint(digits: &str, radix: u32, whole: &str) -> String {
    u32::from_str_radix(digits, radix)
        .ok()
        .and_then(char::from_u32)
        .map_or_else(|| whole.to_string(), |c| c.to_string())
}

/// `decodeEntities` do `resolvers/text.ts`: três passes em sequência (hex, decimal, nomeada).
pub(crate) fn decode_entities(value: &str) -> String {
    let hex = HEX_ENTITY.replace_all(value, |c: &regex::Captures| codepoint(&c[1], 16, &c[0]));
    let dec = DEC_ENTITY.replace_all(&hex, |c: &regex::Captures| codepoint(&c[1], 10, &c[0]));
    NAMED_ENTITY
        .replace_all(&dec, |c: &regex::Captures| {
            named_entity(&c[1].to_lowercase()).map_or_else(|| c[0].to_string(), str::to_string)
        })
        .into_owned()
}

/// `stripTags(value, decodeEntities)` do vaca: tags viram espaço, decodifica, colapsa espaços.
pub(crate) fn strip_tags(value: &str) -> String {
    strip_tags_with(value, decode_entities)
}

// ─── filme ───────────────────────────────────────────────────────────────

static MOVIE_HREF: LazyLock<Regex> =
    LazyLock::new(|| compile(r#"(?i)href=["']([^"']*{B}movie-links{B}[^"']*)["']"#));
static MOVIE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"movie-links/([0-9]+)").expect("regex movie-links id"));

/// Filme: página do post → link da página de botões (`/movie-links/<id>/`).
pub fn extract_movie_links(html: &str, base: Option<&str>) -> Option<String> {
    let href = match MOVIE_HREF.captures(html) {
        Some(c) => c[1].to_string(),
        None => format!("/movie-links/{}/", &MOVIE_ID.captures(html)?[1]),
    };
    resolve_url(&href, base)
}

// ─── série ───────────────────────────────────────────────────────────────

static DATA_U: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)data-u\s*=\s*["']([^"']+)["']"#).expect("regex data-u"));

/// `decodeDataU`: base64 do `data-u`, tolerante como `Buffer.from(s, 'base64')`.
pub fn decode_data_u(html: &str) -> Option<String> {
    let caps = DATA_U.captures(html)?;
    Some(
        String::from_utf8_lossy(&b64_decode(&caps[1]))
            .trim()
            .to_string(),
    )
}

static SEASON_INTERNAL_WORD: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}season-internal{B}"));
static SEASON_INTERNAL_HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)season-internal/\?show=[0-9]+").expect("regex season-internal href")
});
static SHORTLINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\?p=([0-9]{4,})").expect("regex shortlink"));

/// `seriesSeasonInternalUrl`: data-u → href do season-internal → shortlink `?p=`.
/// Cada ramo que não resolve cai no seguinte, como o `try/catch` do TS.
pub fn series_season_internal_url(html: &str, base: Option<&str>) -> Option<String> {
    if let Some(decoded) = decode_data_u(html) {
        if SEASON_INTERNAL_WORD.is_match(&decoded) {
            if let Some(url) = resolve_url(&decoded, base) {
                return Some(url);
            }
        }
    }
    if let Some(m) = SEASON_INTERNAL_HREF.find(html) {
        if let Some(url) = resolve_url(m.as_str(), base) {
            return Some(url);
        }
    }
    let shortlink = SHORTLINK.captures(html)?;
    let path = format!("/pt/season-internal/?show={}", &shortlink[1]);
    resolve_url(&path, base)
}

/// Card de temporada/batch da página season-internal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VacaSeasonCard {
    pub url: String,
    pub is_batch: bool,
    pub season: Option<u32>,
    pub title: String,
}

static ANCHOR: LazyLock<Regex> = LazyLock::new(|| compile(r"(?i)<a{B}([^>]*)>([\s\S]*?)</a>"));
static BATCH_CLASS: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}sa-card-batch{B}"));
static BATCH_HREF: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}batch{B}"));
static SEASON_CLASS: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}sa-card{B}"));
static TEMPORADA_HREF: LazyLock<Regex> = LazyLock::new(|| compile(r"{B}temporada-[0-9]+{B}"));
static TEMPORADA_NUM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)temporada-([0-9]+)").expect("regex temporada"));

/// `parseSeasonInternal`: cards `.sa-card`/`.sa-card-batch` (ou com href de
/// temporada/batch), resolvidos e sem repetição. Classes e href são
/// case-sensitive, como no JS; só o número da temporada é `/i`.
pub fn parse_season_internal(html: &str, base: Option<&str>) -> Vec<VacaSeasonCard> {
    let mut cards = Vec::new();
    let mut seen = HashSet::new();
    for caps in ANCHOR.captures_iter(html) {
        let attrs = &caps[1];
        let classes = attribute(attrs, "class").unwrap_or_default();
        let href = attribute(attrs, "href").unwrap_or_default();
        let href = href.trim();
        if href.is_empty() {
            continue;
        }
        let is_batch = BATCH_CLASS.is_match(&classes) || BATCH_HREF.is_match(href);
        let is_season = SEASON_CLASS.is_match(&classes) || TEMPORADA_HREF.is_match(href);
        if !is_batch && !is_season {
            continue;
        }
        let Some(resolved) = resolve_url(href, base) else {
            continue;
        };
        if !seen.insert(resolved.clone()) {
            continue;
        }
        let season = TEMPORADA_NUM
            .captures(&resolved)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|s| *s > 0);
        cards.push(VacaSeasonCard {
            url: resolved,
            is_batch,
            season,
            title: strip_tags(&caps[2]),
        });
    }
    cards
}

// ─── batch ───────────────────────────────────────────────────────────────

static REPAIR: LazyLock<Vec<(FancyRegex, &'static str)>> = LazyLock::new(|| {
    let fx = |p: &str| FancyRegex::new(p).expect("regex repair de entidades");
    vec![
        (
            fx(r"(?i)(?<![a-z])([0-9]{1,2})\s*ordf(?![a-z0-9])"),
            "${1}ª",
        ),
        (
            fx(r"(?i)(?<![a-z])([0-9]{1,2})\s*ordm(?![a-z0-9])"),
            "${1}º",
        ),
        (
            fx(r"(?i)(?<![a-z])([0-9]{1,2})\s*#(?:170|xaa|x00aa)(?![a-z0-9])"),
            "${1}ª",
        ),
        (
            fx(r"(?i)(?<![a-z])([0-9]{1,2})\s*#(?:186|xba|x00ba)(?![a-z0-9])"),
            "${1}º",
        ),
    ]
});

/// `repairMangledEntities`: ordinais destruídos ("4ordf" = "4ª") voltam ao caractere.
pub fn repair_mangled_entities(value: &str) -> String {
    let mut out = value.to_string();
    for (re, rep) in REPAIR.iter() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

static BATCH_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)^\s*(?:batch|pack){B}[\s:–—|·-]*\s*"));

/// `normalizeBatchTitle`: repara entidades, tira o prefixo "BATCH – " e colapsa espaços.
pub fn normalize_batch_title(raw: &str) -> String {
    let repaired = repair_mangled_entities(raw);
    let stripped = BATCH_PREFIX.replace(&repaired, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

static HERO_TITLE: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?i)class=["'][^"']*{B}bl-hero-title{B}[^"']*["'][^>]*>([\s\S]*?)</"#)
});
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)<h[12]{B}[^>]*>([\s\S]*?)</h[12]>"));

/// `extractBatchTitle`: `.bl-hero-title`, senão o primeiro `h1`/`h2`.
pub fn extract_batch_title(html: &str) -> Option<String> {
    if let Some(caps) = HERO_TITLE.captures(html) {
        return Some(normalize_batch_title(&strip_tags(&caps[1])));
    }
    HEADING
        .captures(html)
        .map(|caps| normalize_batch_title(&strip_tags(&caps[1])))
}

// ─── markup por episódio e âncora de assistir ───────────────────────────

static SS_EP_NUM: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r"(?i)<(span|div){FB}[^>]*{FB}ss-ep-num(?:-inline)?{FB}[^>]*>\s*([0-9]{{1,3}})\s*</\1>"
    ))
    .expect("regex ss-ep-num")
});

/// `normalizeEpisodeMarkup`: `<div class="ss-ep-num">01</div>` vira texto "Episódio 01 "
/// ANTES do coletor, para a máquina de episódios ler o número do bloco.
pub fn normalize_episode_markup(html: &str) -> String {
    SS_EP_NUM.replace_all(html, "Episódio ${2} ").into_owned()
}

static WATCH_CLASS: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?i){B}class\s*=\s*["'][^"']*{B}(?:ss-ep-btn-video|ml-btn-video){B}"#)
});
static WATCH_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)veja\s+online").expect("regex veja online"));

/// `isWatchAnchor`: âncora de player ("Veja Online", `.ml-btn-video`, `.ss-ep-btn-video`).
/// Pela FORMA da âncora, nunca pelo host do href.
pub fn is_watch_anchor(attrs: &str, anchor_text: &str) -> bool {
    WATCH_CLASS.is_match(attrs) || WATCH_TEXT.is_match(anchor_text)
}
