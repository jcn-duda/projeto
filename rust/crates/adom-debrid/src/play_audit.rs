//! Prova de áudio no play: porte de `assertDubbedFiles` (`src/debrid/audio-audit.ts`).
//!
//! O adaptador já recebeu a lista de arquivos para resolver o play; só então
//! existe prova para confrontar a promessa `dubbed` da listagem. Sem promessa,
//! nada acontece. A decisão (marcador PT preserva, grupo EN condena) mora no
//! núcleo (`dubbed_lie_verdict`); aqui só os filtros de "vídeo de conteúdo" e a
//! tradução para o `DebridError::DubLie`.
//!
//! A ordem em cada adaptador é a do TS: o `pickFile` lança ANTES da auditoria
//! (NoVideo/EpisodePick vencem), e a auditoria roda mesmo quando a escolha é
//! vazia. O Real-Debrid é a exceção do TS: audita antes de refinar a escolha.

use adom_core::{
    dubbed_lie_verdict, is_sample, is_site_ad, is_video, DebridFile, EpisodeContext,
    EpisodeEvidence, PlayHint,
};

use crate::error::DebridError;

const DUB_MESSAGE: &str = "o torrent anunciado como dublado contém release em inglês";

/// Mesma lista default de `config.audioAudit.ptMarkers`.
const DEFAULT_PT: &[&str] = &[
    "dublado",
    "dublada",
    "dublagem",
    "dubbed",
    "dual audio",
    "dual",
    "pt br",
    "ptbr",
    "portugues",
    "portuguese",
    "nacional",
    "fleg",
];

/// Mesma lista default de `config.audioAudit.enGroups`. Plataforma (amzn,
/// dsnp) não entra: só grupo de cena prova inglês.
const DEFAULT_EN: &[&str] = &[
    "rarbg", "killers", "ettv", "afm72", "tovar", "evo", "megusta", "galaxyrg", "glxrc", "yts",
    "fgt", "ntb", "roarb", "oxy", "bae", "drs", "huzzah", "tgx", "ethel", "yify",
];

/// `Err(DubLie)` quando a promessa não se sustenta. `Ok` deixa o play seguir.
pub(crate) fn assert_dubbed(files: &[DebridFile], hint: &PlayHint) -> Result<(), DebridError> {
    if !hint.dubbed {
        return Ok(());
    }
    let paths = content_paths(files);
    let owned_pt = marker_list("AUDIO_AUDIT_PT_MARKERS", DEFAULT_PT);
    let owned_en = marker_list("AUDIO_AUDIT_EN_GROUPS", DEFAULT_EN);
    let pt: Vec<&str> = owned_pt.iter().map(String::as_str).collect();
    let en: Vec<&str> = owned_en.iter().map(String::as_str).collect();
    let verdict = dubbed_lie_verdict(&paths, true, audit_enabled(), &pt, &en);
    if !verdict.lie {
        return Ok(());
    }
    let Some(sample) = paths.first().copied() else {
        return Ok(());
    };
    let Some(group) = verdict.matched_group else {
        return Ok(());
    };
    // O `DubLie` compartilha a prova do seletor de episódio, que não tem
    // `matchedGroup`. O grupo vai em `context.samples`; o caminho, em
    // `evidence.sample`; a contagem, em `context.video_count`.
    Err(DebridError::DubLie {
        message: DUB_MESSAGE.to_string(),
        evidence: Some(Box::new(EpisodeEvidence {
            wanted_season: 0,
            wanted_episode: 0,
            declared_seasons: Vec::new(),
            declared_episodes: Vec::new(),
            sample: Some(sample.to_string()),
        })),
        context: Some(Box::new(EpisodeContext {
            video_count: i64::try_from(verdict.video_count).unwrap_or(i64::MAX),
            samples: vec![group],
        })),
    })
}

/// `String(process.env.AUDIO_AUDIT || 'true') === 'true'`.
fn audit_enabled() -> bool {
    match std::env::var("AUDIO_AUDIT") {
        Ok(value) if !value.is_empty() => value == "true",
        _ => true,
    }
}

/// Env vazia cai no default; env só com vírgula vira lista vazia.
fn marker_list(key: &str, default: &[&str]) -> Vec<String> {
    match std::env::var(key) {
        Ok(value) if !value.is_empty() => value
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
            .collect(),
        _ => default.iter().copied().map(str::to_string).collect(),
    }
}

/// Vídeo de conteúdo: extensão de vídeo, sem sample e sem propaganda do site.
fn content_paths(files: &[DebridFile]) -> Vec<&str> {
    files
        .iter()
        .map(|file| file.path.as_str())
        .filter(|path| !path.is_empty() && is_video(path) && !is_sample(path) && !is_site_ad(path))
        .collect()
}

#[cfg(test)]
mod tests {
    use adom_core::{DebridFile, PlayHint};

    use super::*;

    fn file(path: &str, size: f64) -> DebridFile {
        DebridFile {
            path: path.into(),
            size,
        }
    }

    fn dubbed() -> PlayHint {
        PlayHint {
            dubbed: true,
            ..PlayHint::default()
        }
    }

    #[test]
    fn sem_promessa_nunca_condena() {
        let files = [file("Filme.1080p.WEB-DL.x264-RARBG.mkv", 1.0)];
        assert!(assert_dubbed(&files, &PlayHint::default()).is_ok());
    }

    #[test]
    fn grupo_en_sem_marcador_pt_vira_dub_lie() {
        let files = [file("Filme.1080p.WEB-DL.x264-RARBG.mkv", 1.0)];
        let err = assert_dubbed(&files, &dubbed()).unwrap_err();
        assert_eq!(err.kind(), "dub_lie");
        let (evidence, context) = err.pick_parts();
        assert_eq!(
            evidence.and_then(|item| item.sample.as_deref()),
            Some("Filme.1080p.WEB-DL.x264-RARBG.mkv")
        );
        assert_eq!(
            context.map(|item| item.samples.clone()),
            Some(vec!["rarbg".into()])
        );
    }

    #[test]
    fn marcador_pt_preserva() {
        let files = [file("Filme.1080p.Dublado.x264-RARBG.mkv", 1.0)];
        assert!(assert_dubbed(&files, &dubbed()).is_ok());
    }

    #[test]
    fn sample_e_propaganda_nao_contam_como_video() {
        let files = [
            file("sample.mkv", 1.0),
            file("1XBET.COM_promo.mkv", 1.0),
            file("Filme.1080p.Dublado.mkv", 10.0),
        ];
        assert!(assert_dubbed(&files, &dubbed()).is_ok());
    }

    #[test]
    fn lista_vazia_nao_condena() {
        assert!(assert_dubbed(&[], &dubbed()).is_ok());
    }
}
