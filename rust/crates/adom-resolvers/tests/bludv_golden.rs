//! Paridade do BLUDV com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/bludv.mjs`
//!
//! O feed torznab fica fora do `check_posts` compartilhado: quando o post não
//! tem `dd/mm/aaaa`, o TS carimba `new Date().toUTCString()` — o oráculo
//! congela esse relógio, então o teste compara o feed com a data que o próprio
//! golden registrou (`feed_with_date`). O resto do feed sai byte a byte.

mod golden_support;

use adom_crawl::profile_parsers::ResolverLink;
use adom_resolvers::common::{clean_post_title, SearchItem, SitePost};
use adom_resolvers::sites::bludv::{feed_with_date, parse_post_date, parse_search_posts, BLUDV};
use adom_resolvers::sites::site_output;
use golden_support::{
    check_clean, check_posts, check_search, check_titles, link_of, load, post_of,
};
use serde_json::Value;

const SITE: &str = "bludv";

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
    check_titles(&BLUDV, &load(SITE));
}

#[test]
fn limpeza_do_titulo_do_post() {
    check_clean(clean_post_title, &load(SITE));
}

#[test]
fn posts_da_busca() {
    check_search(
        &|html, base| -> Vec<SitePost> { parse_search_posts(html, base) },
        &load(SITE),
    );
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
        // Todos os itens de um post carregam o mesmo pubDate: ele sai ou do
        // `dd/mm/aaaa` do post (calculado) ou do relógio congelado do oráculo.
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

#[test]
fn post_datado_nao_herda_a_data_congelada() {
    // Regressão do falso verde: o oráculo congela o relógio e o Rust devolvia
    // a data congelada para QUALQUER post, com o dia da semana fixo em "Sun".
    // Oráculo Node: `new Date(Date.UTC(2016, 3, 5)).toUTCString()`.
    const RELOGIO: &str = "RELOGIO_CONGELADO_DO_ORACULO";
    assert_eq!(
        parse_post_date(Some("05/04/2016"), RELOGIO),
        "Tue, 05 Apr 2016 00:00:00 GMT"
    );
    assert_eq!(
        parse_post_date(Some("02/03/2024"), RELOGIO),
        "Sat, 02 Mar 2024 00:00:00 GMT"
    );
    // Sem data legível, a injetada (o relógio) é que vale.
    assert_eq!(parse_post_date(None, RELOGIO), RELOGIO);
}
