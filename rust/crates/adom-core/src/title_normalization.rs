//! Porte fiel do comportamento string→string de `normalizeTitle`
//! (`src/utils/title-normalization.ts`) — fatia F1 da migração TS→Rust.
//!
//! Escopo deste arquivo: a função pura `normalizeTitle`. `bytesToSize`,
//! `decodeEntities`, `collapseAcronyms`, `stripDiacritics`, `dedupeNames` e
//! `magnetDisplayName` vivem em módulos irmãos. O fold latino e o colapso de
//! sigla ficam `pub(crate)` porque esses irmãos reusam a mesma medida.
//!
//! Contrato: entrada e saída são `&str`/`String` UTF-8 válidos. A equivalência
//! com o JS é afirmada para a classe coberta pelo golden de 23 casos
//! (`rust/golden/title-normalization.jsonl`, teste em `tests/golden_corpus.rs`)
//! somados aos 45 vetores de `tests/unicode_parity.rs`. NÃO há promessa genérica
//! de paridade byte a byte com o Node fora desses vetores: nada de `undefined`,
//! números, coerção, `String(obj)` ou `toLowerCase` de locale — a API recebe e
//! devolve texto, só.
//!
//! Classes Unicode (`\p{L}`, `\p{N}`, `\p{M}`) e NFD vêm de caixas com tabelas
//! Unicode 17.0.0, as mesmas do oráculo Node (v22, unicode=17.0 / ICU 78.2):
//! `unicode-properties` (General_Category) e `unicode-normalization` (NFD). O
//! `regex` foi descartado porque suas releases publicadas (1.13.1 /
//! regex-syntax 0.8.11) ainda usam tabelas 16.0.0 e classificam letras novas
//! (ex.: U+1E6C0, U+10940) como não-letras. A caixa baixa usa `to_lowercase` da
//! toolchain pinada em `rust-toolchain.toml` (1.92.0, primeira estável com
//! `char::UNICODE_VERSION = (17, 0, 0)`).

use unicode_normalization::UnicodeNormalization;
use unicode_properties::{GeneralCategoryGroup, UnicodeGeneralCategory};

/// Normaliza um título para comparação.
///
/// Ordem idêntica ao TS: colapsa siglas pontuadas, baixa a caixa, faz o fold
/// das letras latinas sem decomposição, decompõe NFD, remove marcas/compat e
/// troca todo não-(letra/número/marca) por um único espaço, com `trim` final.
pub fn normalize_title(input: &str) -> String {
    let collapsed = collapse_dotted_acronyms(input);
    // Atalho ASCII (o grosso das releases): fold, NFD e o descarte de compat só
    // tocam chars não-ASCII, então são identidade aqui.
    if collapsed.is_ascii() {
        return replace_non_word_runs(&collapsed.to_ascii_lowercase());
    }
    let lowered = collapsed.to_lowercase();
    let folded = fold_latin_letters(&lowered);
    let decomposed: String = folded.nfd().collect();
    let stripped: String = decomposed
        .chars()
        .filter(|c| !is_removed_compat(*c))
        .collect();
    replace_non_word_runs(&stripped)
}

