//! Apoio dos testes golden por site: carrega `tests/golden/<site>.json` (gerado
//! por `scripts/rust/resolver-golden/<site>.mjs`) e compara a saída do Rust com
//! a do TS. Cada `tests/<site>_golden.rs` faz `mod golden_support;` e chama
//! `check_site`.
#![allow(dead_code)]

use std::path::PathBuf;

use adom_crawl::profile_parsers::ResolverLink;
use adom_resolvers::common::{SearchItem, SitePost};
use adom_resolvers::sites::SiteOutput;
use serde_json::Value;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

pub fn fixture(name: &str) -> String {
    let path = repo_root().join("test/fixtures").join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {}: {e}", path.display()))
}

pub fn load(site: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(format!("{site}.json"));
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("golden {}: {e} (rode o oráculo)", path.display()));
    serde_json::from_str(&text).expect("golden é JSON")
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

fn opt_u32(v: &Value) -> Option<u32> {
    v.as_u64().map(|n| n as u32)
}

pub fn post_of(v: &Value) -> SitePost {
    SitePost {
        title: v["title"].as_str().unwrap_or("").to_string(),
        url: v["url"].as_str().unwrap_or("").to_string(),
        poster: opt_str(&v["poster"]),
        date: opt_str(&v["date"]),
        year: opt_u32(&v["year"]),
    }
}

/// Link do golden → ResolverLink. Campo `_extra_*` (que o TS emite e o Rust
/// não modela) falha o teste: a saída do site dependeria dele.
pub fn link_of(v: &Value) -> ResolverLink {
    if let Some(obj) = v.as_object() {
        let extras: Vec<&String> = obj.keys().filter(|k| k.starts_with("_extra_")).collect();
        assert!(
            extras.is_empty(),
            "link do TS com campos não modelados: {extras:?}"
        );
    }
    ResolverLink {
        url: v["url"].as_str().unwrap_or("").to_string(),
        quality: opt_u32(&v["quality"]),
        size: opt_str(&v["size"]),
        audio: opt_str(&v["audio"]),
        episode: opt_u32(&v["episode"]),
        episode_last: opt_u32(&v["episode_last"]),
        season: opt_u32(&v["season"]),
        source: opt_str(&v["source"]),
        real_title: opt_str(&v["real_title"]),
        description: opt_str(&v["description"]),
    }
}

/// Compara os botões, o título de cada um, a página HTML e o feed de cada post.
pub fn check_posts(site: &dyn SiteOutput, golden: &Value) {
    let self_url = golden["self_url"].as_str().unwrap_or("http://127.0.0.1");
    let mut failures = Vec::new();
    for entry in golden["posts"].as_array().expect("posts") {
        let name = entry["fixture"].as_str().unwrap();
        let post = post_of(&entry["post"]);
        let got = site.post_links(&fixture(name), &post.url);
        if let Some(err) = entry["error"].as_str() {
            match got {
                Err(_) => {}
                Ok(links) => failures.push(format!(
                    "{name}: TS lançou ({err}), Rust devolveu {} botões",
                    links.len()
                )),
            }
            continue;
        }
        let want: Vec<ResolverLink> = entry["links"]
            .as_array()
            .unwrap()
            .iter()
            .map(link_of)
            .collect();
        match got {
            Err(e) => failures.push(format!(
                "{name}: Rust falhou ({e}), TS deu {} botões",
                want.len()
            )),
            Ok(links) if links != want => {
                failures.push(format!("{name}: botões\n  rust={links:#?}\n  ts={want:#?}"))
            }
            Ok(_) => {}
        }
        for (i, (link, title)) in want
            .iter()
            .zip(entry["titles"].as_array().unwrap())
            .enumerate()
        {
            let got = site.release_title(&post, link, Some(i));
            if got != title.as_str().unwrap() {
                failures.push(format!("{name}#{i} título\n  rust={got}\n  ts  ={title}"));
            }
        }
        let items: Vec<SearchItem> = want
            .iter()
            .enumerate()
            .map(|(index, link)| SearchItem {
                post: post.clone(),
                link: link.clone(),
                index,
                count: want.len(),
            })
            .collect();
        if let Some(html) = entry["html"].as_str() {
            let got = site.search_page_html(self_url, &items);
            if got != html {
                failures.push(format!("{name}: página\n  rust={got}\n  ts  ={html}"));
            }
        }
        if let Some(rss) = entry["rss"].as_str() {
            match site.rss_xml(self_url, &items, 2000) {
                Some(got) if got == rss => {}
                got => failures.push(format!("{name}: feed\n  rust={got:?}\n  ts  ={rss}")),
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

/// `releaseTitle` combinatório (tags, episódio, opção N).
pub fn check_titles(site: &dyn SiteOutput, golden: &Value) {
    let mut failures = Vec::new();
    for case in golden["titles"].as_array().expect("titles") {
        let post = post_of(&case["post"]);
        let link = link_of(&case["link"]);
        let index = case["index"].as_u64().map(|i| i as usize);
        let got = site.release_title(&post, &link, index);
        let want = case["out"].as_str().unwrap();
        if got != want {
            failures.push(format!(
                "{:?} {link:?} {index:?}\n  rust={got}\n  ts  ={want}",
                post.title
            ));
        }
    }
    let shown: Vec<&String> = failures.iter().take(15).collect();
    assert!(
        failures.is_empty(),
        "{} título(s) divergentes:\n{shown:#?}",
        failures.len()
    );
}

/// `cleanTitle` sobre o corpus.
pub fn check_clean(clean: fn(&str) -> String, golden: &Value) {
    let mut failures = Vec::new();
    for pair in golden["clean"].as_array().expect("clean") {
        let input = pair[0].as_str().unwrap();
        let want = pair[1].as_str().unwrap();
        let got = clean(input);
        if got != want {
            failures.push(format!("{input:?}\n  rust={got:?}\n  ts  ={want:?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} limpeza(s) divergentes:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Posts da busca: `(title, url, poster)` do parser de listagem do Rust.
pub fn check_search(parse: &dyn Fn(&str, &str) -> Vec<SitePost>, golden: &Value) {
    let mut failures = Vec::new();
    for entry in golden["search"].as_array().expect("search") {
        let name = entry["fixture"].as_str().unwrap();
        let base = entry["base_url"].as_str().unwrap();
        let got: Vec<(String, String, Option<String>)> = parse(&fixture(name), base)
            .into_iter()
            .map(|p| (p.title, p.url, p.poster))
            .collect();
        let want: Vec<(String, String, Option<String>)> = entry["posts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let p = post_of(p);
                (p.title, p.url, p.poster)
            })
            .collect();
        if got != want {
            failures.push(format!("{name}\n  rust={got:#?}\n  ts  ={want:#?}"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} busca(s) divergentes:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
