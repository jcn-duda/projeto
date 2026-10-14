// O `decode_entities` aqui é o de `br_core::text` (15 nomes de
// `resolvers/text.ts`), não o `adom_core` (tabela maior de
// `title-normalization.ts`). Autoridade: os profiles TS que usam
// `stripTags`/`decodeEntities` de `text.ts` (bludv-parsers.ts:1-6,
// redetorrent-parsers.ts:9, vacatorrent-parsers.ts).
use crate::br_core::text::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

// ─── Classificadores de Áudio, Qualidade e Fonte ───────────────────────────

/// Classifica áudio padrão do VacaTorrent ("Português | Inglês" -> dual).
pub fn classify_vaca_audio(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    let has_pt = text.contains("PORTUGUÊS") || text.contains("PORTUGUES");
    let has_foreign = text.contains("INGLÊS")
        || text.contains("INGLES")
        || text.contains("ESPANHOL")
        || text.contains("JAPONÊS")
        || text.contains("COREANO")
        || text.contains("LEGENDAD")
        || text.contains("ORIGINAL");
    if has_pt {
        if has_foreign {
            Some("dual")
        } else {
            Some("dublado")
        }
    } else if has_foreign {
        Some("legendado")
    } else {
        None
    }
}

/// Classifica áudio geral por marcadores de texto.
pub fn classify_audio_general(context: &str) -> Option<&'static str> {
    let text = context.to_uppercase();
    if text.contains("LEGENDAD") || text.contains("[LEG]") || text.contains("(LEG)") {
        return Some("legendado");
    }
    if text.contains("DUAL ÁUDIO")
        || text.contains("DUAL AUDIO")
        || text.contains("DUAL-AUDIO")
        || text.contains("DUAL-ÁUDIO")
        || text.contains("AUDIO DUPLO")
        || text.contains("ÁUDIO DUPLO")
        || text.contains("DUPLO AUDIO")
        || text.contains("DUPLO ÁUDIO")
    {
        return Some("dual");
    }
    if text.contains("DUBLAD")
        || text.contains(" DUB ")
        || text.contains("[DUB]")
        || text.contains("(DUB)")
        || text.contains("NACIONAL")
        || text.contains("PORTUGUÊS")
        || text.contains("PORTUGUES")
    {
        return Some("dublado");
    }
    None
}

/// Classe de espaços do `\s` do JS (ES2018+): inclui U+FEFF e EXCLUI U+0085
/// (NEL) — o inverso do `\s` Unicode do regex crate. Substitui o `\s` para
/// paridade exata com o oráculo TS (`FULL\u{FEFF}HD`→1080, `FULL\u{0085}HD`→720).
const JS_SPACE: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// Normaliza qualidade de vídeo para resolução numérica (2160, 1080, 720, 576, 480).
///
/// Paridade com o `normalizeQuality` do JS:
/// - fronteiras ASCII, como o `\b` do JS: `toUpperCase` mantém letras acentuadas
///   fora de `[A-Za-z0-9_]`, então `çHD`/`Ñ4K` classificam. SEM `(?i)`: o input já
///   passa por `to_uppercase` e o case-fold Unicode incluiria U+212A (KELVIN), que
///   o `i` não-Unicode do JS não folda;
/// - espaços na classe JS (`JS_SPACE`), não no `\s` Unicode do regex crate;
/// - `FULL\s*HD` cobre "FULLHD" sem espaço, por isso a classificação do token usa
///   prefixo e não comparação textual exata.
pub fn normalize_quality(context: &str) -> Option<u32> {
    static RE: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        let pattern = format!(
            r"(?<![A-Za-z0-9_])(2160[{ws}]*P|4K|UHD|1080[{ws}]*P|FULL[{ws}]*HD|720[{ws}]*P|(?<![A-Za-z0-9_])HD(?![A-Za-z0-9_])(?![{ws}]*TV)|576[{ws}]*P|480[{ws}]*P|(?<![A-Za-z0-9_])SD(?![A-Za-z0-9_])|\d{{3,4}}[{ws}]*P)(?![A-Za-z0-9_])",
            ws = JS_SPACE
        );
        fancy_regex::Regex::new(&pattern).unwrap()
    });
    let upper = context.to_uppercase();
    let mut last = None;
    static RE_P: OnceLock<Regex> = OnceLock::new();
    let re_p =
        RE_P.get_or_init(|| Regex::new(&format!(r"^(\d{{3,4}})[{ws}]*P$", ws = JS_SPACE)).unwrap());

    for cap_res in re.captures_iter(&upper) {
        let Ok(cap) = cap_res else { continue };
        let token = cap.get(1).unwrap().as_str().trim();
        if token.starts_with("2160") || token == "4K" || token == "UHD" {
            last = Some(2160);
        } else if token.starts_with("1080") || token.starts_with("FULL") {
            last = Some(1080);
        } else if token.starts_with("720") || token == "HD" {
            last = Some(720);
        } else if token.starts_with("576") {
            last = Some(576);
        } else if token.starts_with("480") || token == "SD" {
            last = Some(480);
        } else if let Some(c) = re_p.captures(token) {
            if let Ok(n) = c[1].parse::<u32>() {
                last = Some(n);
            }
        }
    }
    last
}

