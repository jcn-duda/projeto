//! Régua de `recordFileEvidence` (`src/debrid/audio-audit.ts`): o que os
//! ARQUIVOS do torrent provam no play — rótulo de áudio, marca de cena EN,
//! resolução e nome do maior vídeo. Pura: a lista já chegou do debrid; quem
//! grava o veredito no índice é o gravador nativo, fora daqui.
//!
//! Só existe prova POSITIVA. Ausência de marca não vira veredito: `en` exige
//! grupo de cena reconhecido, não "faltou PT".

use crate::{
    audio_from_title, base_name, is_sample, is_site_ad, is_video, looks_multi_work_files,
    quality_from_title, strong_en_scene_mark, DebridFile, UNKNOWN_QUALITY,
};

/// Prova do que os arquivos do torrent mostram. Campos vazios/falsos = sem prova
/// naquela dimensão (espelho de `{a, e, q, n}` gravado pelo `markFileEvidence`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayFileEvidence {
    /// Rótulo de áudio (`Dublado`/`Dual`/…), ou `""`.
    pub audio: String,
    /// Release de cena EN reconhecida e sem rótulo PT.
    pub en: bool,
    /// Resolução do maior vídeo, ou `""` (sem resolução ou pack multiobra).
    pub quality: String,
    /// Basename do maior vídeo truncado em 80 unidades UTF-16, ou `""` (pack multiobra).
    pub name: String,
}

/// `DEFAULT_PT` de `config.audioAudit.ptMarkers` (`src/config/audit.ts`). A
/// assinatura não recebe listas: o TS as lê do env (`AUDIO_AUDIT_PT_MARKERS`),
/// e aqui ficam os defaults. Mudou a lista do TS, mude aqui também.
const DEFAULT_PT_MARKERS: &[&str] = &[
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

/// `DEFAULT_EN` de `config.audioAudit.enGroups` (mesma fonte do TS acima).
const DEFAULT_EN_GROUPS: &[&str] = &[
    "rarbg", "killers", "ettv", "afm72", "tovar", "evo", "megusta", "galaxyrg", "glxrc", "yts",
    "fgt", "ntb", "roarb", "oxy", "bae", "drs", "huzzah", "tgx", "ethel", "yify",
];

/// Limite de `slice(0, 80)` do TS, em unidades UTF-16 (ver `truncate_utf16`).
const NAME_MAX_UNITS: usize = 80;

/// Veredito de prova dos arquivos do torrent no play, com as listas default.
/// `None` quando nenhuma dimensão é positiva (nada a gravar).
pub fn play_file_evidence(files: &[DebridFile]) -> Option<PlayFileEvidence> {
    evidence_with(files, DEFAULT_PT_MARKERS, DEFAULT_EN_GROUPS)
}

/// Mesma régua com as listas de marcadores injetadas (testes e quem já tem a
/// config do operador em mãos). Não é API pública: a fronteira só expõe o default.
pub(crate) fn evidence_with(
    files: &[DebridFile],
    pt_markers: &[&str],
    en_groups: &[&str],
) -> Option<PlayFileEvidence> {
    // `contentPaths`: vídeo, sem sample, sem propaganda. Não exige size > 0:
    // NaN vira 0 (`Number(x) || 0`) e segue na lista, como no TS.
    let videos: Vec<DebridFile> = files
        .iter()
        .filter(|f| is_video(&f.path) && !is_sample(&f.path) && !is_site_ad(&f.path))
        .map(|f| DebridFile {
            path: f.path.clone(),
            size: if f.size.is_nan() { 0.0 } else { f.size },
        })
        .collect();
    let first = videos.first()?;

    let names: Vec<String> = videos.iter().map(|v| base_name(&v.path)).collect();
    // A resolução vem do MAIOR vídeo (comparação estrita: empate fica com o
    // primeiro, como o `reduce` do TS). Num pack é o que representa a release.
    let mut maior = first;
    for video in &videos[1..] {
        if video.size > maior.size {
            maior = video;
        }
    }
    // Coleção de filmes: o maior é OUTRO filme, então resolução e nome dele não
    // valem para a release. Nome sem resolução também não é prova.
    let multi_work = looks_multi_work_files(&videos);
    let quality = if multi_work {
        String::new()
    } else {
        let maior_name = base_name(&maior.path);
        let q = quality_from_title(&maior_name);
        if q == UNKNOWN_QUALITY {
            String::new()
        } else {
            q.to_string()
        }
    };
    // Rótulo de áudio do primeiro nome que tiver um (ordem dos arquivos, como o
    // `.map().find(Boolean)` do TS).
    let audio = names
        .iter()
        .map(|name| audio_from_title(name))
        .find(|label| !label.is_empty())
        .unwrap_or("")
        .to_string();
    // Cena EN reconhecida é prova NEGATIVA de dublado, mas só conta sem rótulo PT.
    let en = audio.is_empty()
        && names
            .iter()
            .any(|name| strong_en_scene_mark(name, pt_markers, en_groups).is_some());
    if audio.is_empty() && !en && quality.is_empty() {
        return None;
    }
    let name = if multi_work {
        String::new()
    } else {
        truncate_utf16(&base_name(&maior.path), NAME_MAX_UNITS)
    };
    Some(PlayFileEvidence {
        audio,
        en,
        quality,
        name,
    })
}

/// `s.slice(0, max)` do JS, medido em unidades UTF-16. Um par astral (emoji)
/// que cairia cortado é descartado inteiro: o JS deixaria um surrogate órfão,
/// que o `String` do napi não carrega (viraria U+FFFD). Diferença só nesse caso.
fn truncate_utf16(text: &str, max: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for ch in text.chars() {
        let len = ch.len_utf16();
        if units + len > max {
            break;
        }
        units += len;
        out.push(ch);
    }
    out
}

#[cfg(test)]
#[path = "play_file_evidence_tests.rs"]
mod tests;
