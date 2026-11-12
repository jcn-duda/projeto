//! Sufixo de revisão de fansub (`S03E02v2`) no seletor de episódio.
//! Medido em 2026-11-11: o pack do Judas de Jujutsu Kaisen S3 respondia
//! `episode_pick 404` no play porque a fronteira rejeitava o `v`.

use adom_core::{pick_file, DebridFile, PickOutcome, PlayHint};

fn file(path: &str) -> DebridFile {
    DebridFile {
        path: path.to_string(),
        size: 300.0 * 1024.0 * 1024.0,
    }
}

fn hint(season: i64, episode: i64) -> PlayHint {
    PlayHint {
        season: Some(season),
        episode: Some(episode),
        ..PlayHint::default()
    }
}

fn picked(files: &[DebridFile], h: &PlayHint) -> String {
    match pick_file(files, h) {
        PickOutcome::File { path, .. } => path,
        other => panic!("esperava arquivo, veio {other:?}"),
    }
}

#[test]
fn pack_com_sufixo_v2_escolhe_o_episodio() {
    let dir = "[Judas] Jujutsu Kaisen (Season 03) [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Batch)";
    let files = vec![
        file(&format!("{dir}/[Judas] JUJUTSU KAISEN - S03E01.mkv")),
        file(&format!("{dir}/[Judas] JUJUTSU KAISEN - S03E02v2.mkv")),
        file(&format!("{dir}/[Judas] JUJUTSU KAISEN - S03E03.mkv")),
    ];
    assert!(picked(&files, &hint(3, 2)).ends_with("S03E02v2.mkv"));
    assert!(picked(&files, &hint(3, 3)).ends_with("S03E03.mkv"));
}

#[test]
fn sufixo_v2_nao_confunde_episodio_vizinho() {
    let files = vec![
        file("Show - S01E12v2.mkv"),
        file("Show - S01E01.mkv"),
        file("Show - S01E02.mkv"),
    ];
    assert!(picked(&files, &hint(1, 1)).ends_with("S01E01.mkv"));
    assert!(picked(&files, &hint(1, 12)).ends_with("S01E12v2.mkv"));
}
