//! Paridade do BLUDV com o profile TS. Golden:
//! `ADOM_DIST="E:/stremio adom/dist" DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/bludv.mjs`

mod golden_support;

use adom_resolvers::common::{clean_post_title, SitePost};
use adom_resolvers::sites::bludv::{parse_search_posts, BLUDV};
use adom_resolvers::sites::site_output;
use golden_support::{check_clean, check_posts, check_search, check_titles, load};

const SITE: &str = "bludv";

#[test]
fn botoes_titulos_e_pagina() {
    check_posts(site_output(SITE).unwrap(), &load(SITE));
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
