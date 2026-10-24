//! Veredito do magnet na seleção instantânea: origem BR (fallbackIsBr sem o
//! brSource) e o dubRank que fura o teto com o dublado do acervo.

use crate::audio_lang::names_foreign_dub_language;
use crate::audio_presentation::{audio_from_title, looks_pt_br};
use crate::br_origin::has_pt_signs;

use super::InstantMagnet;

/// `\b(?:LEGENDAD[OA]|DUBLAD[OA]|NACIONAL)\b` do TS, sobre tokens ASCII (o `\b`
/// do JS também é ASCII): "LEGENDADO" prova origem, não idioma estrangeiro.
fn pt_label(text: &str) -> bool {
    const LABELS: [&str; 5] = ["LEGENDADO", "LEGENDADA", "DUBLADO", "DUBLADA", "NACIONAL"];
    let mut token = String::new();
    let check = |token: &mut String| -> bool {
        let upper = token.to_ascii_uppercase();
        let hit = LABELS.contains(&upper.as_str());
        token.clear();
        hit
    };
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            token.push(ch);
        } else if check(&mut token) {
            return true;
        }
    }
    check(&mut token)
}

/// `fallbackIsBr` SEM `brSource` (a via instantânea não decide a fonte BR): o
/// `is_br` gravado só SOBE e pode ser de antes da guarda — idioma estrangeiro no
/// título sem NENHUM sinal PT desmente o rótulo velho.
pub(super) fn instant_is_br(magnet: &InstantMagnet) -> bool {
    if !magnet.is_br {
        return false;
    }
    let title = magnet.title.as_str();
    !(names_foreign_dub_language(title)
        && !has_pt_signs(title)
        && !looks_pt_br(title)
        && !pt_label(title))
}

/// `dubRank`: quem prefere dublado recebe o dublado do acervo antes do teto.
pub(super) fn dub_rank(magnet: &InstantMagnet, prefer_dubbed: bool) -> i64 {
    if !prefer_dubbed {
        return 0;
    }
    let audio = audio_from_title(&magnet.title);
    let dubbed = looks_pt_br(&magnet.title)
        || (magnet.is_br && matches!(audio, "Dublado" | "Dual" | "Nacional"));
    if dubbed {
        0
    } else {
        1
    }
}
