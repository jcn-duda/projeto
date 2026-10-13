//! Paridade do TorrentDosFilmes com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/torrentdosfilmes.mjs`
//!
//! Sem teste de limpeza de título: o profile não exporta a limpeza própria, e
//! o título limpo é coberto pelo golden de `releaseTitle`.

mod golden_support;

use adom_resolvers::sites::site_output;
use adom_resolvers::sites::torrentdosfilmes::parse_search_posts;
use golden_support::{check_posts, check_search, check_titles, load};

const SITE: &str = "torrentdosfilmes";

#[test]
fn botoes_titulos_e_pagina() {
    check_posts(site_output(SITE).unwrap(), &load(SITE));
}

#[test]
fn titulo_da_release_combinatorio() {
    check_titles(site_output(SITE).unwrap(), &load(SITE));
}

#[test]
fn posts_da_busca() {
    check_search(&|html, base| parse_search_posts(html, base), &load(SITE));
}
