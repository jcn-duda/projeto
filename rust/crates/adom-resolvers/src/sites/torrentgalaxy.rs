//! TorrentGalaxy (`torrentgalaxy.one` / `torrentgalaxy.info`).
//!
//! Site GLOBAL (en-US), o 9º resolver do `adom-resolvers` (porta 8708). Ele
//! entra na fila porque o cliente HTTP do Jackett (.NET HttpClient/SChannel)
//! cai na página de desafio do Cloudflare e devolve 200 com ZERO itens — a
//! resposta é byte-idêntica para qualquer User-Agent (medido em 2026-10-24:
//! node, Chrome, `Jackett/1.0`, curl e vazio → 381.622 B, 50 linhas,
//! `server: cloudflare`), então não é header, é transporte. O `reqwest` 0.12
//! com rustls (HTTP/1.1) passa limpo (10/10 em 0,22–0,61 s), por isso o site
//! entra com `uses_flare: false` no registry de rede.
//!
//! O contrato com o Cardigann (`jackett-bludv/torrentgalaxy-cardigann.yml`):
//! - `/search?q=<termo>` → a MESMA página sintética dos outros sites
//!   (`div.posts > div.release`), com o `href` do título apontando para o
//!   `/resolve` do próprio resolver;
//! - `/resolve?url=<post>&i=0` → o MAGNET em texto puro.
//!
//! Por que o fluxo é LAZY: o magnet do TGx vive na página de DETALHE
//! (`/post-detail/<id>/<slug>/`), não na listagem. Abrir os 50 posts de uma
//! busca daria 51 requisições ao site; aqui a listagem vira as linhas do
//! cartão e só o `/resolve` abre o post escolhido.
//!
//! Medido no site real (2026-10-24): a listagem de "batman" devolve 50 linhas
//! `div.tgxtablerow`; a página de detalhe traz o magnet no botão `dl-magnet`
//! (20 ocorrências de `magnet:?` na página, a PRIMEIRA é o botão).

use std::sync::LazyLock;

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_text::escape_html;
use regex::Regex;
use url::Url;

use super::SiteOutput;
use crate::common::http_date::{civil_from_days, date_utc_ms, http_date, http_date_now};
use crate::common::text::decode_entities;
use crate::common::{
    encode_uri_component, release_title, rss_xml, ReleaseTitleConfig, RssConfig, SearchItem,
    SitePost, UNKNOWN_SIZE,
};

pub struct TorrentGalaxy;

pub static TORRENTGALAXY: TorrentGalaxy = TorrentGalaxy;

/// Milissegundos de um dia (divisor do epoch em ms).
const DAY_MS: i64 = 86_400_000;

/// Separador do slug. O PONTO fica: é o nome de cena ("DDP5.1", "H.264",
/// "7.1"), que o núcleo lê com os pontos, e o casamento local
/// (`matches_resolver_query`) já trata pontuação como separador.
static RE_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"_+").expect("separadores"));
static RE_SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("espaços"));

/// Magnet do TGx: `magnet:?xt=urn:btih:<hash>&dn=…&tr=…`. O hash é 40 hex ou
/// 32 base32; o resto do magnet vem até a aspa que fecha o `href`.
static RE_MAGNET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)magnet:\?xt=urn:btih:[0-9a-z]{32,40}(?:&[^"'<>]*)?"#)
        .expect("magnet do torrentgalaxy")
});
/// Unidade da data relativa ("1 month, 4 weeks").
static RE_REL_UNIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d+)\s*(second|minute|hour|day|week|month|year)s?").expect("unidade relativa")
});
/// Data já em `dd/MM/yyyy` (a que o Cardigann faz `dateparse`).
static RE_DDMMYYYY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{2})/(\d{2})/(\d{4})$").expect("data do torrentgalaxy"));

/// Título do release: entidades decodificadas e `_` vira espaço; o resto é
/// preservado — o TGx já publica o nome com qualidade e fonte, que o
/// `clean_post_title` do núcleo BR apagaria.
pub fn clean_title(title: &str) -> String {
    let decoded = decode_entities(title);
    let spaced = RE_SEP.replace_all(&decoded, " ");
    RE_SPACES.replace_all(&spaced, " ").trim().to_string()
}

