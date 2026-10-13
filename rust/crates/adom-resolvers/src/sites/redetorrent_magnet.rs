//! Magnet do Rede Torrent: validação, token systemads, `dn`/`xl` e tamanho.
//! Port de `isValidMagnetUri`, `extractMagnetHref`, `magnetParams` e `fmtSize`
//! (`resolvers/profiles/bludv-parsers.ts` e `redetorrent-parsers.ts`). Não usa
//! `adom_crawl::profile_parsers::is_valid_magnet_uri`/`magnet_params`: esses
//! divergem do TS (caixa de `magnet:`, espaço em `xt =`, `xl` só inteiro).

use std::sync::LazyLock;

use adom_core::decode_entities;
use adom_crawl::profile_parsers::b64_decode;
use regex::Regex;

static MAGNET_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^magnet:").expect("prefixo do magnet"));
static XT_PARAM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^xt\s*=\s*urn:btih:([^;&\s]+)").expect("parâmetro xt do magnet")
});
static SYSTEMADS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)systemads").expect("marca do protetor"));
static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[?&]token=([^&"']+)"#).expect("token do systemads"));

/// `isValidBtihHash`: 40 hex ou 32 base32 (A-Z2-7), sem diferenciar caixa.
fn is_valid_btih_hash(hash: &str) -> bool {
    let h = hash.trim();
    let hex40 = h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit());
    let base32 = h.len() == 32
        && h.bytes()
            .all(|b| b.is_ascii_alphabetic() || matches!(b, b'2'..=b'7'));
    hex40 || base32
}

/// `isValidMagnetUri`: `magnet:` (sem caixa) e `xt=urn:btih:` de hash válido em
/// QUALQUER posição da query. Um xt inválido derruba o magnet inteiro.
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

/// `decodeURIComponent` estrito: `%` mal formado ou UTF-8 inválido é erro (None).
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

/// `magnetFromSystemadsToken`: o token `?token=<base64>` do protetor vira magnet.
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

/// `extractMagnetHref`: magnet direto no href OU token systemads decodificado.
pub fn extract_magnet_href(href: &str) -> Option<String> {
    let value = decode_entities(href.trim());
    if is_valid_magnet_uri(&value) {
        return Some(value);
    }
    magnet_from_systemads_token(&value)
}

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

/// `magnetParams`: `dn` (URLSearchParams + decodeURIComponent) e `xl` (`|| null`).
/// Um `dn` que não decodifica zera os DOIS, como o `try` do TS.
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

/// `value.toFixed(2).replace(/\.?0+$/, '')`. O `toFixed` do JS arredonda o valor
/// exato e, no empate, sobe (o `{:.2}` do Rust fica no par), então o terceiro
/// dígito da expansão exata decide.
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

/// `fmtSize`: bytes → "1.5 GB" (base 1024). Ausente, não finito ou não positivo é None.
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
