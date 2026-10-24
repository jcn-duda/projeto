//! Marcadores de série/filme usados pelo corte de `filterRelevantRaw`
//! (`src/utils/release-filters.ts`): rótulo "a série"/"minissérie", anos e
//! resoluções que o TS limpa antes de ler a temporada, e o veto de release de
//! FILME homônimo de uma série (`seriesReleaseLooksLikeMovie`).
//!
//! Os regex do TS usam `\b` ASCII e `/i` sem `u`. Aqui isso vira lookaround
//! explícito (`(?<![A-Za-z0-9_])`), classes de caixa explícitas (`[eEéÉ]`) e o
//! espaço do JS (`JS_SPACE`), para que a paridade não dependa de tabelas
//! Unicode do crate `regex`.

use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use crate::matching_decisions::first_year_in;
use crate::matching_vocabulary::JS_SPACE;
use crate::{parse_title_season_episode, ParsedSeasonEpisode};

/// `\b` do JS antes/depois de um caractere de palavra ASCII.
const WORD_BEFORE: &str = "(?<![A-Za-z0-9_])";
const WORD_AFTER: &str = "(?![A-Za-z0-9_])";

/// `/(?:19|20)\d{2}/g` (sem fronteiras, como o `replace` do TS).
fn year_any_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:19|20)[0-9]{2}").expect("regex de ano compila"))
}

/// `/\d{3,4}x\d{3,4}/gi`: resolução, que não é ano nem temporada.
fn resolution_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[0-9]{3,4}[xX][0-9]{3,4}").expect("regex de resolução compila"))
}

/// `/(?<!\d)(?:19|20)\d{2}(?!\d)/g`: ano isolado de um número maior.
fn standalone_year_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new(r"(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])")
            .expect("regex de ano isolado compila")
    })
}

/// `SERIES_LABEL_RE` do TS: `\b(?:a|the)\s+s[eé]rie\b|\bminiss[eé]rie\b`, com `/i`.
/// O grupo externo `(?:…)` é devolvido inteiro para ser reusado nas alternativas.
fn series_label_pattern() -> String {
    [
        "(?:",
        WORD_BEFORE,
        "(?:[aA]|[tT][hH][eE])",
        JS_SPACE,
        "+[sS][eEéÉ][rR][iI][eEéÉ]",
        WORD_AFTER,
        "|",
        WORD_BEFORE,
        "[mM][iI][nN][iI][sS][sS][eEéÉ][rR][iI][eEéÉ]",
        WORD_AFTER,
        ")",
    ]
    .concat()
}

fn series_label_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new(&series_label_pattern()).expect("regex de rótulo de série compila")
    })
}

/// Rótulo de série mais `\bs[eé]ries?\b` e `\btemporadas?\b` (veto de
/// `seriesReleaseLooksLikeMovie`), com `/i`.
fn series_or_season_label_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        let pat = [
            series_label_pattern().as_str(),
            "|",
            WORD_BEFORE,
            "[sS][eEéÉ][rR][iI][eEéÉ][sS]?",
            WORD_AFTER,
            "|",
            WORD_BEFORE,
            "[tT][eE][mM][pP][oO][rR][aA][dD][aA][sS]?",
            WORD_AFTER,
        ]
        .concat();
        FancyRegex::new(&format!("(?:{pat})")).expect("regex de rótulo amplo compila")
    })
}

/// `replace(/(?:19|20)\d{2}/g, ' ')`.
pub(super) fn years_stripped(text: &str) -> String {
    year_any_re().replace_all(text, " ").into_owned()
}

/// `replace(/\d{3,4}x\d{3,4}/gi, ' ')`.
pub(super) fn resolutions_stripped(text: &str) -> String {
    resolution_re().replace_all(text, " ").into_owned()
}

/// Anos isolados, sem repetição, na ordem em que aparecem (o `Set` do JS).
pub(super) fn standalone_years(text: &str) -> Vec<i64> {
    let mut years: Vec<i64> = Vec::new();
    for found in standalone_year_re().find_iter(text) {
        let found = found.expect("regex de ano isolado executa");
        let year: i64 = found.as_str().parse().expect("ano de quatro dígitos");
        if !years.contains(&year) {
            years.push(year);
        }
    }
    years
}

/// `SERIES_LABEL_RE.test(text)`: "a série", "the série" ou "minissérie".
pub(super) fn series_label(text: &str) -> bool {
    series_label_re()
        .is_match(text)
        .expect("regex de rótulo executa")
}

/// Temporada, episódio ou pack ("Temporada Completa"): o `hasSeasonMarker` do TS.
/// `complete` fica de fora de propósito (série inteira, não marcador de temporada).
fn has_season_marker(parsed: &ParsedSeasonEpisode) -> bool {
    !parsed.seasons.is_empty() || !parsed.episodes.is_empty() || parsed.season_pack
}

/// Veto de FILME: a release traz marcador de temporada/episódio/pack ou rótulo
/// de série, e o nome procurado não tem o mesmo marcador (exceção do TS para
/// "S1m0ne" e "A Series of Unfortunate Events"). `display` é `${title} ${dn}`.
/// Devolve `true` para REJEITAR.
pub(super) fn movie_carries_series_marker(display: &str, names: &[String]) -> bool {
    let without_years = resolutions_stripped(&years_stripped(display));
    let has_marker = has_season_marker(&parse_title_season_episode(&without_years));
    if !(has_marker || series_label(display)) {
        return false;
    }
    let name_parsed = names.iter().any(|name| {
        let cleaned = resolutions_stripped(&years_stripped(name));
        has_season_marker(&parse_title_season_episode(&cleaned)) || series_label(name)
    });
    !name_parsed
}

/// `seriesReleaseLooksLikeMovie`: release SEM pista de série que declara UM
/// único ano depois da estreia (+1) é filme homônimo. Conservador: sem ano,
/// com o ano da estreia ou com faixa de anos a release fica. `dn` é o
/// `magnetDisplayName` do item. Devolve `true` para REJEITAR.
pub(super) fn series_release_looks_like_movie(title: &str, dn: &str, year: &str) -> bool {
    let premiere = first_year_in(year);
    if premiere == 0 {
        return false;
    }
    let display = resolutions_stripped(&format!("{title} {dn}"));
    let years = standalone_years(&display);
    if years.len() != 1 || years[0] <= premiere + 1 {
        return false;
    }
    if series_or_season_label_re()
        .is_match(&display)
        .expect("regex de rótulo amplo executa")
    {
        return false;
    }
    let parsed = parse_title_season_episode(&years_stripped(&display));
    !(has_season_marker(&parsed) || parsed.complete)
}
