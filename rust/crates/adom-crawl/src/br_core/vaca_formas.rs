//! Formas de página do VacaTorrent — PORT FIEL de
//! `resolvers/profiles/vacatorrent-shapes.ts` (144 linhas).
//!
//! Mora no núcleo BR porque o RESOLVER (`adom-resolvers/src/sites/vacatorrent*.rs`)
//! e o RASPADOR (`adom-crawl/src/profile_parsers/*`) lêem o mesmo TypeScript: antes
//! havia duas cópias divergentes (o raspador sem `stripTags`, sem fronteira ASCII,
//! com `attribute` tolerando espaços e sem as regras `#170`/`#186`). Aqui fica a
//! versão que o resolver já validava contra o oráculo TS; o raspador passa a
//! chamar daqui.
//!
//! Paridade com o JS: `\b` é a fronteira ASCII (`{B}`/`FB`), `\d` é `[0-9]`, e o
//! `</\1>` de `SS_EP_NUM_RE` precisa de `fancy-regex` (backreference).
//! Convenções do TS preservadas, com a linha de autoridade:
//! - `resolve_url` devolve `null` quando `new URL(href, baseUrl)` lança
//!   (`vacatorrent-shapes.ts:16,29,33,37,39`) — o raspador devolvia o href cru.
//! - `decodeDataU` é TOLERANTE: `Buffer.from(.., 'base64').toString('utf8')`
//!   (:23) descarta bytes inválidos, não falha.
//! - `parseSeasonInternal` usa `attribute` SEM espaço em volta do `=`
//!   (`resolvers/text.ts:97-105`) e testa classe/href COM fronteira (:59-60).

use std::collections::HashSet;
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use url::Url;

// `super` aqui é `br_core::vaca` (este arquivo é submódulo dele via `#[path]`),
// então os irmãos do núcleo são alcançados pelo caminho completo do crate.
use crate::br_core::magnet::b64_decode;
use crate::br_core::release::FB;
use crate::br_core::rules::{attribute, compile};
use crate::br_core::text::strip_tags;

pub use crate::profile_parsers::VacaSeasonCard;

/// `new URL(href, baseUrl).href` com o `try/catch` do TS: `None` quando a URL
/// não resolve (sem base e href relativo, ou href lixo).
pub fn resolve_url(href: &str, base: Option<&str>) -> Option<String> {
    match base {
        Some(b) => Url::parse(b)
            .and_then(|base| base.join(href))
            .ok()
            .map(|u| u.to_string()),
        None => Url::parse(href).ok().map(|u| u.to_string()),
    }
}

// ─── filme (`vacatorrent-shapes.ts:11-17`) ───────────────────────────────

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

// ─── série (`vacatorrent-shapes.ts:20-40`) ───────────────────────────────

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
/// Cada ramo que não resolve CAI no seguinte e o fim é `null` (:39) — o ramo que
/// resolve não devolve o valor cru, só o `try/catch` continua a procura.
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

// ─── cards de temporada (`vacatorrent-shapes.ts:50-89`) ──────────────────

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

/// `filterSeasonCards` (:82-89) com a temporada já resolvida em número: sem
/// temporada pedida, tudo; com pedida, batches/sem temporada ficam e as outras
/// caem.
pub fn filter_season_cards(
    cards: &[VacaSeasonCard],
    requested_season: Option<u32>,
) -> Vec<VacaSeasonCard> {
    let Some(wanted) = requested_season else {
        return cards.to_vec();
    };
    cards
        .iter()
        .filter(|c| c.season.is_none() || c.season == Some(wanted))
        .cloned()
        .collect()
}

// ─── batch (`vacatorrent-shapes.ts:98-110`) ──────────────────────────────

/// `repairMangledEntities` de `resolvers/text.ts:27-33`: QUATRO passos. As duas
/// primeiras regras são o ordinal destruído ("4ordf"); as duas últimas
/// (`:31-32`, os contornos "#170"/"#186" do briefing) são a forma numérica
/// "4#170" → "4ª" e "2#186" → "2º" — o raspador só tinha as duas primeiras.
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

pub fn repair_mangled_entities(value: &str) -> String {
    let mut out = value.to_string();
    for (re, rep) in REPAIR.iter() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out
}

static BATCH_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| compile(r"(?i)^\s*(?:batch|pack){B}[\s:–—|·-]*\s*"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("regex espaços"));

/// `normalizeBatchTitle`: repara entidades, tira o prefixo "BATCH – " e colapsa
/// espaços (`:98-103`, na ordem do TS: repara ANTES de cortar o prefixo).
pub fn normalize_batch_title(raw: &str) -> String {
    let repaired = repair_mangled_entities(raw);
    let stripped = BATCH_PREFIX.replace(&repaired, "");
    SPACES.replace_all(&stripped, " ").trim().to_string()
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

// ─── markup por episódio e âncora de assistir (:112-132) ─────────────────

/// `<(span|div)\b[^>]*\bss-ep-num(?:-inline)?\b[^>]*>\s*(\d{1,3})\s*<\/\1>` —
/// o `</\1>` exige o MESMO elemento do abre (um `<div>` de número não pode fechar
/// com `</span>`); por isso é `fancy-regex`, não o `(?:span|div)` do raspador.
static SS_EP_NUM: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(&format!(
        r"(?i)<(span|div){FB}[^>]*{FB}ss-ep-num(?:-inline)?{FB}[^>]*>\s*([0-9]{{1,3}})\s*</\1>"
    ))
    .expect("regex ss-ep-num")
});

