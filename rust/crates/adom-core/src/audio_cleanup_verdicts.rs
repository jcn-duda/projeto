//! Porte das guardas de dublagem pelo PATH REAL do arquivo de
//! `src/utils/audio-cleanup.ts`: `hasPtAudioMark`, `strongEnSceneMark`,
//! `dubbedLieVerdict`, `dnContradictsDubClaim` e `enSceneMirrorTitle`.
//!
//! `hasPtAudioMark` reusa a guarda de idioma de `audio_lang`
//! (`foreign_dub_guard_hit`) — a MESMA que desmente o `DUB` genérico de
//! `generic_dub_proves_pt` — para não duplicar a lista de idiomas. Marcador
//! genérico (`dub`/`dubbed`/`dual`/`dual audio`) não prova PT quando o texto
//! nomeia idioma estrangeiro, está em cirílico ou carrega assinatura
//! transliterada; marcador explícito (`dublado`, `pt br`…) segue valendo.
//!
//! `strongEnSceneMark` reusa `normalize_title` e recebe os grupos de cena EN
//! por parâmetro (o TS lê `config.audioAudit.enGroups`). `enSceneMirrorTitle`
//! reusa `has_pt_signs` (`br_origin`).
//!
//! As duas listas de config (`ptMarkers`/`enGroups`) e o `enabled` entram como
//! argumentos, como em `matches_br_title` (que recebe `cut_tail`): função pura,
//! sem ler `config.*`.
//!
//! Paridade com o JS: `/\bREMUX\b/i` usa `(?-u:\b)` (fronteira ASCII do JS) e
//! `(?i:REMUX)`; `GENERIC_DUB_MARKER_RE` é ancorado com `^…$`.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::audio_lang::foreign_dub_guard_hit;
use crate::br_origin::has_pt_signs;
use crate::title_normalization::normalize_title;

/// `GENERIC_DUB_MARKER_RE`: só um marcador que normaliza para exatamente
/// `dub`/`dubbed`/`dual`/`dual audio` sofre a guarda de idioma estrangeiro.
fn generic_dub_marker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:dub(?:bed)?|dual(?: audio)?)$")
            .expect("marcador genérico de dublagem compila")
    })
}

/// `/\bREMUX\b/i` — REMUX copia todas as faixas do disco, que pode ter PT.
fn remux_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?-u:\b)(?i:REMUX)(?-u:\b)").expect("REMUX compila"))
}

/// Tokens normalizados e não vazios do path, como o `Set` do TS.
fn audio_tokens(path: &str) -> HashSet<String> {
    normalize_title(path)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `hasPtAudioMark`: marcador de áudio PT no path real do arquivo. Marcador
/// genérico de dublagem não prova PT quando o path nomeia idioma estrangeiro,
/// está em cirílico, carrega assinatura do rutracker ou o token `LAT` — a
/// mesma guarda de `generic_dub_proves_pt`. Marcador explícito segue valendo.
pub fn has_pt_audio_mark(path: &str, pt_markers: &[&str]) -> bool {
    let normalized_path = normalize_title(path);
    let tokens: Vec<&str> = normalized_path
        .split(' ')
        .filter(|t| !t.is_empty())
        .collect();
    let joined = format!(" {} ", tokens.join(" "));
    let has_foreign = foreign_dub_guard_hit(path);
    pt_markers.iter().any(|marker| {
        let normalized = normalize_title(marker);
        if normalized.is_empty() {
            return false;
        }
        if has_foreign && generic_dub_marker_re().is_match(&normalized) {
            return false;
        }
        joined.contains(&format!(" {normalized} "))
    })
}

/// `strongEnSceneMark`: primeiro grupo/canal de cena EN forte presente no
/// path, na ordem de `en_groups`, ou `None`. Nome sem marca continua ambíguo e
/// passa.
pub fn strong_en_scene_mark<'a>(
    path: &str,
    pt_markers: &[&str],
    en_groups: &[&'a str],
) -> Option<&'a str> {
    if has_pt_audio_mark(path, pt_markers) {
        return None;
    }
    let tokens = audio_tokens(path);
    en_groups
        .iter()
        .copied()
        .find(|group| tokens.contains(&normalize_title(group)))
}

