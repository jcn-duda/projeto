//! Porte de `shortNameTailContradicts` (`src/utils/short-name-tail.ts`).
//!
//! Filme de nome de UM token: palavra que nomeia entre o nome e o ano é outra
//! obra ("Monster Hunter 2021" contra o filme "Monster" de 2018). Só entra o
//! caso `prefix` com um token no `run`: o chamador passa `Some(token)` nesse
//! caso e `None` para os demais (`skip`, `no-token` e runs de mais de uma
//! palavra), que o TS trata como "não corta".

use std::collections::HashSet;

use crate::matching_decisions::is_plain_digits;
use crate::matching_tokens::{is_non_latin_token, is_non_naming_token, is_year_token};

/// `true` quando um token estranho ao nome e ao universo aparece entre o nome e
/// o primeiro ano do título.
pub fn short_name_tail_contradicts(
    tokens: &[String],
    name_token: Option<&str>,
    universe: &HashSet<String>,
) -> bool {
    let Some(word) = name_token else {
        return false;
    };
    let Some(start) = tokens.iter().position(|t| t == word) else {
        return false;
    };
    // Avança pelos tokens do nome na ordem em que o nome os traz. Com um único
    // token, só pula rótulo antes do nome. Se o nome não aparece onde deveria,
    // o TS sai do laço sem avançar e segue procurando o ano a partir daqui.
    let mut at = start;
    while at < tokens.len() && tokens[at] != word && is_non_naming_token(&tokens[at]) {
        at += 1;
    }
    if at < tokens.len() && tokens[at] == word {
        at += 1;
    }
    let Some(year_at) = (at..tokens.len()).find(|&i| is_year_token(&tokens[i])) else {
        return false;
    };
    tokens[at..year_at].iter().any(|t| {
        !is_non_naming_token(t)
            && !is_non_latin_token(t)
            && !is_plain_digits(t)
            && !universe.contains(t)
    })
}
