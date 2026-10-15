//! Texto e padrões do seletor, com a paridade do regex JS sem flag `u`.
//!
//! Disciplina de `episode_parse`: `\d` é `[0-9]`, `\s` é a classe `SP`, `\b` é
//! ASCII. Padrão com `/i` casa no `js_canon` (maiúsculas), nunca com `(?i)`.

use std::sync::OnceLock;

use fancy_regex::Regex;

use crate::br_origin::js_canon;
use crate::episode_parse::{parse_title_season_episode, ParsedSeasonEpisode};

/// Espaços do `\s` do ECMAScript, como conteúdo de classe.
const SP: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

pub(super) const WB_BEFORE: &str = r"(?<![A-Z0-9_])";
pub(super) const WB_AFTER: &str = r"(?![A-Z0-9_])";

const SITE_DOMAIN: &str =
    r"[A-Z0-9][A-Z0-9-]*\.(?:COM|NET|ORG|TV|TO|ME|CC|INFO|XYZ|BIZ|BR|IO|SE|WS)(?:\.[A-Z]{2})?";

pub(super) fn compile(pat: &str) -> Regex {
    let src = pat.replace("__SP__", SP);
    Regex::new(&src).unwrap_or_else(|err| panic!("padrão de arquivo não compila ({pat}): {err}"))
}

fn matched(re: &Regex, text: &str) -> bool {
    re.is_match(text).expect("regex de arquivo executa")
}

pub(super) fn matched_i(re: &Regex, text: &str) -> bool {
    matched(re, &js_canon(text))
}

/// `Number(size || 0)`: 0 e NaN viram 0; infinito continua (é truthy no JS).
pub(super) fn js_size(size: f64) -> f64 {
    if size.is_nan() || size == 0.0 {
        0.0
    } else {
        size
    }
}

/// Último segmento. `split(/[/\\]/).pop()` — barra final vira string vazia.
pub fn base_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// `String.slice` em unidades UTF-16. Os nomes do seletor são BMP; um corte
/// no meio de um par astral cai no prefixo por `char` (não há órfão no pool).
pub(super) fn js_slice(text: &str, max_units: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max_units).collect();
    String::from_utf16(&units).unwrap_or_else(|_| text.chars().take(max_units).collect())
}

/// Troca casamentos no texto original. Com `canon`, o padrão (maiúsculo) corre
/// no `js_canon` e os índices voltam pelo caractere: o canon é 1:1.
fn replace_at(text: &str, re: &Regex, repl: &str, canon: bool) -> String {
    let subject = if canon {
        js_canon(text)
    } else {
        text.to_string()
    };
    let chars: Vec<char> = text.chars().collect();
    debug_assert_eq!(subject.chars().count(), chars.len());
    let mut out = String::new();
    let mut last = 0usize;
    for found in re.find_iter(&subject) {
        let found = found.expect("regex de arquivo executa");
        if found.start() == found.end() {
            continue;
        }
        let start = subject[..found.start()].chars().count();
        let end = subject[..found.end()].chars().count();
        if start < last {
            continue;
        }
        out.extend(chars[last..start].iter().copied());
        out.push_str(repl);
        last = end;
    }
    out.extend(chars[last..].iter().copied());
    out
}

fn video_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"\.(MKV|MP4|AVI|MOV|M4V|TS|WEBM)$").expect("extensão de vídeo"))
}

fn sample_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"(^|[^A-Z])SAMPLE([^A-Z]|$)").expect("sample"))
}

fn extra_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // `b[oô]nus` vira `B[OÔ]NUS` porque o canon já dobrou o acento.
    CELL.get_or_init(|| {
        Regex::new(r"(^|[^A-Z])(EXTRAS?|B[OÔ]NUS|BONUS|FEATURETTES?|INTERVIEWS?|ENTREVISTAS?|BEHIND[ ._-]?THE[ ._-]?SCENES|TRAILERS?|DELETED[ ._-]?SCENES?|CENAS[ ._-]?DELETADAS|BLOOPERS?|GAGS?|MAKING[ ._-]?OF)([^A-Z]|$)")
            .expect("extra")
    })
}

