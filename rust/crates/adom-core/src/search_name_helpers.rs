//! Porte dos helpers de nome de busca de `src/utils/search-names.ts` (fatia
//! "search_name_helpers" da migração TS→Rust).
//!
//! Escopo: `resolveSearchNames`, `resolveOriginalStepName`, `parseStremioId`,
//! `buildSearchQuery`, `numeralSearchVariant`, `markDebridName` e
//! `matchesQualityFilter`. `toStremioStream`, `passesQualityFilter` e o
//! `streamDisplayName` reexportado ficam de fora (dependem de tipos de stream e
//! de módulos não portados).
//!
//! As entradas são `serde_json::Value` onde o TS coage valor (`||`, `String()`,
//! `?? null`), para preservar a semântica exata sem achatar NaN/undefined. O
//! golden de `rust/golden/search-name-helpers.jsonl` (oráculo `dist` vivo)
//! cobre o comportamento; NÃO há promessa genérica de paridade byte a byte fora
//! dos casos do corpus — nada de locale, I/O ou config (todas as funções são
//! puras).
//!
//! Reuso do núcleo: `normalize_title` (casca e prefixo), `dedupe_names`,
//! `first_year_in` (mesma extração de ano do `catalog-year`),
//! `leading_articles` (NÃO criar um Set novo) e `numeral_value` (mesma tabela
//! romana II..IX; `I` e `X` ficam de fora). As fronteiras `\p{L}`/`\p{N}` usam
//! `unicode-properties` (Unicode 17), e não as tabelas do crate `regex`.

use serde_json::{json, Value};
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

use crate::dedupe_names::dedupe_names;
use crate::js_text::{js_number_of_str, js_slice_units, js_to_string, js_trim};
use crate::matching_decisions::first_year_in;
use crate::matching_vocabulary::{leading_articles, numeral_value};
use crate::title_normalization::normalize_title;

// ── resolveSearchNames ────────────────────────────────────────────────

