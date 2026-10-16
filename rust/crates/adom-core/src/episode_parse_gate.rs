//! Portão rápido do `parse_title_season_episode`: o crate `regex` (DFA, uma
//! passada) diz se o padrão PODE casar, e só então roda o `fancy_regex`, cujo
//! laço de retrocesso custa ~1-2 µs por padrão mesmo quando nada casa — e
//! quase nenhum título casa a maioria dos 19 padrões.
//!
//! O padrão do portão é o original sem os lookarounds. Tirar uma asserção só
//! alarga o conjunto de casamentos, então "o relaxado não casa" prova "o
//! original não casa": o portão nunca muda resultado, só pula trabalho.

/// Remove os grupos `(?<!…)`, `(?<=…)`, `(?!…)` e `(?=…)`, respeitando escape e
/// classe de caractere (um `(` dentro de `[...]` não abre grupo).
pub(crate) fn strip_lookarounds(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::with_capacity(pattern.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' && is_lookaround_at(&chars, i) {
            i = skip_group(&chars, i);
            continue;
        }
        let end = atom_end(&chars, i);
        out.extend(&chars[i..end]);
        i = end;
    }
    out
}

fn is_lookaround_at(chars: &[char], i: usize) -> bool {
    let next: String = chars[i + 1..chars.len().min(i + 4)].iter().collect();
    next.starts_with("?=")
        || next.starts_with("?!")
        || next.starts_with("?<=")
        || next.starts_with("?<!")
}

/// Fim (exclusivo) do átomo em `i`: escape inteiro, classe inteira ou um char.
fn atom_end(chars: &[char], i: usize) -> usize {
    match chars[i] {
        '\\' => (i + 2).min(chars.len()),
        '[' => {
            let mut j = i + 1;
            // `]` logo na abertura (ou após `^`) é literal na classe.
            if chars.get(j) == Some(&'^') {
                j += 1;
            }
            if chars.get(j) == Some(&']') {
                j += 1;
            }
            while j < chars.len() && chars[j] != ']' {
                j = if chars[j] == '\\' { j + 2 } else { j + 1 };
            }
            (j + 1).min(chars.len())
        }
        _ => i + 1,
    }
}

/// Fim (exclusivo) do grupo que abre em `i`, contando parênteses aninhados.
fn skip_group(chars: &[char], i: usize) -> usize {
    let mut depth = 0usize;
    let mut j = i;
    while j < chars.len() {
        match chars[j] {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return j + 1;
                }
            }
            _ => {}
        }
        j = atom_end(chars, j);
    }
    chars.len()
}

/// Padrão de episódio com o seu portão: `gate` é o original sem lookarounds
/// no crate `regex`, que descarta o texto numa passada de DFA.
pub(crate) struct GatedRegex {
    pub(crate) fancy: fancy_regex::Regex,
    gate: regex::Regex,
}

impl GatedRegex {
    pub(crate) fn new(pattern: &str) -> Self {
        GatedRegex {
            fancy: fancy_regex::Regex::new(pattern).expect("padrão de episódio compila"),
            gate: regex::Regex::new(&strip_lookarounds(pattern))
                .expect("padrão relaxado de episódio compila no regex"),
        }
    }

    /// Falso só quando o padrão certamente não casa em `text`.
    pub(crate) fn may_match(&self, text: &str) -> bool {
        self.gate.is_match(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tira_lookbehind_e_lookahead() {
        assert_eq!(
            strip_lookarounds(r"(?<![a-z0-9])s([0-9]{1,2})(?![a-z0-9])"),
            r"s([0-9]{1,2})"
        );
    }

    #[test]
    fn preserva_grupos_comuns_e_classes() {
        assert_eq!(
            strip_lookarounds(r"(?:a|b)([(?!x)])\(?!"),
            r"(?:a|b)([(?!x)])\(?!"
        );
    }

    #[test]
    fn tira_lookaround_aninhado_em_alternancia() {
        assert_eq!(
            strip_lookarounds(r"(?:[-–]|(?<![A-Z0-9_])(?:AO|A)(?![A-Z]))x"),
            r"(?:[-–]|(?:AO|A))x"
        );
    }
}
