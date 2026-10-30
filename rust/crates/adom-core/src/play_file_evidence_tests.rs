use super::*;

fn file(path: &str, size: f64) -> DebridFile {
    DebridFile {
        path: path.to_string(),
        size,
    }
}

#[test]
fn dublado_dual_com_1080p_grava_audio_e_resolucao() {
    let files = [file("Filme.2020.1080p.WEB-DL.DUAL.5.1.mkv", 2.0e9)];
    let ev = play_file_evidence(&files).expect("dual positivo");
    assert_eq!(ev.audio, "Dual");
    assert!(!ev.en);
    assert_eq!(ev.quality, "1080p");
    assert_eq!(ev.name, "Filme.2020.1080p.WEB-DL.DUAL.5.1.mkv");
}

#[test]
fn cena_en_sem_audio_marca_en_e_resolucao() {
    let files = [file("Movie.2020.1080p.BluRay.x264-KILLERS.mkv", 2.0e9)];
    let ev = play_file_evidence(&files).expect("cena EN é prova negativa");
    assert_eq!(ev.audio, "");
    assert!(ev.en);
    assert_eq!(ev.quality, "1080p");
}

#[test]
fn cena_en_com_rotulo_pt_nao_marca_en() {
    // O rótulo PT ganha: `en` só vale quando não há áudio.
    let files = [file("Movie.2020.1080p.Dublado.x264-KILLERS.mkv", 2.0e9)];
    let ev = play_file_evidence(&files).expect("tem prova");
    assert_eq!(ev.audio, "Dublado");
    assert!(!ev.en);
}

#[test]
fn pack_multiobra_zera_resolucao_e_nome() {
    // Dois anos distintos no pack: o maior é outro filme, nada dele vale.
    let files = [
        file("Saga.Parte.1.2010.1080p.DUAL.mkv", 2.0e9),
        file("Saga.Parte.2.2016.720p.DUAL.mkv", 1.0e9),
    ];
    let ev = play_file_evidence(&files).expect("o dual do pack ainda é prova");
    assert_eq!(ev.audio, "Dual");
    assert_eq!(ev.quality, "");
    assert_eq!(ev.name, "");
}

#[test]
fn so_sample_ou_anuncio_nao_tem_video_de_conteudo() {
    let sample = [file("Movie.2020.1080p.sample.mkv", 1.0e8)];
    assert_eq!(play_file_evidence(&sample), None);
    let ad = [file("1XBET.COM.mkv", 1.0e8)];
    assert_eq!(play_file_evidence(&ad), None);
}

#[test]
fn sem_nada_positivo_retorna_none() {
    // Vídeo de conteúdo sem áudio, sem cena EN e sem resolução no nome.
    let files = [file("Some.Movie.mkv", 1.0e9)];
    assert_eq!(play_file_evidence(&files), None);
}

#[test]
fn nao_video_nao_conta() {
    let files = [file("Movie.2020.1080p.DUAL.srt", 1.0e5)];
    assert_eq!(play_file_evidence(&files), None);
}

#[test]
fn maior_arquivo_decide_a_resolucao() {
    let files = [
        file("Serie.S01E01.1080p.mkv", 1.0e8),
        file("Serie.S01E02.720p.mkv", 9.0e8),
    ];
    let ev = play_file_evidence(&files).expect("720p é o maior");
    assert_eq!(ev.quality, "720p");
    assert_eq!(ev.name, "Serie.S01E02.720p.mkv");
}

#[test]
fn empate_de_tamanho_fica_com_o_primeiro() {
    let files = [
        file("Serie.S01E01.1080p.mkv", 5.0e8),
        file("Serie.S01E02.720p.mkv", 5.0e8),
    ];
    let ev = play_file_evidence(&files).expect("prova");
    assert_eq!(ev.quality, "1080p");
}

#[test]
fn tamanho_nan_vira_zero_e_nao_ganha_do_maior() {
    let files = [
        file("Serie.S01E01.1080p.mkv", f64::NAN),
        file("Serie.S01E02.720p.mkv", 1.0),
    ];
    let ev = play_file_evidence(&files).expect("prova");
    assert_eq!(ev.quality, "720p");
}

#[test]
fn nome_trunca_em_80_caracteres_ascii() {
    let long = format!("Filme.1080p.{}.mkv", "x".repeat(120));
    let files = [file(&long, 1.0e9)];
    let ev = play_file_evidence(&files).expect("prova");
    assert_eq!(ev.name.chars().count(), 80);
    assert_eq!(ev.name, long[..80]);
}

#[test]
fn nome_trunca_em_unidades_utf16_sem_partir_par_astral() {
    // "Filme.1080p." são 12 unidades; 34 emojis de 2 unidades cada fecham 80.
    // O 35º não cabe inteiro e some, em vez de deixar um surrogate órfão.
    let prefix = "Filme.1080p.";
    let emojis = "\u{1F3AC}".repeat(40);
    let name = format!("{prefix}{emojis}.mkv");
    let files = [file(&name, 1.0e9)];
    let ev = play_file_evidence(&files).expect("prova");
    assert_eq!(ev.name, format!("{prefix}{}", "\u{1F3AC}".repeat(34)));
    let units: usize = ev.name.chars().map(char::len_utf16).sum();
    assert_eq!(units, 80);
}

#[test]
fn listas_injetadas_mudam_o_marcador_en() {
    let files = [file("Movie.2020.1080p.WEB.x264-FOO.mkv", 1.0e9)];
    assert_eq!(
        evidence_with(&files, &[], &["foo"]).map(|e| e.en),
        Some(true)
    );
    // Sem a lista, o mesmo arquivo perde a marca EN (a resolução continua).
    assert_eq!(evidence_with(&files, &[], &[]).map(|e| e.en), Some(false));
}
