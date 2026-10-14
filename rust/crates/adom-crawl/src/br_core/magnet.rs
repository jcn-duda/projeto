//! `createMagnetExtractor` de `resolvers/magnet-extract.ts` e validadores
//! fiéis de `resolvers/profiles/bludv-parsers.ts` (isValidMagnetUri,
//! isValidBtihHash, magnetParams, fmtSize, extractMagnetHref,
//! decodeURIComponent estrito). Duas variantes do extrator (R-6, não unificar):
//! BÁSICA (nerd, tdf: o passo codificado exige `xt%3D` e para no `&`) e RICA
//! (bludv, comando, vaca: mais variáveis JS, valor codificado dentro das
//! aspas, `data-download`); o vaca ainda lê o `data-link` em base64 do gate-2.
//!
//! O href entre aspas vai até a aspa: o `dn=` do NerdFilmes tem espaço cru e
//! o corte no espaço perdia nome e trackers (medido 2026-09-28).

use std::sync::LazyLock;

use crate::shared::decode_uri_component;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use super::text::decode_entities;

// ─── Regex do extrator ──────────────────────────────────────────────────────

/// Variante do extrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MagnetExtractor {
    pub encoded_variants: bool,
    pub b64_data_link: bool,
}

/// nerd/tdf.
pub const BASIC: MagnetExtractor = MagnetExtractor {
    encoded_variants: false,
    b64_data_link: false,
};
/// bludv/comando.
pub const RICH: MagnetExtractor = MagnetExtractor {
    encoded_variants: true,
    b64_data_link: false,
};
/// vacatorrent.
pub const VACA: MagnetExtractor = MagnetExtractor {
    encoded_variants: true,
    b64_data_link: true,
};

fn rx(p: &str) -> Regex {
    Regex::new(p).expect("regex do extrator de magnet")
}