const TITLE: ReleaseTitleConfig = ReleaseTitleConfig {
    // O tamanho já sai no `<div class="size">` do cartão; repetir no título
    // só polui a comparação de nome do addon.
    with_size: false,
    ..ReleaseTitleConfig::new(clean_title)
};

// ─── URL de busca ───────────────────────────────────────────────────────

/// URL de busca do TGx: o termo vai no PATH, depois de `keywords:`
/// (`/get-posts/keywords:<termo>`). O dois-pontos CRU funciona — medido em
/// 2026-10-24 —, e o espelho (`torrentgalaxy.info`) responde igual.
pub fn search_url(base: &str, query: &str) -> Result<String, String> {
    let mut url = Url::parse(base).map_err(|_| format!("invalid_url:{base}"))?;
    let term = sanitize_term(query);
    let path = if term.is_empty() {
        "/get-posts".to_string()
    } else {
        format!("/get-posts/keywords:{term}")
    };
    url.set_path(&path);
    Ok(url.to_string())
}

/// Higiene do termo: `:` sai (é o separador do path do TGx) e o espaço vira
/// espaço único — a mesma regra das definições Cardigann BR (`[:]+` → ` `),
/// aplicada de novo aqui (defesa dupla, como no título).
fn sanitize_term(query: &str) -> String {
    let swapped: String = query
        .chars()
        .map(|c| if c == ':' { ' ' } else { c })
        .collect();
    RE_SPACES.replace_all(&swapped, " ").trim().to_string()
}

// ─── magnet ─────────────────────────────────────────────────────────────

/// O PRIMEIRO magnet da página de detalhe. O HTML publica `&amp;` no href
/// (`…&amp;dn=…&amp;tr=…`): sem decodificar, o magnet cru quebrava o player.
pub fn extract_magnet(html: &str) -> Option<String> {
    let caps = RE_MAGNET.captures(html)?;
    let magnet = decode_entities(caps.get(0).map_or("", |m| m.as_str()));
    magnet.starts_with("magnet:").then_some(magnet)
}

// ─── data ───────────────────────────────────────────────────────────────

/// Data RELATIVA do TGx ("1 month, 4 weeks") → data absoluta `dd/MM/yyyy`,
/// que é o formato que o Cardigann faz `dateparse`.
pub fn relative_to_date(relative: &str, now_ms: i64) -> Option<String> {
    let elapsed = relative_ms(relative)?;
    let (year, month, day, _) = civil_from_days((now_ms - elapsed).div_euclid(DAY_MS));
    Some(format!("{day:02}/{month:02}/{year:04}"))
}

/// Soma das unidades da data relativa, em ms. O TGx publica as DUAS maiores
/// unidades ("1 month, 4 weeks"), então elas se somam.
fn relative_ms(relative: &str) -> Option<i64> {
    let mut total = 0i64;
    let mut found = false;
    for caps in RE_REL_UNIT.captures_iter(relative) {
        let amount: i64 = caps.get(1)?.as_str().parse().ok()?;
        let unit = caps.get(2)?.as_str().to_lowercase();
        total += amount * unit_ms(&unit);
        found = true;
    }
    found.then_some(total)
}

/// Duração de uma unidade. O mês do TGx é o do calendário do site (30 dias
/// é a aproximação padrão; a data é campo opcional do cartão).
fn unit_ms(unit: &str) -> i64 {
    match unit {
        "year" => 365 * DAY_MS,
        "month" => 30 * DAY_MS,
        "week" => 7 * DAY_MS,
        "day" => DAY_MS,
        "hour" => 3_600_000,
        "minute" => 60_000,
        _ => 1_000,
    }
}

/// `dd/MM/yyyy` → data HTTP do `pubDate` do feed torznab.
fn http_date_of(date: &str) -> Option<String> {
    let caps = RE_DDMMYYYY.captures(date.trim())?;
    let day: i64 = caps.get(1)?.as_str().parse().ok()?;
    let month: i64 = caps.get(2)?.as_str().parse().ok()?;
    let year: i64 = caps.get(3)?.as_str().parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(http_date(date_utc_ms(year, month - 1, day)))
}