fn extras_disc_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        let pat = format!(
            r"(?:{wb}SCENE[__SP__._-]*#?[__SP__]*[0-9]|{wb}CONVERSATION[__SP__._-]+WITH{wa}|{wb}COMMENTARY{wa}|{wb}COMENT[AÁ]RIOS?{wa}|{wb}INSIDE[__SP__._-]+THE[__SP__._-]+EPISODE{wa})",
            wb = WB_BEFORE,
            wa = WB_AFTER,
        );
        compile(&pat)
    })
}

fn uploader_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(r"(?:^|[^A-Z])(?:UPLOADER|PROMO|TRAILER)(?:[^A-Z]|$)").expect("uploader")
    })
}

fn audio_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // "5.1" não é episódio. O lookbehind poupa DTS/Atmos: o `S` colado é
    // temporada falsa do parser, e quem a apaga é o replace seguinte.
    CELL.get_or_init(|| Regex::new(r"(?<![DST])[125678]\.[012](?![0-9])").expect("áudio"))
}

fn resolution_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // Sem `/i`: o `x` é minúsculo de propósito. 1920X1080 não é esta limpeza.
    CELL.get_or_init(|| {
        Regex::new(r"(?<![A-Za-z0-9_])[0-9]{3,4}x[0-9]{3,4}(?![A-Za-z0-9_])").expect("resolução")
    })
}

fn glued_season_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // "DTS5" lia S5. O `D` no lookahead negativo existe porque `/i` dobra `[\de]`.
    CELL.get_or_init(|| Regex::new(r"[A-Z]S[0-9]{1,2}(?![0-9DE])").expect("temporada colada"))
}

fn year_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        Regex::new(r"(?:^|[^0-9])((?:19|20)[0-9]{2})(?![xX×][0-9])(?=$|[^0-9])").expect("ano")
    })
}

fn ext_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"\.[A-Z0-9]{2,4}$").expect("extensão curta"))
}

fn decor_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // Mesmo conjunto do TS `[\s[\](){}._-]`, em escapes: o fancy-regex
    // recusa `[]`/`{}`/`-]` crus dentro da classe.
    CELL.get_or_init(|| {
        compile(r"^[\x5b\x5d\x7b\x7d()._\-__SP__]+|[\x5b\x5d\x7b\x7d()._\-__SP__]+$")
    })
}

fn site_full_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| compile(&format!(r"^(?:WWW[__SP__._-]+)?{SITE_DOMAIN}$")))
}

fn site_prefix_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // Separador depois do TLD é espaço/`_`/`-`, nunca ponto: "Filme.se.algo"
    // tem um token que por acaso é TLD e é arquivo de verdade.
    CELL.get_or_init(|| compile(&format!(r"^(?:WWW[__SP__._-]+)?{SITE_DOMAIN}[__SP___-]")))
}

fn episode_declared_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| {
        let pat = format!(
            r"(?:EPIS[OÓ]DIO|CAP[IÍ]TULO|EP|CAP)[__SP__._-]*([0-9]{{1,4}}){wa}|(?:^|[^A-Z0-9])E[__SP__._-]*([0-9]{{1,3}}){wa}",
            wa = WB_AFTER,
        );
        compile(&pat)
    })
}

fn only_number_ext_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    CELL.get_or_init(|| Regex::new(r"^([0-9]{1,3})\.[A-Z0-9]{2,4}$").expect("nome só número"))
}

fn leading_ordinal_re() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    // Sem `/i`: corre no texto original. Dígito e espaço não mudam com o canon.
    CELL.get_or_init(|| compile(r"^([0-9]{1,3})(?=$|[__SP__._-])"))
}

// pub: o porte de pack-text-totals (e o golden dele) reusa o mesmo
// VIDEO_EXT/SAMPLE do seletor em vez de duplicar os padrões — o TS exporta os
// dois do módulo.
pub fn is_video(path: &str) -> bool {
    matched_i(video_re(), path)
}

pub fn is_sample(path: &str) -> bool {
    matched_i(sample_re(), path)
}

pub(super) fn is_extra(path: &str) -> bool {
    matched_i(extra_re(), path)
}