/// `resolveSearchNames({ meta, titles, imdbId })`. Devolve o objeto do TS
/// (`{name, year, altYear, names}`) como `Value`, para o golden comparar com o
/// `JSON.stringify` do oráculo. `year` preserva o TIPO original (número ou
/// texto) de quem venceu, como no TS; `altYear` é sempre número ou `null`.
pub fn resolve_search_names(options: &Value) -> Value {
    let meta = options.get("meta");
    let titles = options.get("titles");
    let meta_name = field_str(meta, "name");
    let titles_en = field_str(titles, "en");
    let titles_pt = field_str(titles, "pt");
    let titles_original = field_str(titles, "original");
    let imdb = field_str(Some(options), "imdbId");

    // `meta?.name || titles?.en || titles?.original || titles?.pt || imdbId || ''`.
    let fallback = titles_en.or(titles_original).or(titles_pt);
    let name = meta_name.or(fallback).or(imdb).unwrap_or("").to_string();

    // `[meta?.name, titles?.en, titles?.pt, titles?.original, ...(titles?.br || [])]`.
    let mut raw_names: Vec<Option<&str>> = vec![meta_name, titles_en, titles_pt, titles_original];
    let br = titles
        .and_then(|t| t.get("br"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    raw_names.extend(br);
    let names = dedupe_names(&raw_names);

    let meta_year = meta.and_then(|m| m.get("year"));
    let tmdb_year = titles.and_then(|t| t.get("year"));
    let year_value = choose_year(meta_year, tmdb_year);
    let alt_year = alt_year(&year_value, meta_year, tmdb_year);

    json!({
        "name": name,
        "year": year_value,
        "altYear": alt_year,
        "names": names,
    })
}

/// `catalogYearOf` com o TIPO original preservado: divergência > 2 devolve o ano
/// do TMDB; senão `metaYear || tmdbYear || null`.
fn choose_year(meta_year: Option<&Value>, tmdb_year: Option<&Value>) -> Value {
    let m = first_year_in(&string_of(meta_year));
    let t = first_year_in(&string_of(tmdb_year));
    if m != 0 && t != 0 && (m - t).abs() > 2 {
        return truthy_value(tmdb_year).unwrap_or(Value::Null);
    }
    truthy_value(meta_year)
        .or_else(|| truthy_value(tmdb_year))
        .unwrap_or(Value::Null)
}

/// `catalogAltYearOf`: o ano descartado quando as fontes divergem por mais de 2.
fn alt_year(chosen: &Value, meta_year: Option<&Value>, tmdb_year: Option<&Value>) -> Option<i64> {
    // `chosen === tmdbYear` é igualdade ESTRITA do JS: número e texto não são
    // iguais, e `undefined !== null` (por isso a comparação é contra `Some`).
    let other = if tmdb_year == Some(chosen) {
        meta_year
    } else {
        tmdb_year
    };
    let a = first_year_in(&string_of(Some(chosen)));
    let b = first_year_in(&string_of(other));
    (a != 0 && b != 0 && (a - b).abs() > 2).then_some(b)
}

// ── resolveOriginalStepName ───────────────────────────────────────────

/// Degrau opcional do título original: só existe quando ele difere do nome
/// primário por `normalize_title`. Devolve o ORIGINAL (não o normalizado).
pub fn resolve_original_step_name(
    original: Option<&str>,
    primary_name: Option<&str>,
) -> Option<String> {
    let original = original.filter(|s| !s.is_empty())?;
    let primary = primary_name.filter(|s| !s.is_empty())?;
    (normalize_title(original) != normalize_title(primary)).then(|| original.to_string())
}

// ── parseStremioId ────────────────────────────────────────────────────

/// `parseStremioId("tt1234567:1:2")`. `season`/`episode` usam `Number(part)` e
/// ficam `null` na parte vazia ou não finita (o `JSON.stringify` achata NaN para
/// `null`, como o oráculo).
pub fn parse_stremio_id(id: &str) -> Value {
    let parts: Vec<&str> = id.split(':').collect();
    let part = |i: usize| parts.get(i).copied().filter(|s| !s.is_empty());
    let season = part(1).map(|s| num_value(js_number_of_str(s)));
    let episode = part(2).map(|s| num_value(js_number_of_str(s)));
    json!({ "imdbId": parts.first().copied().unwrap_or(""), "season": season, "episode": episode })
}

// ── buildSearchQuery ──────────────────────────────────────────────────

/// `buildSearchQuery(meta, {season, episode})`: com S/E declarados vira
/// `Nome SxxEyy`; senão `Nome Ano` (ano com `slice(0,4)` em unidades UTF-16).
pub fn build_search_query(meta: &Value, season_episode: &Value) -> String {
    let name = field_str(Some(meta), "name")
        .or_else(|| field_str(Some(meta), "title"))
        .unwrap_or("");
    let year = year_slice(meta.get("year"));
    let season = season_episode.get("season");
    let episode = season_episode.get("episode");
    if is_not_nullish(season) && is_not_nullish(episode) {
        let s = pad_start2(&js_to_string(season.expect("season não nula")));
        let e = pad_start2(&js_to_string(episode.expect("episode não nula")));
        return js_trim(&format!("{name} S{s}E{e}")).to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    if !name.is_empty() {
        parts.push(name);
    }
    if !year.is_empty() {
        parts.push(year.as_str());
    }
    js_trim(&parts.join(" ")).to_string()
}

/// `meta?.year ? String(meta.year).slice(0,4) : ''` — `0`, `""` e null são falsy.
fn year_slice(year: Option<&Value>) -> String {
    match year {
        Some(v) if is_truthy(v) => js_slice_units(&jss(v), 4),
        _ => String::new(),
    }
}

// ── numeralSearchVariant ──────────────────────────────────────────────

/// Literais da alternância do regex do TS (`VIII|VII|IV|III|IX|VI|II|V`), em
/// MAIÚSCULA porque o regex não tem flag `i` ("rocky ii" não gera variante). O
/// valor sai de `numeral_value`, que já cobre só II..IX (fora `I`/`X`).
const ROMAN_LITERALS: [&str; 8] = ["VIII", "VII", "IV", "III", "IX", "VI", "II", "V"];

/// Segunda tentativa de busca dos indexers BR: troca UM numeral romano (II..IX)
/// pelo arábico, quando ele vem depois do nome-base. `None` com zero ou dois+
/// numerais, ou quando o prefixo é só artigo.
pub fn numeral_search_variant(query: &str) -> Option<String> {
    let chars: Vec<char> = query.chars().collect();
    let matches = roman_matches(&chars);
    if matches.len() != 1 {
        return None;
    }
    let (start, len) = matches[0];
    let prefix: String = chars[..start].iter().collect();
    let normalized = normalize_title(&prefix);
    let tokens: Vec<&str> = normalized.split(' ').filter(|t| !t.is_empty()).collect();
    // Precisa de ao menos um token que não seja artigo inicial: "V de Vingança"
    // e "O V" NÃO viram consulta inventada.
    if !tokens
        .iter()
        .copied()
        .any(|t| !leading_articles().contains(t))
    {
        return None;
    }
    let literal: String = chars[start..start + len].iter().collect();
    let value = numeral_value(&literal.to_ascii_lowercase())?;
    let suffix: String = chars[start + len..].iter().collect();
    Some(format!("{prefix}{value}{suffix}"))
}

/// Todas as ocorrências não sobrepostas de `(?<![\p{L}\p{N}])(?:VIII|…|V)(?![\p{L}\p{N}])/gu`:
/// `(início em chars, comprimento em chars)`.
fn roman_matches(chars: &[char]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let lookbehind_ok = i == 0 || !is_letter_or_number(chars[i - 1]);
        if lookbehind_ok {
            if let Some(len) = match_roman_at(chars, i) {
                out.push((i, len));
                i += len;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Primeiro literal da alternância que casa em `i` com a lookahead satisfeita.
fn match_roman_at(chars: &[char], i: usize) -> Option<usize> {
    for literal in ROMAN_LITERALS {
        let len = literal.len();
        if i + len > chars.len() {
            continue;
        }
        let ok = literal
            .bytes()
            .enumerate()
            .all(|(k, b)| chars[i + k] as u32 == u32::from(b));
        if !ok {
            continue;
        }
        if i + len >= chars.len() || !is_letter_or_number(chars[i + len]) {
            return Some(len);
        }
    }
    None
}

/// `[\p{L}\p{N}]` de um code point (Unicode 17 via `unicode-properties`).
fn is_letter_or_number(c: char) -> bool {
    matches!(
        c.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
    )
}

// ── markDebridName / matchesQualityFilter ─────────────────────────────

/// Prefixo do Torrentio com ⚡ no lugar do `+` (`[AD⚡]`/`[AD download]`). Sem
/// sigla, devolve o nome cru.
pub fn mark_debrid_name(name: &str, short: &str, cached: bool) -> String {
    let tag = js_trim(short);
    if tag.is_empty() {
        return name.to_string();
    }
    let suffix = if cached { "⚡" } else { " download" };
    format!("[{tag}{suffix}] {name}")
}

/// Whitelist por substring do título (não julga `_quality` — isso é
/// `passesQualityFilter`, fora desta fatia). Sem filtros, tudo passa.
pub fn matches_quality_filter(title: &str, filters: Option<&[String]>) -> bool {
    let Some(filters) = filters else {
        return true;
    };
    if filters.is_empty() {
        return true;
    }
    let upper = title.to_uppercase();
    filters.iter().any(|f| upper.contains(&f.to_uppercase()))
}

// ── coerções do JS compartilhadas ─────────────────────────────────────

/// Campo de objeto como string NÃO vazia (`||`): null/ausente/`""` são falsy.
fn field_str<'a>(obj: Option<&'a Value>, key: &str) -> Option<&'a str> {
    obj.and_then(|o| o.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// `String(valor ?? '')` do TS (`catalogYearOf`/`catalogAltYearOf`).
fn string_of(v: Option<&Value>) -> String {
    match v {
        None => String::new(),
        Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => num_text(n),
        Some(other) => js_to_string(other),
    }
}

/// Truthiness do JS sobre o valor ORIGINAL, preservando o tipo no retorno.
fn truthy_value(v: Option<&Value>) -> Option<Value> {
    let value = v?;
    match value {
        Value::Null => None,
        Value::Bool(b) => b.then_some(Value::Bool(true)),
        Value::Number(n) => (n.as_f64() != Some(0.0)).then(|| Value::Number(n.clone())),
        Value::String(s) => (!s.is_empty()).then(|| Value::String(s.clone())),
        // Arrays e objetos são sempre truthy no JS, inclusive vazios.
        Value::Array(_) | Value::Object(_) => Some(value.clone()),
    }
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `!= null` do JS: só `null` e ausente (`undefined`) são nullish.
fn is_not_nullish(v: Option<&Value>) -> bool {
    matches!(v, Some(x) if !x.is_null())
}

/// `String(valor)` para as coerções de `buildSearchQuery` (número com formato
/// do JS; os demais casos via `js_text::js_to_string`).
fn jss(v: &Value) -> String {
    match v {
        Value::Number(n) => num_text(n),
        other => js_to_string(other),
    }
}

/// `String(número)` do JS o suficiente para o corpus (inteiro exato; NaN/Inf
/// viram `"null"` como o `JSON.stringify`). Não é promessa genérica.
fn num_text(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    let f = n.as_f64().unwrap_or(f64::NAN);
    if !f.is_finite() {
        return "null".to_string();
    }
    if f == 0.0 {
        return "0".to_string();
    }
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{}", f as i64);
    }
    format!("{f}")
}

/// `Number(parte)` no formato do `JSON.stringify`: inteiro exato vira inteiro;
/// não finito vira `null`; o resto, `f64` serializável.
fn num_value(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f == 0.0 {
        return json!(0);
    }
    if f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
        return json!(f as i64);
    }
    serde_json::Number::from_f64(f)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// `String.prototype.padStart(2, '0')` (comprimento em unidades UTF-16).
fn pad_start2(s: &str) -> String {
    let mut out = s.to_string();
    let mut units: usize = out.chars().map(char::len_utf16).sum();
    while units < 2 {
        out.insert(0, '0');
        units += 1;
    }
    out
}
