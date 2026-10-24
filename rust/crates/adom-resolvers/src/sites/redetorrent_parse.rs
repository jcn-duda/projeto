//! Parsers puros do Rede Torrent: `parseSearchHtml`, `parsePostLinks` e
//! `classifyAudio` de `resolvers/profiles/redetorrent-parsers.ts`. Os magnets
//! vêm DIRETOS da tabela `tbl-mv-list` do post; nunca há /resolve.

use std::collections::HashSet;
use std::sync::LazyLock;

use crate::common::text::decode_entities;
use crate::common::text::strip_tags;
use adom_crawl::profile_parsers::ResolverLink;
use regex::Regex;
use url::Url;

use crate::common::magnet::{extract_magnet_href, fmt_size, magnet_params};
use crate::common::rules::{normalize_quality, normalize_source};
use crate::common::SitePost;

static SEARCH_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div class="item">\s*<a\s+href=["']([^"']+)["']\s+title=["']([^"']*)["']"#)
        .expect("card da busca")
});
static YEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\(([0-9]{4})\)").expect("ano do título"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("espaços"));
static TABLE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<table class="tbl-mv-list">[\s\S]*?</table>"#).expect("tabela de magnets")
});
static TABLE_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div class="tf[^"]*">([\s\S]*?)</div>"#).expect("cabeçalho do bloco")
});
static ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<tr class="tr-mv-list">([\s\S]*?)</tr>"#).expect("linha de release")
});
static HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<a\s+[^>]*?href\s*=\s*["']([^"']+)["']"#).expect("âncora da linha")
});
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.\-]*:").expect("esquema da URL"));
static CELL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<td class="([^"]*)"[^>]*>([\s\S]*?)</td>"#).expect("célula da linha")
});
static QUALITY_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)[0-9]{3,4}\s*p(?-u:\b)").expect("resolução no texto")
});
static SEASON: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^S([0-9]{1,2})$").expect("temporada na qualidade"));
static AUDIO_PT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"PTBR|PT-BR|PORTUGU[ÊE]S|DUBLAD|DUAL").expect("marca PT do áudio")
});
static AUDIO_FOREIGN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)ENG(?-u:\b)|INGL[ÊE]S|ESPANHOL|JAPON[ÊE]S|LATINO|MULTI")
        .expect("idioma estrangeiro")
});

/// `new URL(href, base).href`; `None` quando o JS lançaria. Base vazia = absoluta.
fn resolve_href(href: &str, base: &str) -> Option<String> {
    if base.is_empty() {
        return Url::parse(href).ok().map(|u| u.to_string());
    }
    Url::parse(base)
        .ok()?
        .join(href)
        .ok()
        .map(|u| u.to_string())
}

/// `parseSearchHtml`: cards `div.item > a[title]`, sem duplicata e sem título vazio.
/// O `seen` marca a URL antes do título, como o TS.
pub fn parse_search_posts(html: &str, base_url: &str) -> Vec<SitePost> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for caps in SEARCH_ITEM.captures_iter(html) {
        let Some(url) = resolve_href(&decode_entities(&caps[1]), base_url) else {
            continue;
        };
        if !seen.insert(url.clone()) {
            continue;
        }
        let title = SPACES
            .replace_all(&decode_entities(&caps[2]), " ")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let year = YEAR.captures(&title).and_then(|c| c[1].parse::<u32>().ok());
        out.push(SitePost {
            kind: None,
            title,
            url,
            poster: None,
            date: None,
            year,
        });
    }
    out
}

/// `classifyAudio`: "legendado" no contexto vence; PT sem idioma estrangeiro é
/// "dublado", com idioma estrangeiro é "dual". Sem marca PT, não classifica.
pub fn classify_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if text.contains("LEGENDAD") {
        return Some("legendado");
    }
    if !AUDIO_PT.is_match(&text) {
        return None;
    }
    Some(if AUDIO_FOREIGN.is_match(&text) {
        "dual"
    } else {
        "dublado"
    })
}

/// `cellText`: texto (sem tags) da primeira célula cuja classe começa por `class`.
fn cell_text(row: &str, class: &str) -> String {
    let wanted = class.to_ascii_lowercase();
    CELL.captures_iter(row)
        .find(|c| c[1].to_ascii_lowercase().starts_with(&wanted))
        .map_or_else(String::new, |c| strip_tags(&c[2]))
}

fn has_digit(text: &str) -> bool {
    text.bytes().any(|b| b.is_ascii_digit())
}

/// `qualityFromText`: primeira resolução "NNNp" do texto, normalizada.
fn quality_from_text(text: &str) -> Option<u32> {
    QUALITY_TEXT
        .find(text)
        .and_then(|m| normalize_quality(m.as_str()))
}

/// Magnet da linha: a primeira âncora que vira magnet (direto ou systemads). Âncora
/// relativa resolve contra o post; a de legenda antes da do magnet é pulada.
fn magnet_of_row(body: &str, post_url: &str) -> Option<String> {
    HREF.captures_iter(body).find_map(|caps| {
        let mut href = caps[1].to_string();
        if !post_url.is_empty() && !SCHEME.is_match(&href) {
            if let Some(absolute) = resolve_href(&href, post_url) {
                href = absolute;
            }
        }
        extract_magnet_href(&href)
    })
}

/// Uma linha `tr.tr-mv-list` vira um botão. Episódio fica sempre vazio (o site
/// não publica); a temporada vem da célula de qualidade `S01`.
fn link_of_row(body: &str, magnet: &str, header: &str) -> ResolverLink {
    let (dn, xl) = magnet_params(magnet);
    let qua = cell_text(body, "td-mv-qua");
    let res = cell_text(body, "td-mv-res");
    let tam = cell_text(body, "td-mv-tam");
    let idi = cell_text(body, "td-mv-idi");
    let leg = cell_text(body, "td-mv-leg");

    let season = SEASON.captures(&qua).and_then(|c| c[1].parse::<u32>().ok());
    // Tamanho da célula com dígito; senão o do magnet (`xl`). "KB" é sentinela.
    let size = if has_digit(&tam) {
        Some(tam)
    } else {
        fmt_size(xl)
    }
    .filter(|s| !s.to_ascii_lowercase().contains("kb"));
    let resolution = if has_digit(&res) {
        normalize_quality(&res)
    } else {
        None
    };

    ResolverLink {
        url: magnet.to_string(),
        quality: resolution.or_else(|| quality_from_text(&dn)),
        size,
        audio: classify_audio(&format!("{header} {idi} {leg}")).map(str::to_string),
        source: if season.is_some() {
            None
        } else {
            normalize_source(&format!("{qua} {dn}"))
        },
        season,
        ..Default::default()
    }
}

/// `parsePostLinks`: botões do post em ordem de documento, uma tabela por bloco de áudio.
pub fn parse_post_links(html: &str, post_url: &str) -> Vec<ResolverLink> {
    let mut links = Vec::new();
    for table in TABLE.find_iter(html) {
        let table = table.as_str();
        let header = TABLE_HEADER
            .captures(table)
            .map_or_else(String::new, |c| strip_tags(&c[1]));
        for row in ROW.captures_iter(table) {
            let body = &row[1];
            if let Some(magnet) = magnet_of_row(body, post_url) {
                links.push(link_of_row(body, &magnet, &header));
            }
        }
    }
    links
}