pub(super) fn is_extras_disc(name: &str) -> bool {
    matched_i(extras_disc_re(), name)
}

pub(super) fn is_uploader_or_promo(path: &str) -> bool {
    matched_i(uploader_re(), path)
}

pub(super) fn clean_audio(text: &str) -> String {
    replace_at(text, audio_re(), " ", true)
}

/// Basename limpo para o parser: áudio, resolução `1920x1080`, temporada colada.
pub(super) fn cleaned_base_for_parse(path: &str) -> String {
    let name = base_name(path);
    let audio = clean_audio(&name);
    let resolution = replace_at(&audio, resolution_re(), " ", false);
    replace_at(&resolution, glued_season_re(), " ", true)
}

pub(super) fn parsed_base(path: &str) -> ParsedSeasonEpisode {
    parse_title_season_episode(&cleaned_base_for_parse(path))
}

/// Anos que o NOME declara. A pasta não entra: "Trilogia (1985-1990)/" é a coleção.
pub(super) fn declared_years(file_path: &str) -> Vec<i64> {
    let name = base_name(file_path);
    let mut out = Vec::new();
    for caps in year_re().captures_iter(&name) {
        let caps = caps.expect("regex de ano executa");
        if let Some(year) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
            out.push(year);
        }
    }
    out
}

/// Propaganda: o nome (sem extensão curta) é só o domínio, ou o domínio abre
/// o nome e o resto é o anúncio (`1XBET.COM_promo_...`).
pub fn is_site_ad(path: &str) -> bool {
    let stripped = strip_short_ext(&base_name(path));
    let trimmed = replace_at(&stripped, decor_re(), "", false);
    let canon = js_canon(&trimmed);
    matched(site_full_re(), &canon) || matched(site_prefix_re(), &canon)
}

fn strip_short_ext(name: &str) -> String {
    let canon = js_canon(name);
    let Some(found) = ext_re().find(&canon).expect("regex de extensão executa") else {
        return name.to_string();
    };
    let start = canon[..found.start()].chars().count();
    name.chars().take(start).collect()
}

pub(super) fn push_unique(values: &mut Vec<i64>, value: i64) {
    if !values.contains(&value) {
        values.push(value);
    }
}

/// Episódios que o próprio basename declara. O número nu só entra quando
/// nenhum marcador explícito casou — senão o "3" de "3 Body Problem" mascara o E2.
pub(super) fn declared_episodes_in(name: &str) -> Vec<i64> {
    let clean = clean_audio(name);
    let mut out = Vec::new();
    let canon = js_canon(&clean);
    for caps in episode_declared_re().captures_iter(&canon) {
        let caps = caps.expect("regex de episódio executa");
        let group = caps.get(1).or_else(|| caps.get(2));
        if let Some(n) = group.and_then(|m| m.as_str().parse::<i64>().ok()) {
            push_unique(&mut out, n);
        }
    }
    for episode in parse_title_season_episode(&clean).episodes {
        push_unique(&mut out, episode);
    }
    if out.is_empty() {
        if let Some(bare) = bare_leading_ordinal(&clean) {
            push_unique(&mut out, bare);
        }
    }
    out
}

/// Ordinal de abertura só quando é inequívoco: "01.mkv" ou zero-padding.
/// "24", "9-1-1" e "11.22.63" são nome de obra.
fn bare_leading_ordinal(name: &str) -> Option<i64> {
    let canon = js_canon(name);
    if let Some(caps) = only_number_ext_re()
        .captures(&canon)
        .expect("regex de ordinal executa")
    {
        let n = caps.get(1)?.as_str().parse::<i64>().ok()?;
        // `Number(x) || null`: zero não é episódio.
        return (n != 0).then_some(n);
    }
    let caps = leading_ordinal_re()
        .captures(name)
        .expect("regex de ordinal executa")?;
    let token = caps.get(1)?.as_str();
    if token.len() >= 2 && token.as_bytes().first() == Some(&b'0') {
        let n = token.parse::<i64>().ok()?;
        return (n >= 1).then_some(n);
    }
    None
}
