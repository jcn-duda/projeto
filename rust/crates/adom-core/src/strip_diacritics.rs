//! Tira só o diacrítico, porte de `stripDiacritics`.
//!
//! O buscador WordPress dos sites BR devolve 0 para qualquer query acentuada
//! ("Extermínio" → 0, "Exterminio" → resultados). Esta função existe para
//! montar essa query: caixa, pontuação, espaços e ordinais (ª º) ficam.
//! `normalize_title` não serve aqui — ela baixa a caixa e troca o resto por
//! espaço, e a query deixaria de ser a que o site indexa.
//!
//! O fold das letras que o NFD não separa (ı turco, Ł, ß, Æ) é o
//! `fold_latin_letters` já portado. A tabela não é copiada.

use unicode_normalization::UnicodeNormalization;

/// Espelho de `stripDiacritics` (`src/utils/title-normalization.ts`).
///
/// Ordem idêntica ao TS: fold, NFD, intervalo U+0300–U+036F. Não baixa a
/// caixa, não troca pontuação por espaço e não remove ª º.
pub fn strip_diacritics(input: &str) -> String {
    crate::title_normalization::fold_latin_letters(input)
        .nfd()
        .filter(|&c| !matches!(c, '\u{0300}'..='\u{036f}'))
        .collect()
}
