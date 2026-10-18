use super::*;
use serde_json::json;

fn stream(hash: &str, name: &str, seeders: f64) -> RankingStream {
    serde_json::from_value(json!({
        "infoHash": hash, "name": name, "_seeders": seeders,
    }))
    .expect("stream de teste")
}

fn run(streams: Vec<RankingStream>, options: SortOptions) -> SortOutput {
    sort_and_limit(&SortInput {
        streams,
        options,
        instant_hashes: HashSet::new(),
    })
}

#[test]
fn lista_vazia() {
    let out = run(vec![], SortOptions::default());
    assert!(out.streams.is_empty());
    assert!(out.drops.is_empty());
    assert!(!out.quality_relaxed);
}

#[test]
fn piso_de_seeders_corta_e_waiver_br_dublado_salva() {
    let weak_br = serde_json::from_value::<RankingStream>(json!({
        "infoHash": "a".repeat(40), "name": "Filme DUBLADO", "_seeders": 0,
        "_br": true, "_dubbed": true,
    }))
    .unwrap();
    let weak_en = stream(&"b".repeat(40), "EN only", 0.0);
    let out = run(
        vec![weak_br, weak_en],
        SortOptions {
            min_seeders: 5.0,
            ..SortOptions::default()
        },
    );
    assert_eq!(out.streams.len(), 1);
    assert_eq!(out.streams[0].br, Some(true));
    assert_eq!(
        out.streams[0].extra.get("_seedFloorWaived"),
        Some(&Value::Bool(true))
    );
    assert_eq!(out.waived_hashes, vec!["a".repeat(40)]);
    assert_eq!(out.drops.len(), 1);
    assert_eq!(out.drops[0].reason, "min-seeders");
    assert_eq!(out.drops[0].label, "EN only");
}

#[test]
fn ordena_por_qualidade_e_corta_no_max_results() {
    let mk = |name: &str, q: &str, seeds: f64| {
        serde_json::from_value::<RankingStream>(json!({
            "infoHash": name.repeat(4), "name": name,
            "_seeders": seeds, "_quality": q,
        }))
        .unwrap()
    };
    let options = SortOptions {
        max_results: 2.0,
        ..SortOptions::default()
    };
    let out = run(
        vec![
            mk("sd", "SD", 90.0),
            mk("fhd", "1080p", 1.0),
            mk("uhd", "2160p", 1.0),
        ],
        options,
    );
    assert_eq!(out.streams.len(), 2);
    assert_eq!(out.streams[0].quality.as_deref(), Some("2160p"));
    assert_eq!(out.streams[1].quality.as_deref(), Some("1080p"));
    assert_eq!(
        out.drops.last().map(|d| d.reason.as_str()),
        Some("pool-cut")
    );
    // `_seeders` sai da resposta (o TS o destrutura).
    assert_eq!(out.streams[0].seeders, None);
}

#[test]
fn quality_filter_vazio_reabre_sd_como_ultimo_recurso() {
    let mk = |name: &str, q: &str, br: bool| {
        serde_json::from_value::<RankingStream>(json!({
            "infoHash": name.repeat(4), "name": name,
            "_seeders": 5, "_quality": q, "_br": br,
        }))
        .unwrap()
    };
    let options = SortOptions {
        quality_filter: vec!["1080p".to_string()],
        ..SortOptions::default()
    };
    let out = run(vec![mk("sd", "SD", true)], options);
    assert_eq!(out.streams.len(), 1);
    assert!(out.quality_relaxed);
}

#[test]
fn prefer_dubbed_e_instant_desempatam_antes_de_seeders() {
    let mk = |name: &str, hash: String, seeds: f64, dubbed: bool| {
        serde_json::from_value::<RankingStream>(json!({
            "infoHash": hash, "name": name, "_seeders": seeds, "_dubbed": dubbed,
        }))
        .unwrap()
    };
    let mut instant_hashes = HashSet::new();
    instant_hashes.insert("c".repeat(40));
    let options = SortOptions {
        prefer_dubbed: true,
        ..SortOptions::default()
    };
    let out = sort_and_limit(&SortInput {
        streams: vec![
            mk("seeds", "d".repeat(40), 500.0, false),
            mk("dub", "a".repeat(40), 10.0, true),
            mk("instant", "c".repeat(40), 10.0, false),
        ],
        options,
        instant_hashes,
    });
    let names: Vec<_> = out
        .streams
        .iter()
        .map(|s| s.name.clone().unwrap())
        .collect();
    assert_eq!(names, vec!["dub", "instant", "seeds"]);
}
