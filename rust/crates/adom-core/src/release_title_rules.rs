//! Porte das funções puras de `src/utils/release-title-rules.ts` que não leem
//! `config` nem dependem de módulo ainda não portado: `matchesTitleStructure`,
//! `shortNameIdentity` e `matchesShortNameIdentity`.
//!
//! Ficam de fora, de propósito, `matchesBrTitle`, `matchesEpisodeWorkIdentity`
//! e `matchesGlobalSeriesNoMarker`: os três leem
//! `config.search.titlePrecisionTailCut` (corte de cauda do `titlePrecision`),
//! e o primeiro ainda depende de `matchesName`, que não foi portado. Também
//! fica de fora `TITLE_PRECISION_MIN`, que é constante derivada de config.
//!
//! As regex do TS são traduzidas com as classes de espaço do JS (`\s`), não
//! com o `\s` do crate `regex`, que é Unicode White_Space e não é o mesmo
//! conjunto (inclui U+0085 e não inclui U+FEFF).

use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use crate::franchise::{
    franchise_base_contradicts, is_multi_work_collection, name_coverage_tokens,
};
use crate::matching_decisions::{first_significant_token, first_year_in, year_contradicts};
use crate::matching_tokens::{
    extract_sequence_markers, first_unmarked_token, first_work_token, is_non_latin_token,
    is_non_naming_token, is_year_token,
};
use crate::matching_vocabulary::title_tokens;

/// `\s` do JS (WhiteSpace + LineTerminator), escrito como classe do crate
/// `regex`. Substitui `{WS}` nos padrões abaixo.
const JS_WS: &str = "\\t\\n\\x{0B}\\x{0C}\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}";

/// `LEADING_RELEASE_TAG_RE`: etiqueta de uploader/site no começo do título.
/// O `/i` do TS vira classes explícitas e `(?i:www)` (sem `(?i)` global, para
/// o Kelvin sign U+212A não casar `[a-z]`, como no JS sem flag `u`).
const LEADING_TAG_PATTERN: &str = "^(?:[{WS}]*(?:\\[[^\\]]{1,40}\\]|\\([^)]{1,40}\\)|\\{[^}]{1,40}\\}|(?i:www)\\.[a-zA-Z0-9-]+(?:\\.[a-zA-Z]{2,})+[{WS}]*[-\u{2013}:|]?))+[{WS}]*";

/// `TITLE_SEPARATOR_RE`: separador explícito entre dois títulos no nome.
const TITLE_SEPARATOR_PATTERN: &str =
    "[{WS}]+[-\u{2013}\u{2014}|/][{WS}]+|:[{WS}]+|[{WS}]*\\([{WS}]*";

fn expand_ws(pattern: &str) -> String {
    pattern.replace("{WS}", JS_WS)
}

fn leading_release_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&expand_ws(LEADING_TAG_PATTERN)).expect("regex da etiqueta inicial")
    })
}

fn title_separator() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&expand_ws(TITLE_SEPARATOR_PATTERN)).expect("regex do separador"))
}

/// Escapa como o `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` do TS.
fn js_regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if ".*+?^${}()|[]\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// `matchesTitleStructure`: prefixo, sequência e ano. Vale também para filme
/// de indexer global: "Scary Movie 2" não é o "Scary Movie" de 2000.
///
/// `year` é `""` quando o TS recebe `null`. `tokens` é `None` quando o TS
/// recebe `null`; lista vazia (`Some(&[])`) é verdade em JS e não cai no título.
pub fn matches_title_structure(
    title: &str,
    name: &str,
    year: &str,
    is_series: bool,
    tokens: Option<&[String]>,
) -> bool {
    let computed;
    let own: &[String] = match tokens {
        Some(t) => t,
        None => {
            computed = title_tokens(title);
            &computed
        }
    };
    matches_title_structure_with(title, name, year, is_series, own, &title_tokens(name))
}

/// `matches_title_structure` com os tokens do título (`own`) e os do nome
/// (`wanted` = `title_tokens(name)`) já calculados.
pub(crate) fn matches_title_structure_with(
    title: &str,
    name: &str,
    year: &str,
    is_series: bool,
    own: &[String],
    wanted: &[String],
) -> bool {
    // Sem token procurado não há o que casar: passar adiante deixaria a
    // release sobreviver na dúvida.
    if wanted.is_empty() {
        return false;
    }
    if let Some(want) = first_significant_token(wanted).filter(|w| !w.is_empty()) {
        if first_significant_token(own) != Some(want) {
            return false;
        }
    }

    if !is_series {
        let wanted_markers = extract_sequence_markers(name);
        let own_markers = extract_sequence_markers(title);
        // Sequência não pedida é outra obra.
        if !own_markers.is_subset(&wanted_markers) {
            return false;
        }
        // Guarda reversa: a busca pede sequência e o candidato não declara
        // marcador. Só o ano exato do catálogo prova a continuação.
        if !wanted_markers.is_empty() && own_markers.is_empty() && !is_multi_work_collection(title)
        {
            let catalog_year = first_year_in(year);
            let cand_years: Vec<i64> = own
                .iter()
                .filter(|t| is_year_token(t))
                .filter_map(|t| t.parse().ok())
                .collect();
            if catalog_year == 0 || cand_years.len() != 1 || cand_years[0] != catalog_year {
                return false;
            }
        }
        if franchise_base_contradicts(title, Some(own), name, year) {
            return false;
        }
    }

    !year_contradicts(own, year, is_series)
}

