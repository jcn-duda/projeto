//! Parser da listagem do TorrentGalaxy (`div.tgxtablerow`).
//!
//! O TGx é a ÚNICA listagem em que o magnet NÃO vem na busca: a linha traz
//! título, tamanho, data relativa, seeders e poster, e o magnet vive na página
//! de detalhe (`/post-detail/<id>/<slug>/`). Por isso este parser devolve a
//! linha RICA (`TgRow`) e não só o par título/URL — o `/search` monta o
//! cartão e o `/resolve` abre o detalhe.
//!
//! Fica em arquivo próprio (`listing_parsers.rs` já está no teto de 400
//! linhas), como o parser do Vaca (`listing_vaca.rs`).
//!
//! Medido em 2026-10-24 no site real: a listagem de "batman" devolve 50 linhas
//! `div.tgxtablerow`, cada uma com 12 células (categoria, verificado, idioma,
//! título+detalhe, ícones de download, "-", uploader, tamanho, comentários,
//! views, seeders/leechers, data). A classe da linha é `tgxtablerow txlight`
//! — com sufixo —, então o padrão tem que casar `\btgxtablerow\b` DENTRO do
//! atributo `class`, e não a classe inteira.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use super::ListingPost;

/// Uma linha da tabela do TorrentGalaxy.
#[derive(Debug, Clone, Default)]
pub struct TgRow {
    /// Nome do release, como o site publica (com pontos).
    pub title: String,
    /// Path de detalhe resolvido contra a base (`/post-detail/<id>/<slug>/`).
    pub url: String,
    /// Tamanho publicado ("956.3 MB"), quando a linha traz.
    pub size: Option<String>,
    /// Data RELATIVA do site ("1 month, 4 weeks").
    pub date: Option<String>,
    pub seeders: Option<u32>,
    pub leechers: Option<u32>,
    /// Poster no `onmouseover` da linha (`i.rar.pics`).
    pub poster: Option<String>,
    /// Categoria ("Movies", "TV Shows"...).
    pub category: Option<String>,
}

// ─── padrões do HTML medido ──────────────────────────────────────────────

/// Abertura da linha: `class="tgxtablerow txlight"` — a classe tem sufixo, e
/// o atributo `onmouseover` da MESMA tag contém `>`, então o padrão para
/// achar o INÍCIO da linha não pode varrer a tag inteira.
static RE_ROW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<div\b[^>]*\bclass=["'][^"']*\btgxtablerow\b[^"']*["']"#)
        .expect("linha do torrentgalaxy")
});
/// Âncora com o texto interno (o `title` do release vive no atributo, o
/// texto interno é o mesmo nome).
static RE_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b([^>]*)>([\s\S]*?)</a>"#).expect("âncora do torrentgalaxy")
});
static RE_HREF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\bhref\s*=\s*["']([^"']*)["']"#).expect("href do torrentgalaxy")
});
static RE_TITLE_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\btitle\s*=\s*["']([^"']*)["']"#).expect("title do torrentgalaxy")
});
/// Badge com o tamanho: `<span class="badge badge-secondary txlight">956.3 MB</span>`.
static RE_BADGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<span\b[^>]*class=["'][^"']*\bbadge\b[^"']*["'][^>]*>([^<]*)</span>"#)
        .expect("badge do torrentgalaxy")
});
/// Texto de tamanho: só o badge com unidade (o badge de comentários é "0").
static RE_SIZE_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB)\s*$")
        .expect("tamanho do torrentgalaxy")
});
/// Categoria: `<a href="/get-posts/category:Movies:time:10D"><small>Movies</small></a>`.
static RE_CATEGORY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<a\b[^>]*href=["'][^"']*/get-posts/category:[^"']*["'][^>]*>\s*<small>([^<]*)</small>"#)
        .expect("categoria do torrentgalaxy")
});
/// Saúde: `<span title="Seeders/Leechers">[<font...><b>1026</b>.../<b>168</b>...]</span>`.
static RE_HEALTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)Seeders/Leechers[^>]*>([\s\S]{0,400})").expect("saúde do torrentgalaxy")
});
static RE_BOLD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)<b>\s*(\d+)\s*</b>").expect("número do torrentgalaxy"));
/// `src` do poster: o `onmouseover` escapa as aspas (`src=\'https://…\'`).
static RE_SRC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)src=\\?["']([^"'\\]+)"#).expect("src do torrentgalaxy"));
/// Data relativa: "1 month, 4 weeks" (a célula da data e a tabela aninhada
/// publicam o mesmo texto; a primeira ocorrência vence).
static RE_RELATIVE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\d+\s*(?:second|minute|hour|day|week|month|year)s?(?:\s*,\s*\d+\s*(?:second|minute|hour|day|week|month|year)s?)*",
    )
    .expect("data relativa do torrentgalaxy")
});
/// Espaço em branco (inclusive o U+00A0) → um espaço ASCII.
static RE_SPACES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").expect("espacos do torrentgalaxy"));

