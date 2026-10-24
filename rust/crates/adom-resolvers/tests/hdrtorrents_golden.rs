//! Paridade do HDR Torrents com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/hdrtorrents.mjs`
//!
//! O feed torznab fica fora do `check_posts` compartilhado: ele carimba a data
//! do relógio, então o teste compara o feed com a data que o próprio golden
//! registrou (`feed_with_date`). O resto do feed (itens, títulos, escape) é
//! comparado byte a byte.

mod golden_support;

use adom_crawl::profile_parsers::ResolverLink;
use adom_resolvers::common::{clean_post_title, SearchItem, SitePost};
use adom_resolvers::sites::hdrtorrents::{feed_with_date, parse_listing_html, utc_date};
use adom_resolvers::sites::site_output;
use golden_support::{
    check_clean, check_posts, check_search, check_titles, link_of, load, post_of,
};
use serde_json::Value;

const SITE: &str = "hdrtorrents";

/// Golden sem o feed: `check_posts` compararia com o relógio real.
fn golden_without_feed() -> Value {
    let mut golden = load(SITE);
    for entry in golden["posts"].as_array_mut().expect("posts") {
        entry.as_object_mut().expect("post").remove("rss");
    }
    golden
}

#[test]
fn botoes_titulos_e_pagina() {
    check_posts(site_output(SITE).unwrap(), &golden_without_feed());
}

#[test]
fn titulo_da_release_combinatorio() {
    check_titles(site_output(SITE).unwrap(), &load(SITE));
}

#[test]
fn limpeza_do_titulo_do_post() {
    check_clean(clean_post_title, &load(SITE));
}

#[test]
fn cards_da_listagem() {
    check_search(
        &|html, base| {
            parse_listing_html(html, base)
                .expect("listagem sem erro")
                .into_iter()
                .map(|w| SitePost {
                    title: w.title,
                    url: w.url,
                    poster: w.poster,
                    date: None,
                    year: w.year,
                    kind: None,
                })
                .collect()
        },
        &load(SITE),
    );
}

#[test]
fn feed_torznab_com_a_data_do_golden() {
    let golden = load(SITE);
    let mut checked = 0;
    let mut failures = Vec::new();
    for entry in golden["posts"].as_array().expect("posts") {
        let Some(want) = entry["rss"].as_str() else {
            continue;
        };
        checked += 1;
        let post = post_of(&entry["post"]);
        let links: Vec<ResolverLink> = entry["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(link_of)
            .collect();
        let items: Vec<SearchItem> = links
            .iter()
            .enumerate()
            .map(|(index, link)| SearchItem {
                post: post.clone(),
                link: link.clone(),
                index,
                count: links.len(),
                seeders: None,
                leechers: None,
            })
            .collect();
        // A data do golden vem do relógio congelado do oráculo: todos os itens
        // do post carregam a mesma data.
        let dates: Vec<&str> = want
            .split("<pubDate>")
            .skip(1)
            .map(|rest| rest.split("</pubDate>").next().unwrap_or_default())
            .collect();
        // Feed sem itens (post sem botão) não tem pubDate: a data não se usa.
        let date = dates.first().copied().unwrap_or("");
        assert!(
            dates.iter().all(|d| *d == date),
            "pubDate difere entre itens: {dates:?}"
        );
        let got = feed_with_date(&items, 2000, date);
        if got != want {
            failures.push(format!("{}: feed\n  rust={got}\n  ts  ={want}", post.title));
        }
    }
    assert!(checked > 0, "golden sem nenhum feed");
    assert!(
        failures.is_empty(),
        "feed divergente:\n{}",
        failures.join("\n")
    );
}

#[test]
fn utc_date_formata_como_to_utc_string() {
    // Instante congelado do oráculo (Date.UTC(2026, 9, 13, 12)).
    assert_eq!(utc_date(1_791_892_800), "Tue, 13 Oct 2026 12:00:00 GMT");
}