/// Veredito de `dubbedLieVerdict`: mentira só quando TODOS os vídeos
/// contradizem a promessa PT com um sinal EN forte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DubbedLieVerdict {
    pub lie: bool,
    pub matched_group: Option<String>,
    pub video_count: usize,
}

/// `dubbedLieVerdict`: um único marcador PT preserva o item — falso negativo é
/// pior. `enabled` é o `config.audioAudit.enabled` do chamador.
pub fn dubbed_lie_verdict(
    video_paths: &[&str],
    promised_dubbed: bool,
    enabled: bool,
    pt_markers: &[&str],
    en_groups: &[&str],
) -> DubbedLieVerdict {
    // O TS roda `videoPaths.map(String).filter(Boolean)` e usa o length FILTRADO
    // em TODA saída, inclusive no portão de lista vazia: path vazio não conta
    // como vídeo.
    let paths: Vec<&str> = video_paths
        .iter()
        .copied()
        .filter(|p| !p.is_empty())
        .collect();
    let video_count = paths.len();
    if !enabled || !promised_dubbed || video_count == 0 {
        return DubbedLieVerdict {
            lie: false,
            matched_group: None,
            video_count,
        };
    }
    if paths.iter().any(|path| has_pt_audio_mark(path, pt_markers)) {
        return DubbedLieVerdict {
            lie: false,
            matched_group: None,
            video_count,
        };
    }
    match paths
        .iter()
        .find_map(|path| strong_en_scene_mark(path, pt_markers, en_groups))
    {
        Some(group) => DubbedLieVerdict {
            lie: true,
            matched_group: Some(group.to_string()),
            video_count,
        },
        None => DubbedLieVerdict {
            lie: false,
            matched_group: None,
            video_count,
        },
    }
}

/// `dnContradictsDubClaim`: o `dn=` do magnet contradiz a promessa de dublado
/// do post já na listagem. REMUX fica de fora; só tira a prioridade, nunca
/// condena.
pub fn dn_contradicts_dub_claim(
    dn: &str,
    enabled: bool,
    pt_markers: &[&str],
    en_groups: &[&str],
) -> bool {
    if !enabled || dn.is_empty() {
        return false;
    }
    if remux_re().is_match(dn) {
        return false;
    }
    strong_en_scene_mark(dn, pt_markers, en_groups).is_some()
}

/// `enSceneMirrorTitle`: título de post BR que é o nome de cena EN intacto.
/// Qualquer sinal PT (acento, vocabulário, "filme(s)", marca de site) preserva
/// o BR.
pub fn en_scene_mirror_title(title: &str, pt_markers: &[&str], en_groups: &[&str]) -> bool {
    if title.is_empty() || has_pt_signs(title) {
        return false;
    }
    strong_en_scene_mark(title, pt_markers, en_groups).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PT: &[&str] = &["dublado", "dubbed", "dual audio", "dual", "pt br"];
    const EN: &[&str] = &["rarbg", "killers", "ettv", "yts"];

    #[test]
    fn marcador_generico_cede_a_idioma_estrangeiro() {
        // Evidência TS: DUBBED + HINDI não prova PT; DUBLADO + HINDI prova.
        assert!(!has_pt_audio_mark("Movie.HINDI.DUBBED.mkv", PT));
        assert!(has_pt_audio_mark("Movie.HINDI.Dublado.mkv", PT));
    }

    #[test]
    fn path_com_pt_marker_suprime_o_grupo_en() {
        assert_eq!(
            strong_en_scene_mark("Movie.1080p.WEB-DL.x264-KILLERS.mkv", PT, EN),
            Some("killers")
        );
        assert_eq!(
            strong_en_scene_mark("Movie.Dublado.KILLERS.mkv", PT, EN),
            None
        );
    }

    #[test]
    fn remux_nao_contradiz_o_dn() {
        assert!(!dn_contradicts_dub_claim(
            "Movie.REMUX-KILLERS",
            true,
            PT,
            EN
        ));
        assert!(dn_contradicts_dub_claim(
            "Movie.1080p-KILLERS",
            true,
            PT,
            EN
        ));
    }

    #[test]
    fn um_unico_marcador_pt_preserva_o_item() {
        let r = dubbed_lie_verdict(
            &["Movie.KILLERS.mkv", "Movie.Dublado.mkv"],
            true,
            true,
            PT,
            EN,
        );
        assert!(!r.lie);
        assert_eq!(r.video_count, 2);
    }
}