/// Colapsa siglas pontuadas ("G.O.R.A.", "S.W.A.T.") em UMA palavra.
///
/// O `DOTTED_ACRONYM_RE` do TS usa lookbehind/lookahead; a classe `regex` não
/// tem lookaround, então o scanner aplica as MESMAS guardas de fronteira em
/// código, sobre `\p{L}` exato (ver `is_letter`).
pub(crate) fn collapse_dotted_acronyms(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        match dotted_acronym_end(&chars, i) {
            Some(end) => {
                // Mesma decisão do callback: letra/número logo após a sigla
                // recebe um espaço (separa "U.S.Marshals" em "US Marshals").
                // O TS lê `all.charAt(at + m.length)`, UMA unidade UTF-16: um
                // escalar astral (`len_utf16()==2`) é visto pela METADE (surrogate
                // alto, General_Category=Cs, nunca \p{L}/\p{N}) e NÃO glua; sem
                // esta guarda a sigla ganharia um espaço que o oráculo Node não
                // insere. É quirk do `charAt`, não regra Unicode: a cauda e as
                // lookarounds do regex usam code point inteiro e não seguem isto.
                let glued = end < chars.len()
                    && chars[end].len_utf16() == 1
                    && is_letter_or_number(chars[end]);
                for &c in &chars[i..end] {
                    if c != '.' {
                        out.push(c);
                    }
                }
                if glued {
                    out.push(' ');
                }
                i = end;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// Fim (exclusivo) da sigla pontuada que começa em `start`, ou `None`.
///
/// `(?:\p{L}\.){2,}` exige duas ou mais duplas letra+ponto; a letra de cauda
/// opcional só entra quando não é seguida por letra/número — igual à lookahead.
fn dotted_acronym_end(chars: &[char], start: usize) -> Option<usize> {
    if start > 0 && is_letter_or_number(chars[start - 1]) {
        return None;
    }
    let mut pos = start;
    let mut pairs = 0usize;
    while pos + 1 < chars.len() && is_letter(chars[pos]) && chars[pos + 1] == '.' {
        pos += 2;
        pairs += 1;
    }
    if pairs < 2 {
        return None;
    }
    if pos < chars.len() && is_letter(chars[pos]) {
        let trailing_ok = pos + 1 >= chars.len() || !is_letter_or_number(chars[pos + 1]);
        if trailing_ok {
            pos += 1;
        }
    }
    Some(pos)
}

/// `LATIN_FOLD`: letras que são caractere próprio no Unicode (o NFD não separa
/// e o replace de marcas não alcança). Portado com as MESMAS chaves do TS,
/// inclusive as maiúsculas — ainda que `normalize_title` já tenha baixado a
/// caixa antes de chamar. `push_str` cobre as expansões (ß→ss, æ→ae, œ→oe).
pub(crate) fn fold_latin_letters(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\u{0131}' => out.push('i'),      // ı
            '\u{0142}' => out.push('l'),      // ł
            '\u{0141}' => out.push('L'),      // Ł
            '\u{0111}' => out.push('d'),      // đ
            '\u{0110}' => out.push('D'),      // Đ
            '\u{00f8}' => out.push('o'),      // ø
            '\u{00d8}' => out.push('O'),      // Ø
            '\u{00df}' => out.push_str("ss"), // ß
            '\u{1e9e}' => out.push_str("SS"), // ẞ
            '\u{00e6}' => out.push_str("ae"), // æ
            '\u{00c6}' => out.push_str("AE"), // Æ
            '\u{0153}' => out.push_str("oe"), // œ
            '\u{0152}' => out.push_str("OE"), // Œ
            _ => out.push(c),
        }
    }
    out
}

/// Chars descartados explicitamente pelo TS: marcas combinantes U+0300–U+036F
/// e compat do Latin-1 (ordinais ªº, superscritos ¹²³⁰⁴…⁹, micro µ e fracções
/// ¼½¾). NÃO é o `\p{M}` inteiro: dakuten/vogais-marca fora dessa faixa (ex.:
/// U+3099 do japonês) seguem preservadas de propósito.
fn is_removed_compat(c: char) -> bool {
    matches!(
        c,
        '\u{0300}'..='\u{036f}'
            | '\u{00aa}'
            | '\u{00ba}'
            | '\u{00b2}'
            | '\u{00b3}'
            | '\u{00b9}'
            | '\u{00b5}'
            | '\u{00bc}'
            | '\u{00bd}'
            | '\u{00be}'
            | '\u{2070}'
            | '\u{2074}'..='\u{2079}'
    )
}

/// `\p{L}` exato: General_Category=Letter (Lu|Ll|Lt|Lm|Lo), Unicode 17.
///
/// NÃO usar `char::is_alphabetic`: ele reflete a propriedade derivada
/// `Alphabetic`, que também inclui `\p{Nl}` e `Other_Alphabetic` (ex.: as
/// letras circuladas U+24B6… — General_Category=So, não-letra). O `Node` casa
/// `\p{L}`, então a régua é a categoria, não `Alphabetic`.
fn is_letter(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphabetic();
    }
    c.general_category_group() == GeneralCategoryGroup::Letter
}

/// `[\p{L}\p{N}]` sobre um único code point (fronteira da sigla).
fn is_letter_or_number(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    matches!(
        c.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number
    )
}