/// Texto com espaços normalizados e sem sobra nas pontas.
///
/// O TGx publica o tamanho com U+00A0 CRU ("956.3<U+00A0>MB"), não a entidade
/// `&nbsp;` — então o `decode_entities` não normaliza. O U+00A0 cru no
/// `<div class="size">` vira lixo na release do Jackett (a regex do Cardigann
/// é `([\d.,]+\s*(?:GB|MB|TB|KB))`) e no `<size>` do feed torznab.
fn normaliza_espacos(text: &str) -> String {
    RE_SPACES.replace_all(text, " ").trim().to_string()
}

// ─── extração ───────────────────────────────────────────────────────────

/// Todas as linhas da listagem, na ordem do HTML.
pub fn parse_rows(html: &str, base_url: &str) -> Vec<TgRow> {
    let starts: Vec<usize> = RE_ROW.find_iter(html).map(|m| m.start()).collect();
    let mut out = Vec::new();
    for (i, start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(html.len());
        if let Some(row) = parse_row(&html[*start..end], base_url) {
            out.push(row);
        }
    }
    out
}

/// Uma linha: título + path de detalhe obrigatórios; o resto é opcional.
fn parse_row(chunk: &str, base_url: &str) -> Option<TgRow> {
    let (title, href) = title_anchor(chunk)?;
    let url = Url::parse(base_url).ok()?.join(&href).ok()?.to_string();
    let (seeders, leechers) = health_of(chunk).unwrap_or((0, 0));
    Some(TgRow {
        title,
        url,
        size: size_of(chunk),
        date: relative_date_of(chunk),
        seeders: (seeders > 0).then_some(seeders),
        leechers: (leechers > 0).then_some(leechers),
        poster: poster_of(chunk),
        category: category_of(chunk),
    })
}

/// Âncora do título: `href` de detalhe + atributo `title` com o nome do
/// release. A âncora de download da MESMA linha tem o mesmo `href` e nenhum
/// `title` — por isso o `title` é obrigatório para não pegar a errada.
fn title_anchor(chunk: &str) -> Option<(String, String)> {
    for caps in RE_ANCHOR.captures_iter(chunk) {
        let attrs = caps.get(1).map_or("", |m| m.as_str());
        let inner = caps.get(2).map_or("", |m| m.as_str());
        let Some(href) = attr_value(attrs, &RE_HREF) else {
            continue;
        };
        if !href.starts_with("/post-detail/") {
            continue;
        }
        let title = attr_value(attrs, &RE_TITLE_ATTR)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| crate::common::text::strip_tags(inner));
        let title = normaliza_espacos(&title);
        if title.is_empty() {
            continue;
        }
        return Some((title, href));
    }
    None
}

/// Valor de um atributo, com as entidades decodificadas.
fn attr_value(attrs: &str, re: &Regex) -> Option<String> {
    let caps = re.captures(attrs)?;
    Some(crate::common::text::decode_entities(
        caps.get(1).map_or("", |m| m.as_str()),
    ))
}

/// Primeiro badge que parece tamanho (o badge de comentários é "0").
fn size_of(chunk: &str) -> Option<String> {
    for caps in RE_BADGE.captures_iter(chunk) {
        let text = normaliza_espacos(caps.get(1).map_or("", |m| m.as_str()));
        if RE_SIZE_TEXT.is_match(&text) {
            return Some(text);
        }
    }
    None
}

/// Data relativa crua ("1 month, 4 weeks").
fn relative_date_of(chunk: &str) -> Option<String> {
    let caps = RE_RELATIVE.captures(chunk)?;
    Some(normaliza_espacos(caps.get(0).map_or("", |m| m.as_str())))
}

/// Seeders e leechers da célula de saúde.
fn health_of(chunk: &str) -> Option<(u32, u32)> {
    let caps = RE_HEALTH.captures(chunk)?;
    let tail = caps.get(1).map_or("", |m| m.as_str());
    let nums: Vec<u32> = RE_BOLD
        .captures_iter(tail)
        .filter_map(|c| c.get(1).and_then(|m| m.as_str().parse().ok()))
        .collect();
    match nums.len() {
        0 => None,
        1 => Some((nums[0], 0)),
        _ => Some((nums[0], nums[1])),
    }
}

/// Poster: o primeiro `src` ABSOLUTO da linha (o `onmouseover` vem antes do
/// ícone do IMDb, que é relativo).
fn poster_of(chunk: &str) -> Option<String> {
    RE_SRC
        .captures_iter(chunk)
        .filter_map(|c| c.get(1).map(|m| m.as_str()))
        .find(|value| value.starts_with("http"))
        .map(|value| value.to_string())
}

/// Categoria da linha ("Movies", "TV Shows"...).
fn category_of(chunk: &str) -> Option<String> {
    let caps = RE_CATEGORY.captures(chunk)?;
    let text = crate::common::text::decode_entities(caps.get(1).map_or("", |m| m.as_str()));
    let text = normaliza_espacos(&text);
    (!text.is_empty()).then_some(text)
}

/// Entrada padrão do dispatch de listagem (título + URL + poster).
pub fn parse_torrentgalaxy_posts(html: &str, base_url: &str) -> Vec<ListingPost> {
    parse_rows(html, base_url)
        .into_iter()
        .map(|row| ListingPost {
            title: row.title,
            url: row.url,
            poster: row.poster,
        })
        .collect()
}
