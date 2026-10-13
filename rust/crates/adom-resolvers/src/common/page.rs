//! Saída que o Jackett lê: `createSearchPageHtml` e `createRssXml` de
//! `resolvers/release-format.ts`. Cada botão do post vira uma linha; o href de
//! download carrega o índice exato do botão (`/resolve?url=&i=&h=&n=`).

use adom_crawl::profile_parsers::ResolverLink;
use adom_crawl::resolver_matching::button_id;
use adom_crawl::resolver_text::{escape_xml, parse_size};
use serde::{Deserialize, Serialize};

/// Tamanho sentinela das fontes BR: o Cardigann exige um valor.
pub const UNKNOWN_SIZE: &str = "1 KB";

/// Post da busca com os campos que os sites usam na saída.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SitePost {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub year: Option<u32>,
    /// Tipo do card da busca ("Série", "Filme"...) quando o site publica: o
    /// Rede põe série na frente quando a query pede temporada.
    #[serde(default)]
    pub kind: Option<String>,
}

/// Um botão de um post, já com o índice e o total de botões do post.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchItem {
    pub post: SitePost,
    pub link: ResolverLink,
    pub index: usize,
    pub count: usize,
}

/// `encodeURIComponent` do JS: escapa tudo menos `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn button_query(post: &SitePost, item: &SearchItem) -> String {
    format!(
        "url={}&i={}&h={}&n={}",
        encode_uri_component(&post.url),
        item.index,
        button_id(&item.link.url),
        item.count
    )
}

/// Página HTML sintética do Cardigann (layout compacto: comando/vaca/nerd/tdf).
/// `row_extras` injeta poster/date entre size e description; `description_of`
/// é o título do post por padrão.
pub fn search_page_html(
    self_url: &str,
    items: &[SearchItem],
    release_title: &dyn Fn(&SitePost, &ResolverLink, Option<usize>) -> String,
    row_extras: &dyn Fn(&SitePost) -> String,
    description_of: &dyn Fn(&SitePost) -> Option<String>,
) -> String {
    let rows: String = items
        .iter()
        .map(|item| {
            let download = format!("{self_url}/resolve?{}", button_query(&item.post, item));
            let size = item
                .link
                .size
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or(UNKNOWN_SIZE);
            let description = description_of(&item.post).unwrap_or_default();
            format!(
                r#"<div class="release"><div class="title"><a href="{}">{}</a></div><div class="size">{}</div>{}<div class="description">{}</div><div class="seeders">1</div></div>"#,
                escape_xml(&download),
                escape_xml(&release_title(&item.post, &item.link, Some(item.index))),
                escape_xml(size),
                row_extras(&item.post),
                escape_xml(&description),
            )
        })
        .collect();
    format!(r#"<!doctype html><html><body><div class="posts">{rows}</div></body></html>"#)
}

/// Configuração do feed torznab (`createRssXml`).
pub struct RssConfig<'a> {
    pub self_url: &'a str,
    pub channel_title: &'a str,
    pub title_of: &'a dyn Fn(&SitePost, &ResolverLink) -> String,
    pub pub_date_of: &'a dyn Fn(&SitePost) -> String,
    pub with_description: bool,
    pub seeders_comment: Option<&'a str>,
    pub with_enclosure: bool,
    pub compact: bool,
}

/// Feed torznab, multilinha (bludv/nerd) ou compacto (tdf). Seeders "1" é
/// neutro: nenhum site publica seeds e 0 descartaria a release nos filtros.
pub fn rss_xml(cfg: &RssConfig<'_>, items: &[SearchItem], category: u32) -> String {
    let bodies: Vec<String> = items
        .iter()
        .map(|item| {
            let dl = format!("{}/dl?{}", cfg.self_url, button_query(&item.post, item));
            let size = item.link.size.as_deref().and_then(parse_size).unwrap_or(0);
            let mut fields: Vec<String> = vec![
                format!(
                    "<title>{}</title>",
                    escape_xml(&(cfg.title_of)(&item.post, &item.link))
                ),
                format!(r#"<guid isPermaLink="false">{}</guid>"#, escape_xml(&dl)),
                format!("<link>{}</link>", escape_xml(&dl)),
                format!("<comments>{}</comments>", escape_xml(&item.post.url)),
                format!("<pubDate>{}</pubDate>", (cfg.pub_date_of)(&item.post)),
                format!("<size>{size}</size>"),
            ];
            if cfg.with_description {
                fields.push(format!(
                    "<description>{}</description>",
                    escape_xml(&item.post.title)
                ));
            }
            fields.push(format!("<category>{category}</category>"));
            if cfg.with_enclosure {
                fields.push(format!(
                    r#"<enclosure url="{}" type="application/x-bittorrent" length="{size}"/>"#,
                    escape_xml(&dl)
                ));
            }
            fields.push(format!(
                r#"<torznab:attr name="category" value="{category}"/>"#
            ));
            fields.push(format!(r#"<torznab:attr name="size" value="{size}"/>"#));
            if let Some(comment) = cfg.seeders_comment.filter(|c| !c.is_empty()) {
                fields.push(comment.to_string());
            }
            fields.push(r#"<torznab:attr name="seeders" value="1"/>"#.to_string());
            fields.push(r#"<torznab:attr name="peers" value="1"/>"#.to_string());
            fields.push(r#"<torznab:attr name="downloadvolumefactor" value="0"/>"#.to_string());
            fields.push(r#"<torznab:attr name="uploadvolumefactor" value="1"/>"#.to_string());
            if cfg.compact {
                format!("<item>{}</item>", fields.concat())
            } else {
                let mut lines = vec!["    <item>".to_string()];
                lines.extend(fields.iter().map(|f| format!("      {f}")));
                lines.push("    </item>".to_string());
                lines.join("\n")
            }
        })
        .collect();
    let channel = cfg.channel_title;
    if cfg.compact {
        return format!(
            r#"<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel><title>{channel}</title>{}</channel></rss>"#,
            bodies.concat()
        );
    }
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<rss version=\"2.0\" xmlns:torznab=\"http://torznab.com/schemas/2015/feed\">\n  <channel>\n    <title>{channel}</title>\n{}\n  </channel>\n</rss>",
        bodies.join("\n")
    )
}
