//! Paridade do ComandoTorrents com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/comandotorrents.mjs`

mod golden_support;

use adom_resolvers::common::{clean_post_title, SitePost};
use adom_resolvers::listing_parsers::parse_listing_posts;
use adom_resolvers::sites::site_output;
use golden_support::{check_clean, check_posts, check_search, check_titles, load};

const SITE: &str = "comandotorrents";

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
fn posts_da_busca() {
    check_search(
        &|html, base| {
            parse_listing_posts(SITE, html, base)
                .into_iter()
                .map(|p| SitePost {
                    title: p.title,
                    url: p.url,
                    poster: p.poster,
                    ..Default::default()
                })
                .collect()
        },
        &load(SITE),
    );
}
