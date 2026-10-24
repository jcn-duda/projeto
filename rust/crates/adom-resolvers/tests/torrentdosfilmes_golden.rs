//! Paridade do TorrentDosFilmes com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/torrentdosfilmes.mjs`
//!
//! Sem teste de limpeza de título: o profile não exporta a limpeza própria, e
//! o título limpo é coberto pelo golden de `releaseTitle`.
//!
//! O feed torznab carimba `new Date().toUTCString()` em cada item (como o TS).
//! Para o golden ser reprodutível, o oráculo congela o relógio e o teste
//! compara o feed com a data que o próprio golden registrou (`feed_with_date`).

mod golden_support;

use adom_crawl::profile_parsers::ResolverLink;
use adom_resolvers::common::SearchItem;
use adom_resolvers::sites::site_output;
use adom_resolvers::sites::torrentdosfilmes::{feed_with_date, parse_search_posts};
use golden_support::{check_posts, check_search, check_titles, link_of, load, post_of};
use serde_json::Value;

const SITE: &str = "torrentdosfilmes";

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
fn posts_da_busca() {
    check_search(&|html, base| parse_search_posts(html, base), &load(SITE));
}

#[test]
fn feed_torznab_com_a_data_do_golden() {
    let golden = load(SITE);
    let self_url = golden["self_url"].as_str().unwrap_or("http://127.0.0.1");
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
            })
            .collect();
        // A data do golden vem do relógio congelado do oráculo: todos os itens
        // do post carregam a mesma data.
        let dates: Vec<&str> = want
            .split("<pubDate>")
            .skip(1)
            .map(|rest| rest.split("</pubDate>").next().unwrap_or_default())
            .collect();
        let date = dates.first().copied().unwrap_or("");
        assert!(
            dates.iter().all(|d| *d == date),
            "pubDate difere entre itens: {dates:?}"
        );
        let got = feed_with_date(self_url, &items, 2000, date);
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
