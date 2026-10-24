//! Porte de três guardas de `src/utils/audio-cleanup.ts` que não leem config:
//! `genericDubProvesPt`, `foreignLangNamedForBucket`, `namesForeignDubLanguage`.
//!
//! `names_foreign_dub_language` é a guarda ampla. Ela só NEGA a vaga BR
//! (herança no dedupe e a classificação pt-title-dual). Pode ser generosa
//! porque não apaga nada da conta: quem condena e apaga é a lista mínima,
//! fora deste porte.
//!
//! `MULTI` fica de fora de `foreign_lang_named_for_bucket`. É rótulo de
//! faixas múltiplas, não o nome de um idioma: carrega a faixa original e
//! pode incluir o PT-BR. O contrato de `audioFromTitle` joga isso no balde
//! ambíguo `dual`. Só a guarda ampla acrescenta o token.
//!
//! `ENGLISH` e `ENG` também ficam de fora do balde. Em torrent BR, "Dual
//! Audio English" é PT+EN, não "só inglês". Hindi, Tamil e o resto é que
//! desmentem o dual.

use std::sync::OnceLock;

use regex::Regex;

use crate::matching_vocabulary::JS_SPACE;

/// Idiomas que desmentem `DUB`/`DUBBED` genérico. Sem `SPA`: token curto
/// demais para a lista compartilhada. `ENG` é a exceção de três letras.
const DUB_LANGS: &str = concat!(
    "HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|BENGALI|PUNJABI|MARATHI",
    "|UKR|UKRAINIAN|RUS|RUSSIAN|POLISH|CZECH|SLOVAK|HUNGARIAN|ROMANIAN|BULGARIAN",
    "|GREEK|HEBREW|ARABIC|ARABIAN|PERSIAN|TURKISH|THAI|VIETNAMESE",
    "|MONGOLIAN|AZERBAIJAN|AZERBAIJANI|UZBEK|UZBEKISTAN|KAZAKH|SOVIET",
    "|KOREAN|JAPANESE|CHINESE|MANDARIN|CANTONESE",
    "|GERMAN|FRENCH|TRUEFRENCH|ITALIAN|ITA|SPANISH|ESPANOL|CASTELLANO|LATINO",
    "|DUTCH|SWEDISH|NORWEGIAN|DANISH|FINNISH|ENGLISH|ENG",
);

/// O mesmo núcleo, com `SPA` e sem `ENGLISH|ENG`.
const BUCKET_LANGS: &str = concat!(
    "HINDI|TAMIL|TELUGU|MALAYALAM|KANNADA|BENGALI|PUNJABI|MARATHI",
    "|UKR|UKRAINIAN|RUS|RUSSIAN|POLISH|CZECH|SLOVAK|HUNGARIAN|ROMANIAN|BULGARIAN",
    "|GREEK|HEBREW|ARABIC|ARABIAN|PERSIAN|TURKISH|THAI|VIETNAMESE",
    "|MONGOLIAN|AZERBAIJAN|AZERBAIJANI|UZBEK|UZBEKISTAN|KAZAKH|SOVIET",
    "|KOREAN|JAPANESE|CHINESE|MANDARIN|CANTONESE",
    "|GERMAN|FRENCH|TRUEFRENCH|ITALIAN|ITA|SPANISH|SPA|ESPANOL|CASTELLANO|LATINO",
    "|DUTCH|SWEDISH|NORWEGIAN|DANISH|FINNISH",
);

/// Cirílico do `/[а-яёіїєґў]/i` do JS, com a maiúscula explícita. O `/i` sem
/// flag `u` não faz o case fold Unicode do Rust.
const CYRILLIC: &str = "[\u{0430}-\u{044F}\u{0410}-\u{042F}\u{0451}\u{0401}\u{0456}\u{0457}\u{0454}\u{0491}\u{045E}\u{0406}\u{0407}\u{0404}\u{0490}\u{040E}]";

fn compile(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("padrão de idioma de áudio compila"))
}

/// `\b` do JS sem flag `u`: fronteira ASCII, não a fronteira Unicode do crate.
fn bounded(alts: &str) -> String {
    format!(r"(?-u:\b)(?:{alts})(?-u:\b)")
}

fn foreign_dub_lang_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded(DUB_LANGS)).expect("FOREIGN_DUB_LANG_RE compila"))
}

fn foreign_lang_for_bucket_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&bounded(BUCKET_LANGS)).expect("FOREIGN_LANG_FOR_BUCKET_RE compila")
    })
}

fn cyrillic_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    compile(&RE, CYRILLIC)
}