/// Extrai qualidade expressa em texto (ex.: "1080p" -> 1080).
pub fn quality_from_text(text: &str) -> Option<u32> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\b(\d{3,4})\s*p\b").unwrap());
    let m = re.captures(text)?;
    m[1].parse::<u32>()
        .ok()
        .and_then(|n| normalize_quality(&format!("{n}p")))
}

/// Normaliza fonte de release (REMUX, BLU-RAY, WEB-DL, WEBRIP, HDTV, CAM).
pub fn normalize_source(context: &str) -> Option<&'static str> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\b(BDREMUX|REMUX|BLU[- ]?RAY|BLRAY|BLURAY|BD\b|BDRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM)\b").unwrap()
    });
    let upper = context.to_uppercase();
    let mut last = None;
    for cap in re.captures_iter(&upper) {
        let token = cap.get(1).unwrap().as_str().trim();
        if token.contains("REMUX") {
            last = Some("REMUX");
        } else if token.contains("BLU") || token.contains("BDRIP") || token == "BD" {
            last = Some("BLU-RAY");
        } else if token.contains("WEB") && token.contains("DL") {
            last = Some("WEB-DL");
        } else if token.contains("WEB") && token.contains("RIP") {
            last = Some("WEBRIP");
        } else if token.contains("HDTV") {
            last = Some("HDTV");
        } else if token.contains("CAM") {
            last = Some("CAM");
        }
    }
    last
}

/// `fmtSize` (`redetorrent-parsers.ts:151-162`): bytes → "1.5 GB" (base 1024).
/// Aceita `f64` para paridade com o `Number()` do TS (que converte qualquer
/// valor, não só inteiro). Ausente, não finito ou não positivo é None.
pub fn fmt_size(bytes: Option<f64>) -> Option<String> {
    let bytes = bytes?;
    if !bytes.is_finite() || bytes <= 0.0 {
        return None;
    }
    let b = bytes;
    let units = ["KB", "MB", "GB", "TB"];
    let mut val = b;
    let mut unit = "B";
    for next in units {
        if val < 1024.0 {
            break;
        }
        val /= 1024.0;
        unit = next;
    }
    let formatted = format!("{val:.2}");
    let trimmed = formatted.trim_end_matches('0').trim_end_matches('.');
    Some(format!("{trimmed} {unit}"))
}

/// Remove tags HTML e decodifica entidades.
pub fn strip_tags(value: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let stripped = re.replace_all(value, " ");
    let decoded = decode_entities(&stripped);
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}
