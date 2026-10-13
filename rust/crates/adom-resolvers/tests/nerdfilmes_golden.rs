//! Paridade do NerdFilmes com o profile TS. Golden:
//! `ADOM_DIST="<dist>" DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/nerdfilmes.mjs`

mod golden_support;

use std::path::PathBuf;

use adom_resolvers::sites::nerdfilmes::{
    clean_nerd_post_title, parse_post_date, parse_search_posts,
};
use adom_resolvers::sites::site_output;
use golden_support::{check_clean, check_posts, check_search, check_titles, load};

const SITE: &str = "nerdfilmes";

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
    check_clean(clean_nerd_post_title, &load(SITE));
}

#[test]
fn posts_da_busca() {
    check_search(
        &|html: &str, base: &str| parse_search_posts(html, base),
        &load(SITE),
    );
}

/// `parsePostDate` não entra no golden de `goldenRun` (o post não traz data):
/// o oráculo grava casos próprios em `nerdfilmes-date.json`.
#[test]
fn data_do_post() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/nerdfilmes-date.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden {}: {e} (rode o oráculo)", path.display()));
    let golden: serde_json::Value = serde_json::from_str(&text).expect("golden é JSON");
    let mut failures = Vec::new();
    for case in golden["cases"].as_array().expect("cases") {
        let html = case["html"].as_str().unwrap_or("");
        let want = case["date"].as_str().map(str::to_string);
        let got = parse_post_date(html);
        if got != want {
            failures.push(format!("{html:?}\n  rust={got:?}\n  ts  ={want:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} data(s) divergentes:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
