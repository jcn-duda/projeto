//! Moldura das chaves `raw:v1` do recompute — porte do `rawKeyFor`
//! (`src/utils/trace-recompute.ts:61`), que mantém a moldura do escritor
//! legado do Jackett TS (`jackett-query.rawKeysFor`) porque só o diagnóstico
//! lê estas linhas hoje.
//!
//! BR perde o token de episódio (`SxxEyy` → `Sxx`) e o acento; global colapsa
//! sigla com ponto; indexer `bareTitle` perde o ano do fim. Os dois regex do TS
//! são reimplementados a mão (o crate NÃO ganha dependência de regex):
//! `/\bS(\d{1,2})E\d{1,3}\b/gi` → `S$1` e `/\s+(?:19|20)\d{2}\s*$/` → `' '`.

use adom_core::{collapse_acronyms, prefix, strip_diacritics};

/// `\w` do JS (ASCII-only): letras, dígitos e `_`.
fn is_js_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\s` do ECMAScript (a MESMA lista do `stream_trace.rs` do núcleo — fonte
/// única da régua; inclui NBSP e BOM, que o `char::is_whitespace` diverge).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{09}'
            | '\u{0A}'
            | '\u{0B}'
            | '\u{0C}'
            | '\u{0D}'
            | '\u{20}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `/\bS(\d{1,2})E\d{1,3}\b/gi` → `S<temporada>`: o resolver precisa do `Sxx`,
/// o episódio não. Scanner greedy SEM backtrack — os casos de fronteira em que
/// o regex recuaria ("S123E456", "S12E4567") falham no regex por não ter `E`/
/// boundary depois, e o scanner também os rejeita.
fn collapse_episode_token(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let boundary_before = i == 0 || !is_js_word(chars[i - 1]);
        if boundary_before && (chars[i] == 'S' || chars[i] == 's') {
            let mut j = i + 1;
            let mut digits_s = 0;
            while j < chars.len() && chars[j].is_ascii_digit() && digits_s < 2 {
                j += 1;
                digits_s += 1;
            }
            if (1..=2).contains(&digits_s)
                && j < chars.len()
                && (chars[j] == 'E' || chars[j] == 'e')
            {
                let mut k = j + 1;
                let mut digits_e = 0;
                while k < chars.len() && chars[k].is_ascii_digit() && digits_e < 3 {
                    k += 1;
                    digits_e += 1;
                }
                let boundary_after = k == chars.len() || !is_js_word(chars[k]);
                if (1..=3).contains(&digits_e) && boundary_after {
                    out.push('S');
                    out.extend(chars[i + 1..j].iter());
                    i = k;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// `/\s+(?:19|20)\d{2}\s*$/` → `' '`: o ano do filme sai do fim nos indexers
/// que zeram com QUALQUER token extra. O `\s*$` consome espaços finais; o
/// `\s+` exige pelo menos um espaço antes do ano (senão não casa).
fn strip_trailing_year(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut end = chars.len();
    while end > 0 && is_js_space(chars[end - 1]) {
        end -= 1;
    }
    if end < 4 {
        return input.to_string();
    }
    let year = &chars[end - 4..end];
    let looks_year = year.iter().all(|c| c.is_ascii_digit())
        && ((year[0] == '1' && year[1] == '9') || (year[0] == '2' && year[1] == '0'));
    if !looks_year {
        return input.to_string();
    }
    let mut start = end - 4;
    while start > 0 && is_js_space(chars[start - 1]) {
        start -= 1;
    }
    if start == end - 4 {
        return input.to_string();
    }
    let mut out: String = chars[..start].iter().collect();
    out.push(' ');
    out
}

/// `replace(/\s+/g, ' ').trim()` com o `\s` do JS (o trim do Rust diverge em
/// whitespace exótico): colapso interior, nada nas bordas.
fn collapse_spaces(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_space = false;
    for c in input.chars() {
        if is_js_space(c) {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(c);
    }
    out
}

/// `/^S\d{1,2}$/i` — moldagem que virou SÓ o token de temporada.
fn is_season_only(shaped: &str) -> bool {
    let chars: Vec<char> = shaped.chars().collect();
    (chars.len() == 2 || chars.len() == 3)
        && (chars[0] == 'S' || chars[0] == 's')
        && chars[1..].iter().all(|c| c.is_ascii_digit())
}

/// A MESMA chave que o escritor legado gravou:
/// `raw:v1:jackett:<indexer>:<type>:<query moldada>`.
pub(super) fn raw_key_for(
    pt_br_indexers: &[String],
    bare_title_indexers: &[String],
    indexer: &str,
    query: &str,
    kind: &str,
) -> String {
    let original = query.to_string();
    let mut shaped = original.clone();
    if pt_br_indexers.iter().any(|item| item == indexer) {
        shaped = collapse_episode_token(&shaped);
        shaped = strip_diacritics(&shaped);
    } else {
        shaped = collapse_acronyms(&shaped);
    }
    if bare_title_indexers.iter().any(|item| item == indexer) {
        shaped = strip_trailing_year(&shaped);
    }
    shaped = collapse_spaces(&shaped);
    // Mesma guarda do escritor: a moldagem nunca devolve SÓ o token de
    // temporada (e uma moldagem vazia volta ao original).
    let search_query = if shaped.is_empty() || is_season_only(&shaped) {
        original.clone()
    } else {
        shaped
    };
    format!("{}jackett:{indexer}:{kind}:{search_query}", prefix("raw"))
}