/// `normalizeEpisodeMarkup`: `<div class="ss-ep-num">01</div>` vira texto
/// "Episódio 01 " ANTES do coletor, para a máquina de episódios ler o número.
pub fn normalize_episode_markup(html: &str) -> String {
    SS_EP_NUM.replace_all(html, "Episódio ${2} ").into_owned()
}

static WATCH_CLASS: LazyLock<Regex> = LazyLock::new(|| {
    compile(r#"(?i){B}class\s*=\s*["'][^"']*{B}(?:ss-ep-btn-video|ml-btn-video){B}"#)
});
static WATCH_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)veja\s+online").expect("regex veja online"));

/// `isWatchAnchor`: âncora de player ("Veja Online", `.ml-btn-video`,
/// `.ss-ep-btn-video`). Pela FORMA da âncora, nunca pelo host do href.
pub fn is_watch_anchor(attrs: &str, anchor_text: &str) -> bool {
    WATCH_CLASS.is_match(attrs) || WATCH_TEXT.is_match(anchor_text)
}

// O decoder/`stripTags` usado acima é o de `resolvers/text.ts` (`decode_entities`
// de 15 nomes + `strip_tags`): `vacatorrent-shapes.ts:5,8` importa exatamente
// esse módulo. Não é o `adom_core::decode_entities` (tabela grande de
// `src/utils/title-normalization.ts`).

#[cfg(test)]
mod tests {
    use super::*;

    /// Autoridade `resolvers/text.ts:31-32` (regras `#170`/`#186`).
    #[test]
    fn repara_a_forma_numerica_do_ordinal() {
        assert_eq!(repair_mangled_entities("4#170"), "4ª");
        assert_eq!(repair_mangled_entities("4#xaa"), "4ª");
        assert_eq!(repair_mangled_entities("2#186"), "2º");
        assert_eq!(repair_mangled_entities("2#xba"), "2º");
        // As regras originais seguem valendo.
        assert_eq!(repair_mangled_entities("4ordf"), "4ª");
        assert_eq!(repair_mangled_entities("Accordf"), "Accordf");
    }

    /// Autoridade `vacatorrent-shapes.ts:16,29,39`: sem base, href relativo não
    /// resolve — `null`, nunca o valor cru.
    #[test]
    fn url_sem_base_nao_devolve_o_href_cru() {
        assert_eq!(
            extract_movie_links(r#"<a href="/movie-links/12345/">Links</a>"#, None),
            None
        );
        assert_eq!(
            extract_movie_links(
                r#"<a href="/movie-links/12345/">Links</a>"#,
                Some("https://vaqueirofilmes1.com")
            ),
            Some("https://vaqueirofilmes1.com/movie-links/12345/".to_string())
        );
    }

    /// Autoridade `vacatorrent-shapes.ts:117,120`: o `</\1>` só fecha o mesmo
    /// elemento, e o espaço antes de "Episódio" faz parte da saída.
    #[test]
    fn backreference_do_ss_ep_num() {
        assert_eq!(
            normalize_episode_markup(r#"<div class="ss-ep-num">05</div>"#),
            "Episódio 05 "
        );
        assert_eq!(
            normalize_episode_markup(r#"<span class="ss-ep-num">05</span>"#),
            "Episódio 05 "
        );
        // `<div>` fechado por `</span>` NÃO é o mesmo elemento: fica intacto.
        let cruzado = r#"<div class="ss-ep-num">05</span>"#;
        assert_eq!(normalize_episode_markup(cruzado), cruzado);
    }

    /// Valores MEDIDOS no oráculo TS (`dist/resolvers/profiles/vacatorrent-
    /// parsers.js`, importado do `dist/` do HEAD) sobre entradas mínimas. Cada
    /// linha é um ponto em que a cópia do raspador divergia: `extract_attr`
    /// tolerando espaço em volta do `=`, `strip_tags` com a tabela grande de
    /// entidades e o href CRU quando não havia base.
    #[test]
    fn formas_bate_com_as_medicoes_do_oraculo() {
        let card = r#"<a class="sa-card" href="/pt/temporada-2/">2&ordf; Temporada</a>"#;
        // `vacatorrent-shapes.ts:16,33,39`: sem base o card NÃO entra.
        assert!(parse_season_internal(card, None).is_empty());
        let cards = parse_season_internal(card, Some("https://vaca.example/"));
        assert_eq!(cards.len(), 1);
        // `:8` + `resolvers/text.ts:1-5`: `&ordf;` NÃO está nos 15 nomes, fica
        // intacto (a tabela grande de `src/utils/title-normalization.ts:57` daria
        // "2ª Temporada").
        assert_eq!(cards[0].title, "2&ordf; Temporada");
        assert_eq!(cards[0].season, Some(2));
        // `attribute` de `resolvers/text.ts:97-105` (`allowWhitespace` falso) não
        // lê `class = "..."`; o card fica de fora, como no TS.
        assert!(parse_season_internal(
            r#"<a class = "sa-card" href = "/pt/temporada-2/">X</a>"#,
            Some("https://vaca.example/")
        )
        .is_empty());
        // `repairMangledEntities` de `resolvers/text.ts:31` (o contorno "#170") no
        // título do batch: "4#170" vira "4ª" ANTES de cortar o prefixo BATCH.
        assert_eq!(
            extract_batch_title("<h1>BATCH - Casa 4#170 Fase</h1>").as_deref(),
            Some("Casa 4\u{aa} Fase")
        );
        // `stripTags` de `resolvers/text.ts:45-47`: tag vira espaço e `nbsp` é
        // espaço COMUM (U+0020), não U+00A0.
        assert_eq!(strip_tags("<b>Serie</b> 2&nbsp;&ordf;"), "Serie 2 &ordf;");
    }
}
