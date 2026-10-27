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
use crate::br_origin::{br_origin_mark, has_pt_signs};
use crate::pt_audio_guards::explicit_pt_audio;
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

/// Narração/dublagem no padrão dos trackers russos: `MVO`/`AVO`/`DVO` soltos e
/// em MAIÚSCULAS — "A.Avo.2021" (Avó sem acento) é título PT, não sigla.
fn ru_voice_over_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[^\p{L}\p{N}])(?:MVO|AVO|DVO)(?:[^\p{L}\p{N}]|$)")
            .expect("voice-over russo compila")
    })
}

/// `Dub` só na COMBINAÇÃO de faixas russa (`Dub + MVO`, `+ Dub`) ou logo após
/// o bloco de metadados (`[2009, HDRip] Dub`): o "Dub" solto de site BR
/// (`Filme.DUB.mkv`, `720p Dub`, `1ª Temporada Dub (2026)`) é abreviação de
/// dublado e não pode cair aqui.
fn ru_dub_combo_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\+\s*dub(?:[^\p{L}\p{N}]|$)|(?:^|[^\p{L}\p{N}])dub\s*\+|\]\s*dub(?:[^\p{L}\p{N}]|$)",
        )
            .expect("combinação Dub compila")
    })
}

/// `Sub Rus` / `Sub (Rus, Eng)`.
fn ru_sub_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:^|[^\p{L}\p{N}])sub\s*\(?\s*rus(?:[^\p{L}\p{N}]|$)")
            .expect("Sub Rus compila")
    })
}

/// `.ANO.D.`: o `D` maiúsculo logo após o ano é a sigla de dublagem dos
/// trackers russos (`The.Cycle.2026.D.WEB-DL.1080p`). Sensível a caixa e
/// preso ao ano: uma letra solta em outro lugar não prova nada.
fn ru_year_d_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?:^|[ ._\-\[(])(?:19|20)[0-9]{2}[ ._\-]D[ ._\-]").expect("ano.D compila")
    })
}

/// `dn=` de release de tracker russo: cirílico, `MVO`/`AVO`/`DVO`, a
/// combinação `Dub +`, `Sub Rus` ou `.ANO.D.`. Agregador BR republica esse
/// magnet num post "LEGENDADO" (The Cycle 2026, Apache, 2026-10-26) e o flag
/// do indexer dava BR a um arquivo sem nada em PT. Marca PT explícita ou
/// qualquer sinal de origem BR no `dn` (acento, vocabulário, marca de site)
/// preserva — falso negativo de BR custa mais que um rótulo a mais.
pub fn russian_dub_dn(dn: &str) -> bool {
    if dn.is_empty() || explicit_pt_audio(dn) || br_origin_mark(dn) {
        return false;
    }
    dn.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c))
        || ru_voice_over_re().is_match(dn)
        || ru_dub_combo_re().is_match(dn)
        || ru_sub_re().is_match(dn)
        || ru_year_d_re().is_match(dn)
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

    #[test]
    fn dn_de_tracker_russo_tem_marca_de_dublagem() {
        // Caso real: Apache/Comando republicaram este magnet num post LEGENDADO.
        assert!(russian_dub_dn("The.Cycle.2026.D.WEB-DL.1O8Op.mkv"));
        assert!(russian_dub_dn("The.Cycle.2026.D.WEB-DLRip.avi"));
        assert!(russian_dub_dn(
            "Звездный путь / Star Trek [2009, США, HDRip] Dub"
        ));
        assert!(russian_dub_dn(
            "The Cycle [2026, UK, WEB-DL 720p] MVO (HDRezka Studio) + Original Eng"
        ));
        assert!(russian_dub_dn("Movie [2015, BDRip] Dub + AVO (Zhivov)"));
        assert!(russian_dub_dn("Movie [2015, BDRip] Original + Dub"));
        assert!(russian_dub_dn("Movie [1980, BDRip] [Theatrical Cut] Dub"));
        assert!(russian_dub_dn(
            "The Cycle [2026, WEB-DLRip] Sub (Rus, Eng) + Original Eng"
        ));
        assert!(russian_dub_dn("Movie 2020 BDRip DVO Sub Rus"));
    }

    #[test]
    fn dn_sem_marca_russa_nao_e_vetado() {
        // DUB solto é abreviação de dublado em site BR, não sigla russa.
        assert!(!russian_dub_dn("Filme.2024.1080p.DUB.mkv"));
        assert!(!russian_dub_dn("Filme [1080p WEB-DL DUB]"));
        // D fora do ano, ano sem D e D minúsculo não provam nada.
        assert!(!russian_dub_dn("Dune.Part.Two.2024.1080p.WEB-DL"));
        assert!(!russian_dub_dn("The.D.Train.2015.1080p.BluRay"));
        assert!(!russian_dub_dn("Movie.2024.d.WEB-DL"));
        assert!(!russian_dub_dn(
            "The Cycle (2026) [1080p] [WEBRip] [5.1] [YTS]"
        ));
        // Palavras que contêm as siglas não casam.
        assert!(!russian_dub_dn("Dubai.Bling.S01.1080p"));
        assert!(!russian_dub_dn("Havoc.2025.1080p.WEB-DL"));
        assert!(!russian_dub_dn("Subrosa.2024.Russian.Doll.1080p"));
        assert!(!russian_dub_dn(""));
    }

    #[test]
    fn dn_de_site_br_medido_em_producao_segue_br() {
        // dn reais de releases BR DUBLADAS (magnets.db da VPS, 2026-10-26) que
        // a primeira versão da régua vetava.
        assert!(!russian_dub_dn("A.Avo.2021.1080p.BluRay.x264.DUAL.2.0"));
        assert!(!russian_dub_dn(
            "Eu.e.Meu.Avo.Nihonjin.2025.1080p.WEB-DL.x264.DUAL.2.0"
        ));
        assert!(!russian_dub_dn("Cidade de Sangue 1ª Temporada Dub (2026)"));
        assert!(!russian_dub_dn(
            "COMANDO.TO - Eurotrip Passaporte para a Confusão 2004 720p DUB"
        ));
        assert!(!russian_dub_dn(
            "O Natal Maluco de Harold e Kumar (2011) 3D 1080p Dub"
        ));
        assert!(!russian_dub_dn(
            "Corra que a Pol&iacute;cia Vem A&iacute; 2 (1991) BDrip 720p Dub"
        ));
    }

    #[test]
    fn marca_pt_explicita_preserva_mesmo_com_sigla_russa() {
        assert!(!russian_dub_dn("Filme.2024.D.WEB-DL.Dublado.mkv"));
        assert!(!russian_dub_dn("Filme [2024] Dub + MVO + PT-BR"));
    }
}