static MAGNET_RAW: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet:\?[^"'<>\s]+"#));
// Backreference para a aspa de fechamento: só o fancy-regex tem.
static HREF_MAGNET: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r#"(?i)href\s*=\s*(["'])(magnet:\?[^"'<>]+)\1"#).expect("href magnet")
});
static ENCODED_PREFIX: LazyLock<Regex> = LazyLock::new(|| rx(r"(?i)^magnet%3A%3F"));
static B64_LINK: LazyLock<Regex> =
    LazyLock::new(|| rx(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#));
static B64_MAGNET: LazyLock<Regex> =
    LazyLock::new(|| rx(r"(?i)^magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}"));
static B64_MANGLED: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(r"(?i)^magnet:\?xt=urn:?btih:?([a-f0-9]{40})(?![a-f0-9])").expect("mangled")
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| rx(r"\s+"));

static BASIC_JS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+)["']"#,
    )
});
static BASIC_JS_NAV: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+)["']"#,
    )
});
static BASIC_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    rx(r#"(?i)(?:data-magnet|data-url|data-link|data-href)\s*=\s*["'](magnet:\?[^"']+)["']"#)
});
static BASIC_ENCODED: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet%3A%3Fxt%3D[^"'<>\s&]+"#));

static RICH_JS_VAR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_JS_NAV: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_ATTR: LazyLock<Regex> = LazyLock::new(|| {
    rx(
        r#"(?i)(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#,
    )
});
static RICH_ENCODED: LazyLock<Regex> = LazyLock::new(|| rx(r#"(?i)magnet%3A%3F[^"'<>\s]+"#));

// ─── Regex do validador fiel ────────────────────────────────────────────────

static MAGNET_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^magnet:").expect("prefixo do magnet"));
static XT_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)").expect("parâmetro xt do magnet")
});
static SYSTEMADS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)systemads").expect("marca do protetor"));
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[?&]token=([^&"']+)"#).expect("token do systemads"));

// ─── Validadores fiéis (bludv-parsers.ts) ───────────────────────────────────

/// `isValidBtihHash` (`bludv-parsers.ts:67-70`): 40 hex ou 32 base32
/// (alfabeto A-Z2-7), sem diferenciar caixa.
pub fn is_valid_btih_hash(hash: &str) -> bool {
    let h = hash.trim();
    let hex40 = h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit());
    let base32 = h.len() == 32
        && h.bytes()
            .all(|b| b.is_ascii_alphabetic() || matches!(b, b'2'..=b'7'));
    hex40 || base32
}

/// `isValidMagnetUri` (`bludv-parsers.ts:76-89`): `magnet:` (qualquer caixa) e
/// `xt=urn:btih:` de hash válido em QUALQUER posição da query. Um xt inválido
/// derruba o magnet inteiro (retorna false).
pub fn is_valid_magnet_uri(value: &str) -> bool {
    if !MAGNET_PREFIX.is_match(value) {
        return false;
    }
    let query = value.split_once('?').map_or("", |(_, q)| q);
    let mut found = false;
    for param in query.split('&') {
        let Some(caps) = XT_PARAM.captures(param) else {
            continue;
        };
        if !is_valid_btih_hash(&caps[1]) {
            return false;
        }
        found = true;
    }
    found
}

// ─── decodeURIComponent estrito ─────────────────────────────────────────────

/// `decodeURIComponent` estrito: `%` mal formado ou UTF-8 inválido é erro (None).
/// Diferente de `decode_uri_component` (do `shared`), que é mais tolerante.
pub fn decode_uri_strict(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            let value = std::str::from_utf8(hex)
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ─── Base64 tolerante (Buffer.from do Node) ─────────────────────────────────

fn base64_val(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decodifica Base64 tolerante (como `Buffer.from(s, 'base64')` do Node).
/// Caracteres inválidos são ignorados; `=` encerra.
pub fn b64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = base64_val(c) else {
            continue;
        };
        acc = ((acc << 6) | u32::from(v)) & 0xFFF;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

// ─── extractMagnetHref (redetorrent-parsers.ts) ─────────────────────────────

/// `magnetFromSystemadsToken` (`redetorrent-parsers.ts:118-129`): o token
/// `?token=<base64>` do protetor systemads decodifica para o magnet.
fn magnet_from_systemads_token(href: &str) -> Option<String> {
    if !SYSTEMADS.is_match(href) {
        return None;
    }
    let token = TOKEN.captures(href)?.get(1)?.as_str();
    let encoded = decode_uri_strict(token)?;
    let decoded = String::from_utf8_lossy(&b64_decode(&encoded))
        .trim()
        .to_string();
    is_valid_magnet_uri(&decoded).then_some(decoded)
}

/// `extractMagnetHref` (`redetorrent-parsers.ts:133-137`): magnet direto no
/// href OU token systemads decodificado. Tudo que não passa no
/// `isValidMagnetUri` é descartado.
pub fn extract_magnet_href(href: &str) -> Option<String> {
    let value = decode_entities(href.trim());
    if is_valid_magnet_uri(&value) {
        return Some(value);
    }
    magnet_from_systemads_token(&value)
}

// ─── magnetParams e fmtSize (redetorrent-parsers.ts) ────────────────────────

/// `Number(texto)` do JS para o `xl`: espaços, `0x` e decimal. Não numérico é NaN.
fn js_number(text: &str) -> f64 {
    let t = text.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        let valid = !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit());
        return match (valid, u64::from_str_radix(hex, 16)) {
            (true, Ok(v)) => v as f64,
            _ => f64::NAN,
        };
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `magnetParams` (`redetorrent-parsers.ts:139-149`): `dn` (URLSearchParams +
/// decodeURIComponent estrito) e `xl` (`Number() || null`). Um `dn` que não
/// decodifica zera os DOIS, como o `try` do TS.
pub fn magnet_params(magnet: &str) -> (String, Option<f64>) {
    let Ok(url) = url::Url::parse(magnet) else {
        return (String::new(), None);
    };
    let get = |key: &str| {
        url.query_pairs()
            .find(|(k, _)| k.as_ref() == key)
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default()
    };
    let Some(dn) = decode_uri_strict(&get("dn")) else {
        return (String::new(), None);
    };
    let xl = Some(js_number(&get("xl"))).filter(|v| *v != 0.0 && !v.is_nan());
    (dn, xl)
}

/// `value.toFixed(2).replace(/\.?0+$/, '')`. O `toFixed` do JS arredonda o
/// valor exato e, no empate, sobe (o `{:.2}` do Rust fica no par), então o
/// terceiro dígito da expansão exata decide.
fn to_fixed2_trimmed(value: f64) -> String {
    let exact = format!("{value:.60}");
    let (int_part, frac) = exact.split_once('.').unwrap_or((exact.as_str(), ""));
    let digits: Vec<u8> = frac
        .bytes()
        .chain(std::iter::repeat(b'0'))
        .take(3)
        .collect();
    let int_value: u128 = int_part.parse().unwrap_or(0);
    let mut hundredths =
        int_value * 100 + u128::from(digits[0] - b'0') * 10 + u128::from(digits[1] - b'0');
    if digits[2] >= b'5' {
        hundredths += 1;
    }
    let text = format!("{}.{:02}", hundredths / 100, hundredths % 100);
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// `fmtSize` (`redetorrent-parsers.ts:151-162`): bytes → "1.5 GB" (base 1024).
/// Ausente, não finito ou não positivo é None.
pub fn fmt_size(bytes: Option<f64>) -> Option<String> {
    let mut value = bytes.filter(|b| b.is_finite() && *b > 0.0)?;
    let mut unit = "B";
    for next in ["KB", "MB", "GB", "TB"] {
        if value < 1024.0 {
            break;
        }
        value /= 1024.0;
        unit = next;
    }
    Some(format!("{} {unit}", to_fixed2_trimmed(value)))
}

// ─── decodeEncodedValue (auxiliar do extrator) ──────────────────────────────

/// `decodeEncodedValue`: valor `magnet%3A%3F…` é decodificado (malformado
/// fica como está); só `magnet:?` sai.
fn decode_encoded_value(value: &str) -> Option<String> {
    let mut v = value.to_string();
    if ENCODED_PREFIX.is_match(&v) {
        if let Some(decoded) = decode_uri_component(&v) {
            v = decoded;
        }
    }
    v.starts_with("magnet:?").then(|| decode_entities(&v))
}

// ─── MagnetExtractor (createMagnetExtractor do TS) ──────────────────────────

impl MagnetExtractor {
    /// `extractMagnet(html)`.
    pub fn extract(&self, html: &str) -> Option<String> {
        if html.is_empty() {
            return None;
        }
        let (js_var, js_nav, attr, encoded) = if self.encoded_variants {
            (&*RICH_JS_VAR, &*RICH_JS_NAV, &*RICH_ATTR, &*RICH_ENCODED)
        } else {
            (
                &*BASIC_JS_VAR,
                &*BASIC_JS_NAV,
                &*BASIC_ATTR,
                &*BASIC_ENCODED,
            )
        };
        // 1–3. Variável JS, navegação JS e atributo data-*.
        for re in [js_var, js_nav, attr] {
            if let Some(c) = re.captures(html) {
                if !self.encoded_variants {
                    return Some(decode_entities(&c[1]));
                }
                if let Some(m) = decode_encoded_value(&c[1]) {
                    return Some(m);
                }
            }
        }
        // 3.5. data-link em base64 (gate-2 do vacadb).
        if self.b64_data_link {
            if let Some(c) = B64_LINK.captures(html) {
                let raw = SPACES.replace_all(&c[1], "");
                let decoded = String::from_utf8_lossy(&b64_decode(&raw))
                    .trim()
                    .to_string();
                if B64_MAGNET.is_match(&decoded) {
                    return Some(decoded);
                }
                if let Ok(Some(m)) = B64_MANGLED.captures(decoded.as_str()) {
                    return Some(format!("magnet:?xt=urn:btih:{}", m[1].to_lowercase()));
                }
            }
        }
        // 4. href entre aspas: a URI inteira, espaço cru vira %20.
        if let Ok(Some(c)) = HREF_MAGNET.captures(html) {
            let v = decode_entities(&c[2]);
            return Some(SPACES.replace_all(v.trim(), "%20").into_owned());
        }
        // 5. URI crua.
        if let Some(m) = MAGNET_RAW.find(html) {
            return Some(decode_entities(m.as_str()));
        }
        // 6. URI codificada.
        let m = encoded.find(html)?;
        let decoded = decode_uri_component(m.as_str())?;
        decoded
            .starts_with("magnet:?")
            .then(|| decode_entities(&decoded))
    }
}
