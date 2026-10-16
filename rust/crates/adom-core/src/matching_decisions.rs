//! Porte das decisões de `src/utils/matching-tokens.ts` que pedem conjuntos,
//! anos ou um objeto de requisição: `titlePrecision` (com `rawPrecision`),
//! `yearContradicts`, `namedSequelContradicts`, `liveActionYearContradicts`,
//! `adaptationIdentityContradicts` e `firstSignificantToken`.
//!
//! Os argumentos de ano chegam como texto (`""` para `null`/`undefined`), que é
//! o que o JS faz com `String(x || '')`. As lookbehind/lookahead do JS são
//! trocadas por varredura de dígitos: `(?<!\d)(?:19|20)\d{2}(?!\d)` vira "corrida
//! máxima de dígitos com 4 caracteres que começa com 19/20".

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::matching_tokens::is_year_token;
use crate::matching_vocabulary::{
    episode_token_test, leading_articles, pack_words, release_noise, stop_at, strong_pack_words,
    JS_SPACE,
};

/// `\d+` do JS: pelo menos um dígito ASCII, e só dígitos.
pub(crate) fn is_plain_digits(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit())
}

/// Primeiro `(?:19|20)\d{2}` do texto, sem fronteiras (como `String.match`).
/// Devolve 0 quando não há ano.
pub(crate) fn first_year_in(text: &str) -> i64 {
    let b = text.as_bytes();
    for i in 0..b.len().saturating_sub(3) {
        let prefix_ok = (b[i] == b'1' && b[i + 1] == b'9') || (b[i] == b'2' && b[i + 1] == b'0');
        if prefix_ok && b[i + 2].is_ascii_digit() && b[i + 3].is_ascii_digit() {
            return text[i..i + 4].parse().unwrap_or(0);
        }
    }
    0
}

/// `rawPrecision`: fração dos tokens significativos que estão na busca.
fn raw_precision(tokens: &[String], want: &HashSet<&str>) -> f64 {
    let significant: Vec<&str> = tokens
        .iter()
        .map(String::as_str)
        .filter(|w| {
            !release_noise().contains(w)
                && !pack_words().contains(w)
                && !strong_pack_words().contains(w)
                && !episode_token_test(w)
                && !is_plain_digits(w)
        })
        .collect();
    if significant.is_empty() {
        return 1.0;
    }
    let hits = significant.iter().filter(|w| want.contains(**w)).count();
    hits as f64 / significant.len() as f64
}

/// `titlePrecision`. Com `cut_tail`, mede a cabeça da obra (até o primeiro ano
/// ou `STOP_AT`) e devolve o máximo entre a cabeça e a lista inteira.
pub fn title_precision(tokens: &[String], wanted: &[String], cut_tail: bool) -> f64 {
    let want: HashSet<&str> = wanted.iter().map(String::as_str).collect();
    let full = raw_precision(tokens, &want);
    if !cut_tail {
        return full;
    }

    let mut head_start = 0;
    while head_start < tokens.len()
        && (pack_words().contains(tokens[head_start].as_str())
            || strong_pack_words().contains(tokens[head_start].as_str()))
    {
        head_start += 1;
    }

    let mut head_end = head_start;
    while head_end < tokens.len() {
        let raw = tokens[head_end].as_str();
        if is_year_token(raw) || stop_at().contains(raw) {
            break;
        }
        head_end += 1;
    }

    // Cabeça vazia: o primeiro token já é ano ou ruído, usa a lista inteira.
    if head_end == head_start {
        return full;
    }
    let head = raw_precision(&tokens[head_start..head_end], &want);
    head.max(full)
}

/// `yearContradicts`: o ano do título contradiz o do catálogo? Filme aceita ±2
/// com um ano; intervalo de anos precisa de um ano perto ou do catálogo dentro
/// do intervalo; série só corta quando todos os anos são anteriores a −2.
pub fn year_contradicts(tokens: &[String], catalog_year: &str, series: bool) -> bool {
    let catalog = first_year_in(catalog_year);
    if catalog == 0 {
        return false;
    }
    let years: Vec<i64> = tokens
        .iter()
        .filter(|t| is_year_token(t))
        .filter_map(|t| t.parse().ok())
        .collect();
    if years.is_empty() {
        return false;
    }
    if series {
        return years.iter().all(|y| *y < catalog - 2);
    }
    if years.len() == 1 {
        return (years[0] - catalog).abs() > 2;
    }
    let some_near = years.iter().any(|y| (y - catalog).abs() <= 2);
    if some_near {
        return false;
    }
    let min = years.iter().copied().min().unwrap_or(catalog);
    let max = years.iter().copied().max().unwrap_or(catalog);
    catalog < min || catalog > max
}

