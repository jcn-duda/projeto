//! Porte das funções de `src/utils/matching-tokens.ts` que dependem só de texto
//! ou de tokens: `extractSequenceMarkers`, `episodeWorkTokens`,
//! `firstWorkToken`, `isNonNamingToken` e `isNonLatinToken` — fatia 2 de
//! matching-tokens. As demais (`titlePrecision`, `yearContradicts`, …) precisam
//! de conjuntos e anos de entrada próprios e entram em fatias com golden próprio.
//!
//! Tudo aqui é função pura sobre tokens já normalizados por `title_tokens`. Os
//! conjuntos e regex vêm de `matching_vocabulary`, sem réplica.

use std::collections::BTreeSet;

use crate::matching_vocabulary::{
    episode_mark_test, latin_letter_test, leading_articles, numeral_value, pack_words,
    release_noise, sequence_words, stop_at, strong_pack_words, structure_token_test,
};
use crate::matching_vocabulary::{episode_token_test, title_tokens};

/// Marcador de sequência: número (2..=19) ou palavra ("Ressurge", "Rises").
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Marker {
    Number(u8),
    Word(String),
}

impl Marker {
    /// Forma textual do marcador, a mesma que o golden registra.
    pub fn as_text(&self) -> String {
        match self {
            Marker::Number(n) => n.to_string(),
            Marker::Word(w) => w.clone(),
        }
    }
}

/// Ano de 19xx/20xx inteiro, como `/^(?:19|20)\d{2}$/` no JS.
fn is_year_token(token: &str) -> bool {
    token.len() == 4
        && (token.starts_with("19") || token.starts_with("20"))
        && token.bytes().all(|b| b.is_ascii_digit())
}

/// Valor de um token numérico: `\d+` (ASCII) ou o sufixo "Nu" em 2..=19.
/// Espelha `Number(...)` do JS: fora de 2..=19 não é marcador.
fn sequence_number(token: &str) -> Option<u8> {
    // `2u`..`9u`, `10u`..`19u` (sufixo "u" sem caixa diferente: já vem minúsculo).
    // `/^([2-9]|1[0-9])u$/i`: um dígito de 2 a 9, ou "1" seguido de dígito. "02u"
    // não casa; por isso a checagem é por tamanho e não só por valor.
    if let Some(digits) = token.strip_suffix('u').or_else(|| token.strip_suffix('U')) {
        let n: u8 = match digits.len() {
            1 => digits.parse().ok().filter(|n| (2..=9).contains(n))?,
            2 if digits.starts_with('1') => {
                digits.parse().ok().filter(|n| (10..=19).contains(n))?
            }
            _ => return None,
        };
        return Some(n);
    }
    if !token.is_empty() && token.bytes().all(|b| b.is_ascii_digit()) {
        let n: u64 = token.parse().ok()?;
        return u8::try_from(n).ok().filter(|n| (2..=19).contains(n));
    }
    numeral_value(token).filter(|n| (2..=19).contains(n))
}

/// Marcadores de sequência do título: sequência por palavra ou número, até o
/// primeiro ano ou ruído de release (`STOP_AT`).
pub fn extract_sequence_markers(text: &str) -> BTreeSet<Marker> {
    let mut markers = BTreeSet::new();
    for raw in title_tokens(text) {
        if is_year_token(&raw) || stop_at().contains(raw.as_str()) {
            break;
        }
        if sequence_words().contains(raw.as_str()) {
            markers.insert(Marker::Word(raw));
        } else if let Some(n) = sequence_number(&raw) {
            markers.insert(Marker::Number(n));
        }
    }
    markers
}

/// Tokens de um marcador de episódio (`s01e02`, `1x04`, `t2 e3`).
fn is_episode_marker_at(tokens: &[String], i: usize) -> bool {
    let t = tokens[i].as_str();
    if is_sxxeyy_or_nxnn(t) {
        return true;
    }
    // `t\d{1,2}` seguido de `e\d{1,3}` como dois tokens.
    let next = tokens.get(i + 1).map(String::as_str).unwrap_or("");
    is_t_season(t) && is_e_episode(next)
}

/// `/^(?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/` (dígitos ASCII).
fn is_sxxeyy_or_nxnn(t: &str) -> bool {
    if let Some(rest) = t.strip_prefix('s') {
        if let Some((season, episode)) = rest.split_once('e') {
            return is_digits(season, 1, 2) && is_digits(episode, 1, 3);
        }
        return false;
    }
    if let Some((season, episode)) = t.split_once('x') {
        return is_digits(season, 1, 2) && is_digits(episode, 1, 3);
    }
    false
}

/// `/^t\d{1,2}$/`.
fn is_t_season(t: &str) -> bool {
    t.strip_prefix('t').is_some_and(|d| is_digits(d, 1, 2))
}

/// `/^e\d{1,3}$/`.
fn is_e_episode(t: &str) -> bool {
    t.strip_prefix('e').is_some_and(|d| is_digits(d, 1, 3))
}

/// `\d{min,max}` inteiro, com dígitos ASCII.
fn is_digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// Trecho que nomeia a OBRA numa release por episódio. `None` quando não há
/// marcador de episódio; `Some(vec)` com os tokens da obra, possivelmente vazio.
pub fn episode_work_tokens(tokens: &[String]) -> Option<Vec<String>> {
    let markers: Vec<usize> = (0..tokens.len())
        .filter(|&i| is_episode_marker_at(tokens, i))
        .collect();
    let first = *markers.first()?;
    if first > 0 {
        return Some(tokens[..first].to_vec());
    }
    let mut end = markers.get(1).copied().unwrap_or(tokens.len());
    // Com um único marcador à esquerda, o grupo da release vem depois do nome:
    // parar no primeiro ruído técnico (índice > 0).
    if markers.len() == 1 {
        if let Some(noise_at) = (1..tokens.len()).find(|&i| stop_at().contains(tokens[i].as_str()))
        {
            end = noise_at;
        }
    }
    Some(tokens[1..end].to_vec())
}

/// Régua única de "rótulo ou estrutura": não nomeia a obra.
pub fn is_non_naming_token(token: &str) -> bool {
    token.is_empty()
        // `length` do JS conta unidades UTF-16, não caracteres.
        || token.encode_utf16().count() <= 2
        || leading_articles().contains(token)
        || release_noise().contains(token)
        || pack_words().contains(token)
        || strong_pack_words().contains(token)
        || episode_token_test(token)
        || episode_mark_test(token)
        || structure_token_test(token)
}

/// O token não tem letra latina: título localizado ou marca de outro script.
pub fn is_non_latin_token(token: &str) -> bool {
    !token.is_empty() && !latin_letter_test(token)
}

/// Primeiro token LATINO que nomeia a obra; `None` quando nenhum nomeia.
pub fn first_work_token(tokens: &[String]) -> Option<&str> {
    tokens
        .iter()
        .map(String::as_str)
        .find(|w| !w.is_empty() && !is_non_naming_token(w) && !is_non_latin_token(w))
}
