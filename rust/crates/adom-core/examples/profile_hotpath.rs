//! Micro-bench de perfuração: cronometra os helpers do caminho quente de
//! `decisions_for_year` sobre o corpus real (tmp/dare-corpus.tsv).
//! Uso: cargo run -p adom-core --release --example profile_hotpath

use std::io::Read;
use std::time::Instant;

use adom_core::{
    admits_multi_work_pack, franchise_extension_contradicts, is_non_feature, magnet_display_name,
    magnet_year_contradicts, matches_br_title, matches_name, matches_short_name_identity,
    matches_title_structure, pre_home_release_contradicts, release_title_facts,
    short_name_identity, title_tokens,
};

struct Row {
    is_br: bool,
    title: String,
    uri: String,
}

fn load() -> Vec<Row> {
    let mut s = String::new();
    std::fs::File::open("../tmp/dare-corpus.tsv")
        .expect("corpus")
        .read_to_string(&mut s)
        .expect("leitura");
    s.lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut parts = l.splitn(3, '\t');
            Row {
                is_br: parts.next() == Some("1"),
                title: parts.next().unwrap_or("").to_string(),
                uri: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect()
}

fn bench(nome: &str, f: impl Fn(&Row)) {
    let rows = load();
    let t0 = Instant::now();
    for r in &rows {
        f(r);
    }
    let d = t0.elapsed();
    println!(
        "{nome:36} {:>10.1} µs/lote  {:>7.2} µs/item",
        d.as_secs_f64() * 1e6,
        d.as_secs_f64() * 1e6 / rows.len() as f64
    );
}

fn main() {
    let names = vec!["Daredevil".to_string()];
    let year = "2015";
    let checks: Vec<_> = names.iter().map(|n| short_name_identity(n)).collect();

    bench("title_tokens", |r| {
        let _ = title_tokens(&r.title);
    });
    bench("magnet_display_name", |r| {
        let _ = magnet_display_name(Some(&r.uri), None, None);
    });
    bench("release_title_facts", |r| {
        let _ = release_title_facts(&r.title);
    });
    bench("matches_name", |r| {
        let t = title_tokens(&r.title);
        let _ = matches_name(&r.title, &names[0], Some(&t));
    });
    bench("matches_br_title", |r| {
        let t = title_tokens(&r.title);
        let _ = matches_br_title(
            &r.title,
            &names[0],
            year,
            false,
            Some(&names),
            Some(&t),
            None,
            true,
        );
    });
    bench("matches_short_name_identity", |r| {
        let t = title_tokens(&r.title);
        let _ = matches_short_name_identity(&r.title, &checks[0], Some(&t), "");
    });
    bench("matches_title_structure", |r| {
        let t = title_tokens(&r.title);
        let _ = matches_title_structure(&r.title, &names[0], year, false, Some(&t));
    });
    bench("franchise_extension_contradicts", |r| {
        let t = title_tokens(&r.title);
        let _ = franchise_extension_contradicts(&r.title, Some(&t), &names[0], &names, year);
    });
    bench("matches_episode_work_identity", |r| {
        let t = title_tokens(&r.title);
        let _ =
            adom_core::matches_episode_work_identity(&r.title, Some(&names), Some(&t), None, true);
    });
    bench("magnet_year_contradicts", |r| {
        let _ = magnet_year_contradicts(Some(&r.uri), None, None, 2015);
    });
    let name_strs = vec!["Daredevil"];
    bench("is_non_feature", |r| {
        let _ = is_non_feature(&[&r.title], &name_strs);
    });
    bench("pre_home_release_contradicts", |r| {
        let _ =
            pre_home_release_contradicts(&[&r.title], None, 1_760_000_000_000, true, 172_800_000);
    });
    bench("admits_multi_work_pack", |r| {
        let _ = admits_multi_work_pack(&r.title, &r.uri, None, year, false, &names);
    });
    // Lote completo: filter_relevant_raw_for_year com a query do bench.
    let rows = load();
    let items: Vec<adom_core::RelevanceItem> = rows
        .iter()
        .map(|r| adom_core::RelevanceItem {
            title: Some(r.title.clone()),
            title_pascal: None,
            magnet: Some(r.uri.clone()),
            magnet_uri: None,
            guid: None,
            is_br: r.is_br,
        })
        .collect();
    let query = adom_core::RelevanceQuery {
        names: &names,
        year,
        alt_year: None,
        is_series: false,
        season: None,
        episode: None,
        multi_work_root: None,
        home_release_at: None,
    };
    let settings = adom_core::RelevanceSettings {
        now_ms: 1_760_000_000_000,
        pre_home_release_cut: true,
        pre_home_release_margin_ms: 172_800_000,
        title_precision_tail_cut: true,
    };
    let t0 = Instant::now();
    let out = adom_core::filter_relevant_raw_for_year(&items, &query, &settings);
    let d = t0.elapsed();
    println!(
        "filter_relevant_raw_for_year        {:>10.1} µs/lote  kept={}",
        d.as_secs_f64() * 1e6,
        out.kept.len()
    );
}