/// `namedSequelContradicts`: sequela com ano exato diferente do catálogo. Pede
/// token estranho ao universo de nomes E um ano declarado sem coincidir.
pub fn named_sequel_contradicts(
    tokens: &[String],
    universe: &[String],
    catalog_year: &str,
) -> bool {
    let catalog = first_year_in(catalog_year);
    if catalog == 0 {
        return false;
    }
    let want: HashSet<&str> = universe.iter().map(String::as_str).collect();
    let mut declared: Vec<i64> = Vec::new();
    let mut has_strange = false;
    for raw in tokens {
        let raw = raw.as_str();
        if raw.is_empty() {
            continue;
        }
        if is_year_token(raw) {
            declared.extend(raw.parse::<i64>().ok());
            break;
        }
        if stop_at().contains(raw) {
            break;
        }
        if release_noise().contains(raw)
            || pack_words().contains(raw)
            || strong_pack_words().contains(raw)
            || episode_token_test(raw)
            || is_plain_digits(raw)
        {
            continue;
        }
        if !want.contains(raw) {
            has_strange = true;
        }
    }
    if declared.is_empty() || declared.contains(&catalog) {
        return false;
    }
    has_strange
}

/// `LIVE_ACTION_RE` = `/\blive[\s.-]?action\b/i`. `\b` é ASCII no JS.
fn live_action_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i)(?-u:\b)live(?:{JS_SPACE}|[.\-])?action(?-u:\b)"
        ))
        .expect("LIVE_ACTION_RE compila")
    })
}

/// `/\d{3,4}x\d{3,4}/gi`: resolução tipo "1280x720", que sai antes da varredura.
fn resolution_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)[0-9]{3,4}x[0-9]{3,4}").expect("RESOLUTION_RE compila"))
}

/// Anos de 4 dígitos que começam com 19/20 e não colam em outros dígitos.
fn standalone_years(text: &str) -> Vec<i64> {
    text.split(|c: char| !c.is_ascii_digit())
        .filter(|run| run.len() == 4 && (run.starts_with("19") || run.starts_with("20")))
        .filter_map(|run| run.parse().ok())
        .collect()
}

/// `liveActionYearContradicts`: marcador de live action e um ano longe da
/// estreia, sem faixa que cubra a estreia.
pub fn live_action_year_contradicts(text: &str, premiere_year: &str) -> bool {
    if !live_action_re().is_match(text) {
        return false;
    }
    let premiere = first_year_in(premiere_year);
    if premiere == 0 {
        return false;
    }
    let cleaned = resolution_re().replace_all(text, " ");
    let years = standalone_years(&cleaned);
    if years.is_empty() {
        return false;
    }
    if years.iter().any(|y| (y - premiere).abs() <= 2) {
        return false;
    }
    let min = years.iter().copied().min().unwrap_or(premiere);
    let max = years.iter().copied().max().unwrap_or(premiere);
    if premiere >= min && premiere <= max {
        return false;
    }
    max >= premiere + ADAPTATION_YEAR_DRIFT
}

/// Deriva mínima de estreia para contar como adaptação (`ADAPTATION_YEAR_DRIFT`).
const ADAPTATION_YEAR_DRIFT: i64 = 8;

/// `adaptationIdentityContradicts`: só série (`season` presente) e só com as
/// provas de live action. `season_present` é `request.season != null` no JS.
pub fn adaptation_identity_contradicts(season_present: bool, text: &str, year: &str) -> bool {
    season_present && live_action_year_contradicts(text, year)
}

/// `firstSignificantToken`: primeiro token que não é ruído curto, artigo,
/// empacotamento ou marcador de episódio. Cai no primeiro token da lista.
pub fn first_significant_token(tokens: &[String]) -> Option<&str> {
    tokens
        .iter()
        .map(String::as_str)
        .find(|w| {
            // `length` do JS conta unidades UTF-16.
            w.encode_utf16().count() > 2
                && !leading_articles().contains(w)
                && !pack_words().contains(w)
                && !episode_token_test(w)
        })
        .or_else(|| tokens.first().map(String::as_str))
}