// ─── saída do site ──────────────────────────────────────────────────────

impl SiteOutput for TorrentGalaxy {
    fn name(&self) -> &'static str {
        "torrentgalaxy"
    }

    fn caps_xml(&self) -> Option<String> {
        Some(super::COMPACT_CAPS.to_string())
    }

    /// O magnet do TGx vive na página de DETALHE: o post da listagem vira um
    /// botão só (o magnet), resolvido no `/resolve`.
    fn post_links(&self, html: &str, _post_url: &str) -> Result<Vec<ResolverLink>, String> {
        let magnet = extract_magnet(html).ok_or_else(|| "sem_magnet".to_string())?;
        Ok(vec![ResolverLink {
            url: magnet,
            ..Default::default()
        }])
    }

    fn release_title(&self, post: &SitePost, link: &ResolverLink, index: Option<usize>) -> String {
        release_title(&TITLE, post, link, index)
    }

    /// Cartão do Cardigann: uma linha por post da listagem, com o download
    /// apontando para o `/resolve` do próprio resolver (o `url` carrega o
    /// path de detalhe da linha, no estilo BLUDV).
    fn search_page_html(&self, self_url: &str, items: &[SearchItem]) -> String {
        let rows: Vec<String> = items.iter().map(|item| card_row(self_url, item)).collect();
        format!(
            "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>TorrentGalaxy (resolver)</title></head>\n<body><div class=\"posts\">\n{}\n</div></body></html>",
            rows.join("\n")
        )
    }

    /// Feed torznab do site (o `/api` do resolver).
    fn rss_xml(&self, self_url: &str, items: &[SearchItem], category: u32) -> Option<String> {
        let cfg = RssConfig {
            self_url,
            channel_title: "TorrentGalaxy (resolver)",
            title_of: &|post: &SitePost, link: &ResolverLink| {
                release_title(&TITLE, post, link, None)
            },
            pub_date_of: &|post: &SitePost| {
                post.date
                    .as_deref()
                    .and_then(http_date_of)
                    .unwrap_or_else(http_date_now)
            },
            with_description: true,
            seeders_comment: None,
            with_enclosure: true,
            compact: false,
        };
        Some(rss_xml(&cfg, items, category))
    }
}

/// Uma linha do cartão. O `href` do título é o `/resolve` do resolver com o
/// path de detalhe e o índice do botão (`i=0`): o magnet só existe depois.
fn card_row(self_url: &str, item: &SearchItem) -> String {
    let download = format!(
        "{}/resolve?url={}&i={}",
        self_url,
        encode_uri_component(&item.post.url),
        item.index
    );
    let size = item
        .link
        .size
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(UNKNOWN_SIZE);
    let title = release_title(&TITLE, &item.post, &item.link, None);
    let mut row = format!(
        "  <div class=\"release\">\n    <div class=\"title\"><a href=\"{}\">{}</a></div>\n    <div class=\"size\">{}</div>",
        escape_html(&download),
        escape_html(&title),
        escape_html(size)
    );
    // Saúde só quando o site publicou: sem a div o Cardigann usa o `default`.
    if let Some(seeders) = item.seeders {
        row.push_str(&format!("\n    <div class=\"seeders\">{seeders}</div>"));
    }
    if let Some(leechers) = item.leechers {
        row.push_str(&format!("\n    <div class=\"leechers\">{leechers}</div>"));
    }
    if let Some(date) = item.post.date.as_deref().filter(|d| !d.is_empty()) {
        row.push_str(&format!(
            "\n    <div class=\"date\">{}</div>",
            escape_html(date)
        ));
    }
    if let Some(poster) = item.post.poster.as_deref().filter(|p| !p.is_empty()) {
        row.push_str(&format!(
            "\n    <div class=\"poster\"><img src=\"{}\" alt=\"\"></div>",
            escape_html(poster)
        ));
    }
    if let Some(kind) = item.post.kind.as_deref().filter(|k| !k.is_empty()) {
        row.push_str(&format!(
            "\n    <div class=\"description\">{}</div>",
            escape_html(kind)
        ));
    }
    row.push_str("\n  </div>");
    row
}

#[cfg(test)]
#[path = "torrentgalaxy_tests.rs"]
mod tests;
