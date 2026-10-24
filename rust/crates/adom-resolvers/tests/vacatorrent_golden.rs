//! Paridade do VacaTorrent com o profile TS. Golden:
//! `DOTENV_CONFIG_PATH=test/fixtures/env-empty node scripts/rust/resolver-golden/vacatorrent.mjs`

mod golden_support;

use adom_resolvers::sites::site_output;
use adom_resolvers::sites::vacatorrent::{
    clean_mark_title, extract_batch_title, extract_movie_links, parse_search_json,
    parse_season_internal, post_links_with, series_season_internal_url, VacaParseOptions,
    VacaSeasonCard,
};
use golden_support::{check_clean, check_posts, check_titles, fixture, link_of, load, post_of};
use serde_json::Value;

const SITE: &str = "vacatorrent";

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
    check_clean(clean_mark_title, &load(SITE));
}

/// `parseSearchJson` sobre as duas buscas AJAX (JSON cru do admin-ajax).
#[test]
fn busca_ajax_json() {
    let golden = load(SITE);
    let mut failures = Vec::new();
    for entry in golden["search"].as_array().expect("search") {
        let name = entry["fixture"].as_str().unwrap();
        let base = entry["base_url"].as_str().unwrap();
        let got: Vec<_> = match parse_search_json(&fixture(name), base) {
            Ok(works) => works
                .into_iter()
                .map(|w| (w.title, w.url, w.poster, w.year.map(|y| y as u64)))
                .collect(),
            Err(e) => {
                failures.push(format!("{name}: {e}"));
                continue;
            }
        };
        let want: Vec<_> = entry["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let p = post_of(p);
                (p.title, p.url, p.poster, p.year.map(u64::from))
            })
            .collect();
        if got != want {
            failures.push(format!("{name}\n  rust={got:#?}\n  ts  ={want:#?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Entrada de uma forma de página: a fixture pelo nome ou o HTML literal do caso.
fn input_of(case: &Value) -> String {
    match case["fixture"].as_str() {
        Some(name) => fixture(name),
        None => case["html"].as_str().unwrap().to_string(),
    }
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

/// Link da página de botões, URL do season-internal, cards e título do batch.
#[test]
fn formas_da_pagina() {
    let golden = load(SITE);
    let shapes = &golden["shapes"];
    let mut failures = Vec::new();

    for case in shapes["movie_links"].as_array().unwrap() {
        let got = extract_movie_links(&input_of(case), opt_str(&case["base"]).as_deref());
        if got != opt_str(&case["out"]) {
            failures.push(format!(
                "movie_links {:?}: rust={got:?} ts={}",
                case["fixture"], case["out"]
            ));
        }
    }

    for case in shapes["series_internal_url"].as_array().unwrap() {
        let got = series_season_internal_url(&input_of(case), opt_str(&case["base"]).as_deref());
        if got != opt_str(&case["out"]) {
            failures.push(format!(
                "series_internal_url {:?}: rust={got:?} ts={}",
                case["fixture"], case["out"]
            ));
        }
    }

    for case in shapes["season_internal"].as_array().unwrap() {
        let got: Vec<VacaSeasonCard> =
            parse_season_internal(&input_of(case), opt_str(&case["base"]).as_deref());
        let want: Vec<VacaSeasonCard> = case["out"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| VacaSeasonCard {
                url: c["url"].as_str().unwrap().to_string(),
                is_batch: c["isBatch"].as_bool().unwrap(),
                season: c["season"].as_u64().map(|n| n as u32),
                title: c["title"].as_str().unwrap().to_string(),
            })
            .collect();
        if got != want {
            failures.push(format!("season_internal: rust={got:#?}\n  ts  ={want:#?}"));
        }
    }

    for case in shapes["batch_title"].as_array().unwrap() {
        let got = extract_batch_title(&input_of(case));
        if got != opt_str(&case["out"]) {
            failures.push(format!(
                "batch_title {:?}: rust={got:?} ts={}",
                case["html"], case["out"]
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} forma(s) divergente(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Botões e títulos com `season`/`realTitle` do coletor (o caminho das séries).
#[test]
fn botoes_com_opcoes_de_serie() {
    let golden = load(SITE);
    let site = site_output(SITE).unwrap();
    let mut failures = Vec::new();
    for case in golden["shapes"]["links_with_options"].as_array().unwrap() {
        let name = case["fixture"].as_str().unwrap();
        let post = post_of(&case["post"]);
        let opts = VacaParseOptions {
            season: case["season"].as_u64().map(|n| n as u32),
            real_title: opt_str(&case["real_title"]),
        };
        let got = match post_links_with(&fixture(name), &post.url, &opts) {
            Ok(links) => links,
            Err(e) => {
                failures.push(format!("{name}: Rust falhou ({e})"));
                continue;
            }
        };
        let want: Vec<_> = case["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(link_of)
            .collect();
        if got != want {
            failures.push(format!("{name}: botões\n  rust={got:#?}\n  ts  ={want:#?}"));
            continue;
        }
        for (i, (link, title)) in want
            .iter()
            .zip(case["titles"].as_array().unwrap())
            .enumerate()
        {
            let got_title = site.release_title(&post, link, Some(i));
            if got_title != title.as_str().unwrap() {
                failures.push(format!(
                    "{name}#{i} título\n  rust={got_title}\n  ts  ={title}"
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} divergência(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}
