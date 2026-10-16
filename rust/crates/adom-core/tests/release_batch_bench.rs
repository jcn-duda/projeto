//! Medição (ignorada no CI) do custo por release das funções que o lote napi
//! `evaluateReleases` chama. Mede cada função isolada e a soma, para achar
//! onde vai o tempo antes de otimizar.
//!
//! Corpus: JSON `[{title, uri}]` em `ADOM_BENCH_CORPUS` (títulos reais tirados
//! do `magnets.db`); sem ele usa os títulos do golden de normalização.
//!
//! ```text
//! cargo test --release -p adom-core --test release_batch_bench -- --ignored --nocapture
//! ```

use std::time::Instant;

use adom_core::{
    br_origin_mark, extract_info_hash, has_pt_signs, is_safe_download_url, magnet_display_name,
    matches_br_title, normalize_title, parse_title_season_episode, title_tokens,
};

struct Row {
    title: String,
    uri: String,
    names: Vec<String>,
}

/// Nome da obra = palavras antes do primeiro token com dígito (o que a busca
/// teria pedido), mais um segundo nome para simular o alias pt-BR.
fn names_for(title: &str) -> Vec<String> {
    let head: Vec<&str> = title
        .split([' ', '.'])
        .take_while(|w| !w.is_empty() && !w.chars().any(|c| c.is_ascii_digit()))
        .take(4)
        .collect();
    let name = if head.is_empty() {
        "Show".to_string()
    } else {
        head.join(" ")
    };
    vec![name, "O Escritório".to_string()]
}

fn corpus() -> Vec<Row> {
    let raw: Vec<(String, String)> = match std::env::var("ADOM_BENCH_CORPUS") {
        Ok(path) => {
            let text = std::fs::read_to_string(path).expect("corpus legível");
            let v: serde_json::Value = serde_json::from_str(&text).expect("corpus JSON");
            v.as_array()
                .expect("array")
                .iter()
                .map(|r| {
                    let s = |k: &str| r[k].as_str().unwrap_or("").to_string();
                    (s("title"), s("uri"))
                })
                .collect()
        }
        Err(_) => {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../golden/title-normalization.jsonl"
            );
            std::fs::read_to_string(path)
                .expect("golden")
                .lines()
                .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .filter_map(|v| v["input"].as_str().map(|s| (s.to_string(), String::new())))
                .take(450)
                .collect()
        }
    };
    raw.into_iter()
        .map(|(title, uri)| {
            let names = names_for(&title);
            Row { title, uri, names }
        })
        .collect()
}

fn time<F: FnMut(&Row)>(label: &str, rows: &[Row], probes_per_row: usize, mut f: F) -> f64 {
    const ROUNDS: usize = 30;
    // Uma volta de aquecimento: o OnceLock das regex não entra na conta.
    rows.iter().for_each(&mut f);
    let start = Instant::now();
    for _ in 0..ROUNDS {
        rows.iter().for_each(&mut f);
    }
    let us = start.elapsed().as_secs_f64() * 1e6 / (ROUNDS * rows.len() * probes_per_row) as f64;
    println!("{label:<28} {us:>8.2} µs/probe");
    us
}

#[test]
#[ignore = "benchmark: rode com --ignored --nocapture"]
fn bench_release_batch() {
    let rows = corpus();
    println!("corpus: {} releases × 2 nomes", rows.len());

    time("normalize_title", &rows, 1, |r| {
        std::hint::black_box(normalize_title(&r.title));
    });
    time("has_pt_signs", &rows, 1, |r| {
        std::hint::black_box(has_pt_signs(&r.title));
    });
    time("br_origin_mark", &rows, 1, |r| {
        std::hint::black_box(br_origin_mark(&r.title));
    });
    time("parse_title_season_episode", &rows, 1, |r| {
        std::hint::black_box(parse_title_season_episode(&r.title));
    });
    time("extract_info_hash", &rows, 1, |r| {
        std::hint::black_box(extract_info_hash(&r.uri));
    });
    time("magnet_display_name", &rows, 1, |r| {
        std::hint::black_box(magnet_display_name(Some(&r.uri), None, None));
    });
    time("is_safe_download_url", &rows, 1, |_| {
        std::hint::black_box(is_safe_download_url("https://example.com/x.torrent", false));
    });
    time("matches_br_title", &rows, 2, |r| {
        for name in &r.names {
            std::hint::black_box(matches_br_title(
                &r.title,
                name,
                "2022",
                true,
                Some(r.names.as_slice()),
                None,
                None,
                true,
            ));
        }
    });
    let universe: Vec<String> = rows[0].names.iter().flat_map(|n| title_tokens(n)).collect();
    time("matches_br_title (pré-tok.)", &rows, 2, |r| {
        let own = title_tokens(&r.title);
        for name in &r.names {
            std::hint::black_box(matches_br_title(
                &r.title,
                name,
                "2022",
                true,
                Some(r.names.as_slice()),
                Some(own.as_slice()),
                Some(universe.as_slice()),
                true,
            ));
        }
    });
    let uni = universe.clone();
    {
        use adom_core::*;
        let n0 = rows[0].names[0].clone();
        let toks: Vec<Vec<String>> = rows.iter().map(|r| title_tokens(&r.title)).collect();
        let mut k = 0;
        time("  name_coverage_tokens", &rows, 1, |_| {
            std::hint::black_box(name_coverage_tokens(&n0));
        });
        time("  title_tokens(name)", &rows, 1, |_| {
            std::hint::black_box(title_tokens(&n0));
        });
        time("  matches_name(tok)", &rows, 1, |r| {
            k = (k + 1) % rows.len();
            std::hint::black_box(matches_name(&r.title, &n0, Some(&toks[k])));
        });
        time("  episode_work_tokens", &rows, 1, |_| {
            k = (k + 1) % rows.len();
            std::hint::black_box(episode_work_tokens(&toks[k]));
        });
        time("  title_precision", &rows, 1, |_| {
            k = (k + 1) % rows.len();
            std::hint::black_box(title_precision(&toks[k], &uni, true));
        });
        time("  matches_title_structure", &rows, 1, |r| {
            k = (k + 1) % rows.len();
            std::hint::black_box(matches_title_structure(
                &r.title,
                &n0,
                "2011",
                true,
                Some(&toks[k]),
            ));
        });
    }
}