/// Complemento de `[^\p{L}\p{N}\p{M}]+` — o que o replace final preserva.
fn is_word_char(c: char) -> bool {
    // No ASCII só há L (A-Z, a-z) e N (0-9); nenhuma marca.
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    matches!(
        c.general_category_group(),
        GeneralCategoryGroup::Letter | GeneralCategoryGroup::Number | GeneralCategoryGroup::Mark
    )
}

/// `[^\p{L}\p{N}\p{M}]+` → um único espaço, com o `trim` do TS embutido: não
/// emite espaço à esquerda nem deixa cauda. Equivale a
/// `.replace(regex, " ").trim()` sem depender de `regex`.
fn replace_non_word_runs(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if is_word_char(c) {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(c);
        } else {
            pending_space = true;
        }
    }
    out
}

/// Casos pequenos com evidência medida no oracle TS (`dist` vivo). O golden de
/// 23 fica em `tests/golden_corpus.rs` e os 45 vetores Unicode 17 em
/// `tests/unicode_parity.rs`; aqui só o que documenta decisão interna.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sigla_pontuada_colapsa_e_respeita_fronteira() {
        // Evidência TS: normalizeTitle('A.B.C') === 'abc';
        // normalizeTitle('A.B') === 'a b' (1 dupla < 2 não é sigla).
        assert_eq!(normalize_title("A.B.C"), "abc");
        assert_eq!(normalize_title("A.B"), "a b");
        // Evidência TS: 'A.B.Cd' -> 'ab cd' (cauda 'C' colada em 'd').
        assert_eq!(normalize_title("A.B.Cd"), "ab cd");
        // Evidência TS: collapseAcronyms('U.S.Marshals') -> 'US Marshals'.
        assert_eq!(collapse_dotted_acronyms("U.S.Marshals"), "US Marshals");
        // Ponto técnico (1 dupla) não é sigla.
        assert_eq!(normalize_title("H.264 x264"), "h 264 x264");
    }

    #[test]
    fn preserva_marcas_fora_da_faixa_removida() {
        // Evidência TS: 'すずめ' -> 'すす\u{3099}め' (dakuten U+3099 preservado).
        assert_eq!(normalize_title("すずめ"), "すす\u{3099}め");
        assert!(is_removed_compat('\u{0301}'));
        assert!(!is_removed_compat('\u{3099}'));
    }

    #[test]
    fn fold_e_caixa_seguem_o_oracle() {
        // Evidência TS: 'İstanbul' -> 'istanbul' (İ -> i + U+0307, removido).
        assert_eq!(normalize_title("İstanbul"), "istanbul");
        // Números Unicode são \p{N}: sobrevivem.
        assert_eq!(normalize_title("１２３"), "１２３");
        // Sigma final é contexto de caixa: Rust e JS concordam (verificado).
        assert_eq!(normalize_title("ΣΣ σ"), "σς σ");
    }

    /// Guarda do pin: se toolchain/dep regredirem de tabela Unicode, falha aqui
    /// antes de divergir em silêncio do oráculo Node 17. `unicode-properties`
    /// usa tupla `u64`, os outros `u8`.
    #[test]
    fn tabelas_unicode_do_build_sao_17() {
        assert_eq!(char::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_properties::UNICODE_VERSION, (17, 0, 0));
    }

    /// A régua é General_Category, não `Alphabetic`: U+24B6 (Ⓐ) é Alphabetic
    /// mas NÃO é `\p{L}`. E U+1E6C0/U+10940 são letras NOVAS do Unicode 17 que
    /// o `regex` 16.0.0 lia como não-letras.
    #[test]
    fn classes_unicode_seguem_general_category_17() {
        assert!(!is_letter('\u{24B6}')); // General_Category=So
        assert!('\u{24B6}'.is_alphabetic()); // o motivo de NÃO usar std aqui
        assert!(is_letter('\u{1E6C0}'));
        assert!(is_letter('\u{10940}'));
        assert!(is_letter('\u{A7CE}'));
        assert!(is_word_char('\u{1E6C0}'));
        assert!(is_word_char('\u{20D0}')); // \p{M} preservado
        assert!(!is_word_char('\u{1FAE8}')); // emoji não é L/N/M
    }
}
