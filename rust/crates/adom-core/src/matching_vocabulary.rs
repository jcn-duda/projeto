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

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

use crate::latin_table::is_latin_or_mark;
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

// Constantes de vocabulário, transcritas do TS como as MESMAS strings separadas
// por espaço (mesma ordem da fonte). O golden de `vocabulary_contents` prova a
// igualdade de conteúdo: qualquer erro de transcrição aparece como divergência.
const PACK_WORDS: &str = "colecao coletanea trilogia saga duologia quadrilogia pentalogia antologia serie series temporada temporadas todas todos completa completo integral filmes collection complete movies films";
const TECH_NOISE: &str =
    "web dl webdl bluray blu ray webrip bdrip brrip hdtv hdrip rip remux hybrid \
    x264 x265 h264 h265 avc hevc av1 xvid divx 10bit 8bit hdr hdr10 dv sdr imax \
    dts aac ac3 eac3 ddp ddp5 ddp2 dd atmos truehd opus mp3 dual audio nacional multi \
    hmax amzn dsnp atvp pcok crav hulu h \
    us uk ca au nz jp tv \
    torrent torrents download baixar assistir online gratis \
    dublado dublada dublagem legendado legendada legenda opcao opcoes versao estendida extendida \
    exten extended \
    mkv mp4 avi gb mb kb \
    480p 540p 576p 720p 1080p 1440p 2160p 4k uhd sd hd fullhd";
const LINK_WORDS: &str = "de do da das dos e a o os as um uma em no na para por com sobre ate";
const LANG_NOISE: &str = "portugues portuguesa portugueses brasil brasileiro brasileira pt br ptbr";
const WATERMARK_NOISE: &str = "derew www thepiratefilmes fb";
const LEADING_ARTICLES: &str = "o a os as um uma uns umas the an el la los las un una unos unas le les une des il lo gli uno der die das den dem ein eine einen het een";
const SEQUENCE_WORDS: &str = "ressurge ressurgimento renasce renascimento recomeco retorno revanche despertar ascensao origens continuacao rises returns reborn rebirth awakens awakening resurrection resurgence revenge begins origins uprising reloaded revolutions";
const STRONG_PACK_WORDS: &str = "trilogia duologia quadrilogia pentalogia colecao coletanea antologia filmografia filmography trilogy quadrilogy duology tetralogy anthology boxset";
/// Numerais por extenso/romano → dígito, como pares `(palavra, valor)`.
const NUMERAL_CANON: &[(&str, u8)] = &[
    ("ii", 2),
    ("iii", 3),
    ("iv", 4),
    ("v", 5),
    ("vi", 6),
    ("vii", 7),
    ("viii", 8),
    ("ix", 9),
    ("um", 1),
    ("dois", 2),
    ("tres", 3),
    ("quatro", 4),
    ("cinco", 5),
    ("seis", 6),
    ("sete", 7),
    ("oito", 8),
    ("nove", 9),
    ("dez", 10),
    ("one", 1),
    ("two", 2),
    ("three", 3),
    ("four", 4),
    ("five", 5),
    ("six", 6),
    ("seven", 7),
    ("eight", 8),
    ("nine", 9),
    ("ten", 10),
];
/// Fontes das regex exportadas, como no `.source` do JS (sem barras nem flags).
const EPISODE_TOKEN_SOURCE: &str =
    r"^(?:s\d{1,2}(?:e\d{1,3})?|t\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3}|\d{1,2}a)$";
const YEAR_RANGE_SOURCE: &str =
    r"\b(?:19|20)\d{2}(?:\s*[-–—,]\s*|\s+(?:de|a|ate|até)\s+|\s+)(?:19|20)\d{2}\b";

/// Lista ordenada e sem repetição, separada por espaço (formato do golden).
fn sorted_unique(items: impl Iterator<Item = String>) -> String {
    let mut v: Vec<String> = items.collect();
    v.sort();
    v.dedup();
    v.join(" ")
}

fn words(list: &'static str) -> impl Iterator<Item = String> {
    list.split(' ').filter(|w| !w.is_empty()).map(str::to_owned)
}

/// Conteúdo de uma constante de vocabulário, no mesmo formato do oracle TS
/// (`scripts/golden/dump-title-normalization.mjs --fn matching-vocabulary-sets`).
/// `None` para nome desconhecido.
pub fn vocabulary_contents(name: &str) -> Option<String> {
    let link = || words(LINK_WORDS);
    let lang = || words(LANG_NOISE);
    let watermark = || words(WATERMARK_NOISE);
    let tech = || words(TECH_NOISE);
    let pack = || words(PACK_WORDS);
    Some(match name {
        "PACK_WORDS" => sorted_unique(pack()),
        "TECH_NOISE" => sorted_unique(tech()),
        "LINK_WORDS" => sorted_unique(link()),
        "LANG_NOISE" => sorted_unique(lang()),
        "WATERMARK_NOISE" => sorted_unique(watermark()),
        "RELEASE_NOISE" => sorted_unique(tech().chain(link()).chain(lang()).chain(watermark())),
        "LEADING_ARTICLES" => sorted_unique(words(LEADING_ARTICLES)),
        "STOP_AT" => sorted_unique(tech().chain(pack())),
        "NUMERAL_CANON" => {
            let mut pairs: Vec<String> = NUMERAL_CANON
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            pairs.sort();
            pairs.join(" ")
        }
        "SEQUENCE_WORDS" => sorted_unique(words(SEQUENCE_WORDS)),
        "STRONG_PACK_WORDS" => sorted_unique(words(STRONG_PACK_WORDS)),
        "EPISODE_TOKEN" => format!("/{EPISODE_TOKEN_SOURCE}/"),
        "YEAR_RANGE" => format!("/{YEAR_RANGE_SOURCE}/i"),
        _ => return None,
    })
}

