//! Prova de áudio no play da AllDebrid, no ponto do `assertDubbedFiles`.
//!
//! O rótulo do indexer não entra. A promessa vem do pedido; os caminhos dos
//! vídeos é que decidem. Sem promessa, o unlock segue. Não marca magnet,
//! não apaga torrent e não mexe na checagem.

use std::sync::OnceLock;

use adom_core::{dubbed_lie_verdict, is_site_ad, EpisodeContext, EpisodeEvidence, PlayHint};
use regex::Regex;

use super::Leaf;
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

/// `Err(DubLie)` antes do `/link/unlock`. `Ok` deixa o play abrir o link.
pub(super) fn reject_before_unlock(leaves: &[Leaf], hint: &PlayHint) -> Result<(), DebridError> {
    let promised = promised_dubbed(hint);
    if !promised {
        return Ok(());
    }
    let paths = content_paths(leaves);
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

/// A promessa viaja no pedido (`dubbed: true`). O seletor não lê este campo.
fn promised_dubbed(hint: &PlayHint) -> bool {
    hint.dubbed
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
fn content_paths(leaves: &[Leaf]) -> Vec<&str> {
    leaves
        .iter()
        .map(|leaf| leaf.path.as_str())
        .filter(|path| !path.is_empty() && is_video(path) && !is_sample(path) && !is_site_ad(path))
        .collect()
}

fn is_video(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".mkv", ".mp4", ".avi", ".mov", ".m4v", ".ts", ".webm"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

fn is_sample(path: &str) -> bool {
    sample_re().is_match(path)
}

fn sample_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(^|[^a-z])sample([^a-z]|$)").expect("amostra de vídeo"))
}