/// Decisão de identidade de nome curto, com os três estados separados.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortNameIdentity {
    /// Base efetiva com 3+ tokens ou vazia: o portão não se aplica.
    Skip,
    /// Base de 1–2 tokens sem token latino que nomeie a obra.
    NoToken,
    /// Há token que nomeia a obra: a release precisa começar por ele.
    Prefix { want: String, run: Vec<String> },
}

/// `SHORT_NAME_BASE_MAX`: acima dela o corte de 0,6 já exige nome quase inteiro.
const SHORT_NAME_BASE_MAX: usize = 2;

/// `shortNameIdentity`: decide, por nome, o que o portão vai exigir.
pub fn short_name_identity(name: &str) -> ShortNameIdentity {
    let base = name_coverage_tokens(name);
    if base.is_empty() || base.len() > SHORT_NAME_BASE_MAX {
        return ShortNameIdentity::Skip;
    }
    let tokens = title_tokens(name);
    let Some(want) = first_work_token(&tokens) else {
        return ShortNameIdentity::NoToken;
    };
    let run: Vec<String> = tokens
        .iter()
        .filter(|w| !is_non_naming_token(w) && !is_non_latin_token(w))
        .cloned()
        .collect();
    ShortNameIdentity::Prefix {
        want: want.to_string(),
        run,
    }
}

/// `namedAfterSeparator`: depois de um separador explícito, o trecho começa
/// pelo nome inteiro (2+ tokens que nomeiam, em sequência).
fn named_after_separator(text: &str, run: &[String]) -> bool {
    if run.len() < 2 {
        return false;
    }
    title_separator().split(text).skip(1).any(|segment| {
        let seq: Vec<String> = title_tokens(segment)
            .into_iter()
            .filter(|w| !is_non_naming_token(w))
            .collect();
        run.iter()
            .enumerate()
            .all(|(k, w)| seq.get(k).map(String::as_str) == Some(w.as_str()))
    })
}

/// `possessiveBeforeName`: posse explícita ("Marvel's Daredevil") com o
/// apóstrofo no texto cru.
fn possessive_before_name(text: &str, want: &str) -> bool {
    let pattern = format!(
        "(?i)\\p{{L}}['\u{2019}]s[{}]+{}(?![\\p{{L}}\\p{{N}}])",
        JS_WS,
        js_regex_escape(want)
    );
    let re = FancyRegex::new(&pattern).expect("regex de posse escapada");
    re.is_match(text).expect("regex de posse avalia")
}

/// `namesTheWork`: o texto nomeia a obra? Só nega quando o primeiro token
/// que não é rótulo é latino e diferente do esperado, sem separador nem posse.
fn names_the_work(text: &str, tokens: Option<&[String]>, want: &str, run: &[String]) -> bool {
    let untagged = leading_release_tag().replace(text, "").into_owned();
    let own: Vec<String> = if !untagged.is_empty() && untagged != text {
        title_tokens(&untagged)
    } else {
        match tokens {
            Some(t) => t.to_vec(),
            None => title_tokens(text),
        }
    };
    let Some(first) = first_unmarked_token(&own) else {
        return true;
    };
    if is_non_latin_token(first) {
        return true;
    }
    if first == want {
        return true;
    }
    named_after_separator(&untagged, run) || possessive_before_name(text, want)
}

/// `matchesShortNameIdentity`: com base curta, a release precisa nomear a obra
/// por um token que começa o título. `dn` é o nome real do torrent, evidência
/// alternativa. Sem `Prefix`, o portão se cala e devolve `true`.
pub fn matches_short_name_identity(
    title: &str,
    check: &ShortNameIdentity,
    tokens: Option<&[String]>,
    dn: &str,
) -> bool {
    let ShortNameIdentity::Prefix { want, run } = check else {
        return true;
    };
    if names_the_work(title, tokens, want, run) {
        return true;
    }
    !dn.is_empty() && names_the_work(dn, None, want, run)
}
