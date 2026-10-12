//! Porte de `isHomeSource`, `preHomeReleaseContradicts` e `isNonFeature`
//! (`src/utils/non-feature-release.ts`).
//!
//! O corte antes do lançamento doméstico não lê config: o chamador passa
//! `cut_enabled` e `margin_ms`. No TS isso é `config.search.preHomeReleaseCut`
//! (default true) e `preHomeReleaseMarginMs` (default 48h).

use std::sync::OnceLock;

use regex::Regex;

use crate::br_origin::js_canon;

// `/i` sem `u`: o texto sobe por `js_canon` e o `\b` é ASCII (`(?-u:\b)`).
// Um acento não é palavra no JS, então "éweb" tem fronteira antes do W.
const CINEMA: &str =
    r"(?-u:\b)(?:HD[-. ]?)?(?:CAM(?:[-. ]?RIP)?|TS|TC|TELESYNC|TELECINE|PRE[-. ]?DVD)(?-u:\b)";
const HOME: &str = r"(?-u:\b)(?:WEB(?:[-. ]?(?:DL|RIP))?|BLU[-. ]?RAY|BD(?:RIP|REMUX)?|BRRIP|REMUX|HDTV|DVD(?:RIP|R|5|9)?)(?-u:\b)";
// Featurette fica de fora de propósito. O release "BluRay + Featurettes"
// traz o filme junto do extra; marcar featurette condenaria o filme. O
// regex do TS é só trailer/teaser/trilha (`trailers?`, `teasers?`,
// `soundtrack`, `OST`).
const NON_FEATURE: &str = r"(?-u:\b)(?:TRAILERS?|TEASERS?|SOUNDTRACK|OST)(?-u:\b)";

fn compiled(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("regex de non-feature compila"))
}

fn cinema_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compiled(&RE, CINEMA)
}

fn home_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compiled(&RE, HOME)
}

fn non_feature_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compiled(&RE, NON_FEATURE)
}

/// `_` vira espaço, como o `clean` do TS, e a caixa segue o `/i` sem `u`.
fn cleaned(text: &str) -> String {
    js_canon(&text.replace('_', " "))
}

/// O nome declara fonte doméstica (WEB/BluRay/HDTV/DVD) e não é gravação de
/// cinema. "TS-V2-WEB.DL" casa os dois: o TS é palavra, o WEB.DL também. O
/// cinema anula a fonte — o marcador de sala vence, e a release passa.
pub fn is_home_source(text: &str) -> bool {
    let t = cleaned(text);
    !cinema_re().is_match(&t) && home_re().is_match(&t)
}

/// Trailer, teaser ou trilha que o nome da obra não explica. Se o nome já
/// contém a palavra ("The Trailer Park"), não é extra: devolve false.
pub fn is_non_feature(texts: &[&str], names: &[&str]) -> bool {
    if names.iter().any(|n| non_feature_re().is_match(&cleaned(n))) {
        return false;
    }
    texts
        .iter()
        .any(|t| !t.is_empty() && non_feature_re().is_match(&cleaned(t)))
}

/// Fonte doméstica antes do 1º lançamento doméstico, com margem. `None` é
/// null/undefined; `0` é falsy no JS (`!homeReleaseAt`). NaN e infinito não
/// cabem em `i64` — o TS também recusa com `Number.isFinite`.
pub fn pre_home_release_contradicts(
    texts: &[&str],
    home_release_at: Option<i64>,
    now: i64,
    cut_enabled: bool,
    margin_ms: i64,
) -> bool {
    if !cut_enabled {
        return false;
    }
    let Some(at) = home_release_at.filter(|n| *n != 0) else {
        return false;
    };
    // `homeReleaseAt - now <= margin` em i128: não estoura i64 e, nestes
    // milissegundos, coincide com o número do JS.
    if (at as i128) - (now as i128) <= margin_ms as i128 {
        return false;
    }
    texts.iter().any(|t| !t.is_empty() && is_home_source(t))
}