/// Espaço no sentido do JS (`\s` sem flag `u`): ASCII, NBSP, os separadores
/// Unicode e o BOM U+FEFF. O `\s` do crate `regex` não inclui o BOM, então a
/// classe é explícita para não divergir.
pub(crate) const JS_SPACE: &str = r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

/// `YEAR_RANGE` (`/…/i`). `\b` é ASCII no JS, por isso `(?-u:\b)`, e `\d` é
/// `[0-9]`, porque `\d` do crate aceita dígitos de outros scripts.
fn year_range_pattern() -> String {
    format!(
        r"(?i)(?-u:\b)(?:19|20)[0-9]{{2}}(?:{s}*[-–—,]{s}*|{s}+(?:de|a|ate|até){s}+|{s}+)(?:19|20)[0-9]{{2}}(?-u:\b)",
        s = JS_SPACE
    )
}

/// `EPISODE_TOKEN` (sem flag `i`: "S01E01" em maiúscula NÃO casa, como no JS).
const EPISODE_TOKEN_PATTERN: &str = r"^(?:s[0-9]{1,2}(?:e[0-9]{1,3})?|t[0-9]{1,2}(?:e[0-9]{1,3})?|e[0-9]{1,3}|[0-9]{1,2}x[0-9]{1,3}|[0-9]{1,2}a)$";

fn year_range_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&year_range_pattern()).expect("YEAR_RANGE compila"))
}

fn episode_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(EPISODE_TOKEN_PATTERN).expect("EPISODE_TOKEN compila"))
}

/// Equivalente a `YEAR_RANGE.test(input)` no JS.
pub fn year_range_test(input: &str) -> bool {
    year_range_re().is_match(input)
}

/// Equivalente a `EPISODE_TOKEN.test(input)` no JS.
pub fn episode_token_test(input: &str) -> bool {
    episode_token_re().is_match(input)
}

/// Monta um conjunto de palavras a partir das listas de vocabulário, uma vez.
fn build_set(parts: &[&'static str]) -> HashSet<&'static str> {
    parts
        .iter()
        .flat_map(|p| p.split(' '))
        .filter(|w| !w.is_empty())
        .collect()
}

macro_rules! vocab_set {
    ($(#[$doc:meta])* $name:ident, [$($part:expr),+ $(,)?]) => {
        $(#[$doc])*
        pub(crate) fn $name() -> &'static HashSet<&'static str> {
            static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
            SET.get_or_init(|| build_set(&[$($part),+]))
        }
    };
}

vocab_set!(/// `PACK_WORDS`.
    pack_words, [PACK_WORDS]);
vocab_set!(/// `STRONG_PACK_WORDS`.
    strong_pack_words, [STRONG_PACK_WORDS]);
vocab_set!(/// `SEQUENCE_WORDS`.
    sequence_words, [SEQUENCE_WORDS]);
vocab_set!(/// `LEADING_ARTICLES`.
    leading_articles, [LEADING_ARTICLES]);
vocab_set!(/// `RELEASE_NOISE` = técnico ∪ ligação ∪ idioma ∪ marca d'água.
    release_noise, [TECH_NOISE, LINK_WORDS, LANG_NOISE, WATERMARK_NOISE]);
vocab_set!(/// `STOP_AT` = técnico ∪ empacotamento.
    stop_at, [TECH_NOISE, PACK_WORDS]);

/// `NUMERAL_CANON[palavra]`: o valor do numeral, se a palavra for um.
pub(crate) fn numeral_value(word: &str) -> Option<u8> {
    NUMERAL_CANON
        .iter()
        .find(|(k, _)| *k == word)
        .map(|(_, v)| *v)
}

/// `EPISODE_MARK_RE` de matching-tokens.ts: marcador composto ou longo.
fn episode_mark_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:s[0-9]{1,2}(?:e[0-9]{1,4})+|[0-9]{1,2}x[0-9]{1,4})$")
            .expect("EPISODE_MARK_RE compila")
    })
}

/// `STRUCTURE_TOKEN_RE` de matching-tokens.ts: só dígito, `x`, ponto ou hífen.
fn structure_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9x.\-]+$").expect("STRUCTURE_TOKEN_RE compila"))
}

pub(crate) fn episode_mark_test(token: &str) -> bool {
    episode_mark_re().is_match(token)
}

pub(crate) fn structure_token_test(token: &str) -> bool {
    structure_token_re().is_match(token)
}

/// `LATIN_LETTER_RE` de matching-tokens.ts (`[\p{Script=Latin}\p{M}]`), por
/// tabela gerada do Unicode 17: ver `latin_table.rs` para o porquê de não usar
/// o crate `regex` aqui.
pub(crate) fn latin_letter_test(token: &str) -> bool {
    token.chars().any(|c| is_latin_or_mark(u32::from(c)))
}
