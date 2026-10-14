//! Paridade do Rede Torrent com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/redetorrent.mjs`

mod golden_support;

use adom_resolvers::sites::redetorrent::{clean_title, parse_search_posts};
use adom_resolvers::sites::site_output;
use golden_support::{check_clean, check_posts, check_search, check_titles, load};

const SITE: &str = "redetorrent";

#[test]
fn botoes_titulos_pagina_e_feed() {
    check_posts(site_output(SITE).unwrap(), &load(SITE));
}

#[test]
fn titulo_da_release_combinatorio() {
    check_titles(site_output(SITE).unwrap(), &load(SITE));
}

#[test]
fn limpeza_do_titulo_do_post() {
    check_clean(clean_title, &load(SITE));
}

#[test]
fn posts_da_busca() {
    check_search(&parse_search_posts, &load(SITE));
}
