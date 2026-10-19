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
use crate::matching_vocabulary::{episode_mark_test, episode_token_test};

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

/// Palavras de temporada/episódio que DELIMITAM a identidade: da primeira em
/// diante o texto pertence ao episódio/pack, não à obra. O corte de cauda
/// numérico precisa disto porque "24 S01E01 12:00 PM" e "9-1-1 S01E01 Kids
/// Today" têm conteúdo legítimo depois do marcador.
const SEASON_EPISODE_WORDS: &[&str] = &[
    "season",
    "seasons",
    "temporada",
    "temporadas",
    "episode",
    "episodes",
    "episodio",
    "episodios",
    "capitulo",
    "capitulos",
    "chapter",
    "chapters",
];

/// Etiquetas de idioma/plataforma e ordinais de temporada que podem seguir um
/// nome numérico sem nomear outra obra ("3% Primeira Temporada", "24 First
/// Season"). Qualidade, áudio, fonte e resolução já estão em
/// `is_non_naming_token` (RELEASE_NOISE/PACK_WORDS/estrutura).
const NUMERIC_TAIL_LABELS: &[&str] = &[
    "english", "ingles", "spanish", "espanhol", "japanese", "japones", "french", "frances",
    "german", "alemao", "italian", "italiano", "korean", "coreano", "chinese", "chines", "russian",
    "russo", "hindi", "netflix", "primeira", "segunda", "terceira", "quarta", "quinta", "sexta",
    "setima", "oitava", "nona", "decima", "ultima", "first", "second", "third", "fourth", "fifth",
    "sixth", "seventh", "eighth", "ninth", "tenth", "last", "final",
];

fn is_identity_tail_boundary(token: &str) -> bool {
    SEASON_EPISODE_WORDS.contains(&token) || episode_token_test(token) || episode_mark_test(token)
}

fn is_identity_tail_tag(token: &str) -> bool {
    is_non_naming_token(token) || is_year_token(token) || NUMERIC_TAIL_LABELS.contains(&token)
}

/// Identidade COMPLETA de nome numérico/pontuado (`3%` → `3`, `24`,
/// `9-1-1` → `9 1 1`, `11.22.63` → `11 22 63`).
///
/// O `matchesName` só exige 60% da base; para um nome que virou um único
/// número, isso aprova qualquer título que contenha o número ("3 Body
/// Problem" para "3%"). Aqui o `run` é a sequência INTEIRA do nome, na ordem
/// e com a multiplicidade originais (`9-1-1` não vira `9 1`), e precisa abrir
/// o título depois de rótulos de release. Depois dela só passam etiquetas
/// (S/E, temporada, ano, idioma, qualidade) — o primeiro token de CONTEÚDO
/// antes do marcador de episódio/temporada nomeia outra obra.
pub(crate) fn numeric_identity_matches(tokens: &[String], run: &[String]) -> bool {
    if run.is_empty() {
        return false;
    }
    // Rótulos antes do nome (uploader, fonte, resolução) não são identidade;
    // conteúdo latino antes do run é outra obra e não vira passe.
    let mut at = 0;
    while at < tokens.len() && tokens[at] != run[0] {
        if !is_non_naming_token(&tokens[at]) {
            return false;
        }
        at += 1;
    }
    if tokens.get(at..at + run.len()) != Some(run) {
        return false;
    }
    for token in &tokens[at + run.len()..] {
        let token = token.as_str();
        if is_identity_tail_boundary(token) {
            return true;
        }
        if !is_identity_tail_tag(token) {
            return false;
        }
    }
    true
}
