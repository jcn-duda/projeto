//! Paridade do HDR Torrents com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/hdrtorrents.mjs`

mod golden_support;

use adom_resolvers::common::{clean_post_title, SitePost};
use adom_resolvers::sites::hdrtorrents::parse_listing_html;
use adom_resolvers::sites::site_output;
use golden_support::{check_clean, check_posts, check_search, check_titles, load};

const SITE: &str = "hdrtorrents";

#[test]
fn botoes_titulos_e_pagina() {
    check_posts(site_output(SITE).unwrap(), &load(SITE));
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
