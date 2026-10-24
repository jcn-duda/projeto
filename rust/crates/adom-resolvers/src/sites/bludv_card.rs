//! Página do cartão Cardigann do BLUDV (`createSearchPageHtml` de
//! `resolvers/profiles/bludv.ts`).
//!
//! Fica fora de `bludv.rs` por coesão e pela catraca de 400 linhas: é o único
//! lugar do site que monta HTML de saída, e o restante do módulo é coleta
//! (botões, posts, feed). A forma é o cartão multilinha do Cardigann — NÃO é o
//! layout compacto do núcleo `common::page`, por isso o site a mantém própria.

use adom_crawl::resolver_matching::button_id;
use adom_crawl::resolver_text::escape_html;

use crate::common::{encode_uri_component, release_title, SearchItem, UNKNOWN_SIZE};

use super::TITLE;

/// Uma linha do cartão: o botão, e a descrição do post se a busca a trouxe.
pub struct CardRow<'a> {
    pub item: &'a SearchItem,
    pub original: Option<&'a str>,
}

/// Campo opcional: vazio ou ausente some, como o `${x ? ... : ''}` do TS.
fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

/// Uma linha do cartão. Os três campos opcionais deixam linha só com espaços,
/// igual ao template do TS (que o golden compara byte a byte).
fn card_row(self_url: &str, row: &CardRow<'_>) -> String {
    let item = row.item;
    let download = format!(
        "{self_url}/resolve?url={}&i={}&h={}&n={}",
        encode_uri_component(&item.post.url),
        item.index,
        button_id(&item.link.url),
        item.count
    );
    let size = nonempty(item.link.size.as_deref()).unwrap_or(UNKNOWN_SIZE);
    let title = release_title(&TITLE, &item.post, &item.link, None);
    let date = match nonempty(item.post.date.as_deref()) {
        Some(d) => format!(r#"<div class="date">{}</div>"#, escape_html(d)),
        None => String::new(),
    };
    let poster = match nonempty(item.post.poster.as_deref()) {
        Some(p) => format!(
            r#"<div class="poster"><img src="{}" alt=""></div>"#,
            escape_html(p)
        ),
        None => String::new(),
    };
    let original = match nonempty(row.original) {
        Some(o) => format!(r#"<div class="description">{}</div>"#, escape_html(o)),
        None => String::new(),
    };
    format!(
        "  <div class=\"release\">\n    <div class=\"title\"><a href=\"{}\">{}</a></div>\n    <div class=\"size\">{}</div>\n    {date}\n    {poster}\n    {original}\n    <div class=\"seeders\">1</div>\n  </div>",
        escape_html(&download),
        escape_html(&title),
        escape_html(size),
    )
}

/// `createSearchPageHtml` do bludv: uma linha de cartão por botão do post.
pub fn card_html(self_url: &str, rows: &[CardRow<'_>]) -> String {
    let body: Vec<String> = rows.iter().map(|row| card_row(self_url, row)).collect();
    format!(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>BLUDV (resolver)</title></head>\n<body><div class=\"posts\">\n{}\n</div></body></html>",
        body.join("\n")
    )
}
