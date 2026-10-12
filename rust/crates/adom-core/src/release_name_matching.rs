//! Porte puro de `src/utils/release-name-matching.ts`: cobertura de nome
//! (`matchesName`), raiz de franquia (`franchiseRoot`, `franchiseRoots`), marcador
//! de sequência no fim (`endsWithSequenceMarker`) e sequência contígua de
//! tokens (`containsTokenRun`).
//!
//! `nameCoverageTokens` e `isMultiWorkCollection` já estão portados em
//! `franchise.rs` e são reusados aqui, não copiados.
//!
//! `franchiseRoot` e `containsTokenRun` moveram para cá a partir de
//! `multiwork_pack.rs`, que os usava como cópias privadas.
//!
//! Regex do JS sem lookaround: `\s` é o conjunto do `trim` do JS (`js_trim`),
//! `\d` é `[0-9]` e `/i` vale só para ASCII (`[ivx]` e `parte`).

use std::collections::HashSet;

use crate::franchise::name_coverage_tokens;
use crate::js_text::js_trim;
use crate::matching_vocabulary::title_tokens;

/// Espaço no sentido JS (o mesmo do `trim` e do `\s`).
fn is_js_space(c: char) -> bool {
    js_trim(c.encode_utf8(&mut [0; 4])).is_empty()
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Separadores do corte de subtítulo: `:`, en dash e em dash.
fn is_cut_sep(c: char) -> bool {
    matches!(c, ':' | '–' | '—')
}

/// Número de palavras separadas por espaço JS (`split(/\s+/).filter(Boolean)`).
fn word_count(s: &str) -> usize {
    s.split(is_js_space).filter(|w| !w.is_empty()).count()
}

/// Candidato do `^([^:–—]+?)([:–—].*)?$`, ou `None` quando a regex não casa.
/// O `.*` do JS não atravessa quebra de linha, e o grupo 1 exige 1+ caractere.
fn cut_candidate(raw: &str) -> Option<&str> {
    match raw.find(is_cut_sep) {
        None => Some(raw),
        Some(0) => None,
        Some(p) => {
            let sep_len = raw[p..].chars().next().map_or(1, char::len_utf8);
            if raw[p + sep_len..].chars().any(is_line_terminator) {
                None
            } else {
                Some(&raw[..p])
            }
        }
    }
}

/// Remove espaços iniciais. `None` quando não há nenhum (o `\s+` exige um).
fn strip_leading_spaces(s: &str) -> Option<&str> {
    let trimmed = s.trim_start_matches(is_js_space);
    if trimmed.len() == s.len() {
        None
    } else {
        Some(trimmed)
    }
}

/// `[ivx]{1,4}` ou `\d{1,2}` ocupando o texto inteiro (âncora `$`).
fn is_numeral_tail(x: &str) -> bool {
    let n = x.chars().count();
    if (1..=4).contains(&n)
        && x.chars()
            .all(|c| matches!(c, 'i' | 'v' | 'x' | 'I' | 'V' | 'X'))
    {
        return true;
    }
    (1..=2).contains(&n) && x.chars().all(|c| c.is_ascii_digit())
}

/// `\s+(?:parte\s+)?(?:[ivx]{1,4}|\d{1,2})$` a partir de um espaço. `t`
/// começa no espaço do candidato.
fn tail_matches(t: &str) -> bool {
    let Some(rest) = strip_leading_spaces(t) else {
        return false;
    };
    if is_numeral_tail(rest) {
        return true;
    }
    match rest.get(..5) {
        Some(word) if word.eq_ignore_ascii_case("parte") => {
            strip_leading_spaces(&rest[5..]).is_some_and(is_numeral_tail)
        }
        _ => false,
    }
}

/// Byte onde começa o marcador de sequência do fim (o primeiro casamento, o
/// mais à esquerda, como o `replace` do JS). `None` quando não há marcador.
fn sequence_tail_start(s: &str) -> Option<usize> {
    s.char_indices()
        .find(|&(i, c)| is_js_space(c) && tail_matches(&s[i..]))
        .map(|(i, _)| i)
}

/// `franchiseRoot`: raiz da franquia de um título (ver release-name-matching.ts).
pub fn franchise_root(title: &str) -> String {
    let raw = js_trim(title);
    if raw.is_empty() {
        return String::new();
    }
    let mut head = raw.to_string();
    if let Some(candidate) = cut_candidate(raw) {
        let candidate = js_trim(candidate);
        if word_count(candidate) >= 2 {
            head = candidate.to_string();
        }
    }
    let stripped = match sequence_tail_start(&head) {
        Some(at) => &head[..at],
        None => head.as_str(),
    };
    let root = js_trim(stripped);
    if !root.is_empty() && word_count(root) >= 2 {
        return root.to_string();
    }
    head
}

/// `matchesName`: fração dos tokens do nome (`nameCoverageTokens`) presente no
/// título, com corte de 0.6. `tokens` é o conjunto já calculado, quando o
/// chamador o tem; `None` recalcula a partir do título.
pub fn matches_name(title: &str, name: &str, tokens: Option<&[String]>) -> bool {
    let wanted = name_coverage_tokens(name);
    if wanted.is_empty() {
        return false;
    }
    let got: HashSet<String> = match tokens {
        Some(list) => list.iter().cloned().collect(),
        None => title_tokens(title).into_iter().collect(),
    };
    let hits = wanted.iter().filter(|w| got.contains(*w)).count();
    hits as f64 / wanted.len() as f64 >= 0.6
}

/// `endsWithSequenceMarker`: o título (sem bordas) termina em marcador de
/// sequência. Mesmo corte que `franchise_root` aplica no fim.
pub fn ends_with_sequence_marker(title: &str) -> bool {
    sequence_tail_start(js_trim(title)).is_some()
}

/// `franchiseRoots`: raízes normalizadas de todos os nomes, sem duplicata e na
/// ordem de entrada. Raiz que normaliza para vazio não entra.
pub fn franchise_roots(names: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut roots = Vec::new();
    for name in names {
        let normalized = title_tokens(&franchise_root(name)).join(" ");
        if !normalized.is_empty() && seen.insert(normalized.clone()) {
            roots.push(normalized);
        }
    }
    roots
}

/// `containsTokenRun`: o título tem a raiz como sequência contígua de tokens.
pub fn contains_token_run(title: &str, normalized_root: &str) -> bool {
    let haystack = title_tokens(title);
    let needle: Vec<&str> = normalized_root
        .split(' ')
        .filter(|t| !t.is_empty())
        .collect();
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    haystack
        .windows(needle.len())
        .any(|window| window.iter().zip(&needle).all(|(a, b)| a.as_str() == *b))
}
