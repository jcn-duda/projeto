//! Porte de `titleTokens` (`src/utils/matching-vocabulary.ts`) — fatia de
//! vocabulário da migração TS→Rust.
//!
//! Escopo desta fatia: SÓ a função `titleTokens`. As constantes de vocabulário
//! (`PACK_WORDS`, `TECH_NOISE`, `YEAR_RANGE`, …) ainda não são portadas; entram
//! em fatias próprias, cada uma com seu golden.
//!
//! `titleTokens` normaliza o texto e devolve os tokens não vazios, tirando o
//! `v` que abrevia "Versão" quando colado numa palavra de edição
//! ("Apocalypse Now V.Exten"). O `v` sozinho é obra ("V de Vingança") e fica.

use crate::title_normalization::normalize_title;

/// Palavras de edição que, logo após um `v`, fazem o `v` virar abreviação.
const EDITION_AFTER_V: [&str; 4] = ["exten", "extended", "estendida", "extendida"];

/// Tokens normalizados e não vazios de um texto de título.
///
/// Como no TS, a regra do `v` consulta o token ORIGINAL seguinte (antes de
/// qualquer filtragem), por isso o `v` é avaliado contra a lista completa.
pub fn title_tokens(text: &str) -> Vec<String> {
    let tokens: Vec<String> = normalize_title(text)
        .split(' ')
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect();
    tokens
        .iter()
        .enumerate()
        .filter(|(i, token)| {
            let next = tokens.get(i + 1).map(String::as_str);
            !(token.as_str() == "v" && next.is_some_and(|n| EDITION_AFTER_V.contains(&n)))
        })
        .map(|(_, token)| token.clone())
        .collect()
}
