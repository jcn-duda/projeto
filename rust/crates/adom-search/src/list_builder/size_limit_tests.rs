//! `maxSizeGb` em série: pack julga o episódio, não a temporada inteira.

use std::collections::BTreeMap;

use adom_core::{DebridFile, RankingStream};

use super::super::tests::test_common::*;

const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
const PACK: &str = "a100000000000000000000000000000000000001";
const BIG_EP: &str = "a100000000000000000000000000000000000002";
const BIG_EXACT: &str = "a100000000000000000000000000000000000003";
const SMALL_EXACT: &str = "a100000000000000000000000000000000000004";
const NO_COUNT: &str = "a100000000000000000000000000000000000005";

fn series_ctx(files: BTreeMap<String, Vec<DebridFile>>) -> BuildContext {
    BuildContext {
        names: vec!["Serie Teste".to_string()],
        year: "2020".into(),
        season: Some(1),
        episode: Some(2),
        episode_counts: vec![(1, 10)],
        files_by_hash: files,
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    }
}

fn sized(title: &str, hash: &str, gib: f64) -> RawItem {
    RawItem {
        size_bytes: Some(gib * GIB),
        ..release(title, hash)
    }
}

/// Temporada de 10 episódios com o E02 de `ep_gib`.
fn season_files(ep_gib: f64) -> Vec<DebridFile> {
    (1..=10)
        .map(|e| DebridFile {
            path: format!("Serie.Teste.S01E{e:02}.1080p.WEB-DL.mkv"),
            size: if e == 2 { ep_gib * GIB } else { 2.0 * GIB },
        })
        .collect()
}

fn opts(max_size_gb: f64) -> BuildOptions {
    BuildOptions {
        max_size_gb,
        max_results: 20.0,
        ..BuildOptions::default()
    }
}

fn kept(out: &BuiltList) -> Vec<String> {
    let mut hashes: Vec<String> = out
        .streams
        .iter()
        .filter_map(|s| s.info_hash.clone())
        .collect();
    hashes.sort();
    hashes
}

fn run(max_size_gb: f64) -> BuiltList {
    let files = BTreeMap::from([
        (BIG_EXACT.to_string(), season_files(32.0)),
        (SMALL_EXACT.to_string(), season_files(3.0)),
    ]);
    let ctx = series_ctx(files);
    let raw = vec![
        // 45 GiB / 10 episódios = 4,5 GiB por episódio: cabe.
        sized("Serie Teste S01 1080p WEB-DL DUBLADO", PACK, 45.0),
        // Episódio avulso de 35 GiB: não é pack, julga o total.
        sized("Serie Teste S01E02 2160p REMUX", BIG_EP, 35.0),
        // Lista de arquivos: o E02 tem 32 GiB.
        sized("Serie Teste S01 2160p WEB-DL", BIG_EXACT, 50.0),
        // Lista de arquivos: o E02 tem 3 GiB, o pack 60.
        sized("Serie Teste S01 1080p BluRay", SMALL_EXACT, 60.0),
        // Temporada 2 sem contagem nem lista: sem medida, passa.
        sized("Serie Teste S01-S02 1080p", NO_COUNT, 90.0),
    ];
    build(raw, &ctx, &opts(max_size_gb), &mut StubDebrid::all())
}

#[test]
fn pack_julga_o_episodio_e_avulso_julga_o_total() {
    let out = run(30.0);
    assert_eq!(
        kept(&out),
        vec![PACK.to_string(), SMALL_EXACT.to_string(), NO_COUNT.to_string()],
        "pack de 45/60/90 GiB fica; E02 avulso de 35 e E02 exato de 32 saem"
    );
    assert_eq!(out.funnel.get("size-limit"), Some(&2));
}

#[test]
fn sem_limite_nada_muda() {
    let out = run(0.0);
    assert_eq!(kept(&out).len(), 5);
    assert_eq!(out.funnel.get("size-limit"), None);
}

#[test]
fn filme_segue_cortado_pelo_total() {
    let ctx = BuildContext {
        names: vec!["Filme Teste".to_string()],
        year: "2024".into(),
        now_ms: 1_700_000_000_000,
        ..BuildContext::default()
    };
    let raw = vec![
        sized("Filme Teste 2024 2160p BluRay REMUX", PACK, 51.0),
        sized("Filme Teste 2024 2160p WEB-DL", BIG_EP, 24.0),
    ];
    let out = build(raw, &ctx, &opts(30.0), &mut StubDebrid::all());
    assert_eq!(kept(&out), vec![BIG_EP.to_string()], "o Remux de 51 GiB sai");
}

#[test]
fn torrentio_ja_traz_o_tamanho_do_arquivo() {
    // Pack do Torrentio: o tamanho já é do arquivo do episódio, corte normal.
    let stream = RankingStream {
        title: Some("Serie Teste S01 1080p".into()),
        info_hash: Some(PACK.into()),
        size: Some(35.0 * GIB),
        indexer: Some("torrentio".into()),
        ..RankingStream::default()
    };
    let meta = [(1, 10)];
    let pack = adom_core::PackOpts {
        season: 1,
        episode: 2,
        meta: &meta,
    };
    assert!(!adom_core::fits_episode_size_limit(
        &stream,
        &BTreeMap::new(),
        &pack,
        30.0 * GIB
    ));
}