/// `RUTRACKER_TRANSLIT_RE`. `[A-Za-z]` no lugar de `[A-Z]` com `/i`: o JS não
/// promove letra não-ASCII para ASCII. O `/i` fica só no grupo AVO/MVO/….
/// `\s` é o espaço do JS; `\d` é `[0-9]`.
fn rutracker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let sig = format!("(?i:{})", bounded("AVO|MVO|DVO|SVO|SELEZEN"));
        let pattern = format!(
            r"\[{s}*(?:19|20)[0-9]{{2}}(?:{s}*[\u{{2d}}\u{{2013}}\u{{2014}}]{s}*(?:19|20)[0-9]{{2}})?{s}*,{s}*[A-Za-z]|{sig}",
            s = JS_SPACE,
            sig = sig,
        );
        Regex::new(&pattern).expect("RUTRACKER_TRANSLIT_RE compila")
    })
}

fn lat_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded("LAT")).expect("LAT compila"))
}

fn dubbed_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded("DUBBED")).expect("DUBBED compila"))
}

fn dub_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let pattern = format!(
            r"\[{s}*DUB{s}*\]|\({s}*DUB{s}*\)|{word}",
            s = JS_SPACE,
            word = bounded("DUB"),
        );
        Regex::new(&pattern).expect("marcador DUB compila")
    })
}

fn lat_esp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded("LAT|ESP")).expect("LAT|ESP compila"))
}

fn scene_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // Sem `\b`, como no JS: a grafia casa no meio do token.
    compile(&RE, r"(?i:VFF|VF2|VFQ|VOSTFR|HDLIGHT)")
}

fn multi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&bounded("MULTI")).expect("MULTI compila"))
}

/// Núcleo da guarda de idioma estrangeiro sobre texto já em maiúscula: nome
/// de idioma, cirílico, assinatura rutracker ou o token `LAT`.
fn foreign_dub_guard_hit_upper(t: &str) -> bool {
    cyrillic_re().is_match(t)
        || foreign_dub_lang_re().is_match(t)
        || rutracker_re().is_match(t)
        || lat_re().is_match(t)
}

/// Guarda compartilhada com `hasPtAudioMark` (`audio-cleanup.ts`): `true`
/// quando o texto NOMEIA idioma estrangeiro, está em cirílico, carrega
/// assinatura transliterada do rutracker ou o token `LAT`. É a MESMA guarda
/// que desmente o `DUB` genérico de `generic_dub_proves_pt` — exposta para o
/// porte do path não duplicar listas de idioma.
pub(crate) fn foreign_dub_guard_hit(text: &str) -> bool {
    foreign_dub_guard_hit_upper(&text.to_uppercase())
}

/// `genericDubProvesPt`: `DUB`/`DUBBED` genérico só prova PT na ausência de
/// idioma estrangeiro, cirílico, assinatura do rutracker e `LAT`.
///
/// `LAT` (LATINO, `….LAT.DUB.…`) fica fora da lista compartilhada de
/// propósito: só desmente esta promessa genérica.
pub fn generic_dub_proves_pt(text: &str) -> bool {
    let t = text.to_uppercase();
    !foreign_dub_guard_hit_upper(&t) && (dubbed_re().is_match(&t) || dub_re().is_match(&t))
}

/// `foreignLangNamedForBucket`: nomeia uma língua que não é o português e
/// não é o inglês. `MULTI` não entra — ver o comentário do módulo.
///
/// O strip de diacrítico acontece ANTES do teste. Em JS a letra acentuada
/// não é caractere de palavra, e `\bESP\b` / `\bRUS\b` casavam dentro de
/// "ESPÍRITOS" / "VÍRUS" (A Casa dos Espíritos e Vírus [1080p DUAL] perdiam
/// o BR, 2026-10-01). Sem o acento, ESP e RUS deixam de ser palavra isolada.
pub fn foreign_lang_named_for_bucket(text: &str) -> bool {
    let folded = crate::strip_diacritics(text).to_uppercase();
    foreign_lang_for_bucket_re().is_match(&folded)
        || cyrillic_re().is_match(text)
        || rutracker_re().is_match(text)
        || lat_esp_re().is_match(&folded)
        || scene_re().is_match(text)
}

/// `namesForeignDubLanguage`: a guarda ampla. Reusa o balde e acrescenta
/// `MULTI`, que só nega BR e não afirma um idioma.
pub fn names_foreign_dub_language(text: &str) -> bool {
    foreign_lang_named_for_bucket(text) || multi_re().is_match(&text.to_uppercase())
}
