use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

// ─── Magnet Helpers ─────────────────────────────────────────────────────────

/// Hash btih válido: 40 hex ou 32 base32 (alfabeto A-Z2-7), case-insensitive.
pub fn is_valid_btih_hash(hash: &str) -> bool {
    let h = hash.trim();
    if h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        return true;
    }
    if h.len() == 32
        && h.chars().all(|c| {
            matches!(c, '0'..='9' | 'a'..='z' | 'A'..='Z')
                && matches!(c, 'a'..='z' | 'A'..='Z' | '2'..='7')
        })
    {
        return true;
    }
    false
}

/// Magnet direto só vale com parâmetro `xt=urn:btih:` de hash válido em qualquer posição.
pub fn is_valid_magnet_uri(value: &str) -> bool {
    let s = value.trim();
    if !s.starts_with("magnet:") && !s.starts_with("MAGNET:") && !s.starts_with("Magnet:") {
        return false;
    }
    let Some(q) = s.find('?') else {
        return false;
    };
    let query = &s[q + 1..];
    let mut found = false;
    for param in query.split('&') {
        let p = param.trim();
        let stripped = if let Some(r) = p.strip_prefix("xt=") {
            r
        } else if let Some(r) = p.strip_prefix("XT=") {
            r
        } else if let Some(r) = p.strip_prefix("xt =") {
            r
        } else {
            continue;
        };
        let val = stripped.trim();
        let hash = if let Some(h) = val.strip_prefix("urn:btih:") {
            h
        } else if let Some(h) = val.strip_prefix("URN:BTIH:") {
            h
        } else {
            continue;
        };
        let clean_hash = hash.split(';').next().unwrap_or(hash).trim();
        if !is_valid_btih_hash(clean_hash) {
            return false;
        }
        found = true;
    }
    found
}

/// Normaliza URI magnet: decodifica entidades HTML, garante `magnet:` minúsculo e
/// substitui espaços no magnet por `%20`.
pub fn normalize_magnet_uri(value: &str) -> String {
    let trimmed = value.trim();
    let decoded = decode_entities(trimmed);
    let with_lower = if decoded.len() >= 7 && decoded[..7].eq_ignore_ascii_case("magnet:") {
        format!("magnet:{}", &decoded[7..])
    } else {
        decoded
    };
    // Substitui espaços soltos por %20
    let mut out = String::with_capacity(with_lower.len());
    let mut in_space = false;
    for c in with_lower.chars() {
        if c.is_whitespace() {
            if !in_space {
                out.push_str("%20");
                in_space = true;
            }
        } else {
            in_space = false;
            out.push(c);
        }
    }
    out
}

/// Extrai parâmetros `dn` e `xl` de um URI magnet.
pub fn magnet_params(magnet: &str) -> (String, Option<u64>) {
    let Ok(parsed) = url::Url::parse(magnet) else {
        return (String::new(), None);
    };
    let mut dn = String::new();
    let mut xl = None;
    for (k, v) in parsed.query_pairs() {
        if k.eq_ignore_ascii_case("dn") {
            dn = v.into_owned();
        } else if k.eq_ignore_ascii_case("xl") {
            xl = v.parse::<u64>().ok();
        }
    }
    (dn, xl)
}

// ─── Base64 Decodificador ───────────────────────────────────────────────────

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

/// Gate-2 do vacadb cujo `data-link` base64 decodifica para uma URL http(s).
pub fn b64_data_link_is_http(html: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re =
        RE.get_or_init(|| Regex::new(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#).unwrap());
    let Some(caps) = re.captures(html) else {
        return false;
    };
    let clean: String = caps[1].chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = b64_decode(&clean);
    if let Ok(decoded) = String::from_utf8(bytes) {
        let d = decoded.trim();
        d.starts_with("http://") || d.starts_with("https://")
    } else {
        false
    }
}

// ─── Extract Magnet Genérico ────────────────────────────────────────────────

/// Extrai magnet de HTML buscando variáveis JS, atributos customizados, base64 data-link,
/// tags `<a href="magnet:...">`, ou menções diretas / codificadas.
pub fn extract_magnet(html: &str) -> Option<String> {
    if html.is_empty() {
        return None;
    }

    // 1. Variáveis JavaScript explícitas
    static RE_JS_VAR: OnceLock<Regex> = OnceLock::new();
    let re_js_var = RE_JS_VAR.get_or_init(|| {
        Regex::new(r#"(?i)(?:DEST_URL|DOWNLOAD_URL|MAGNET_URL|LINK_DOWNLOAD|URL_DOWNLOAD|DOWNLOAD|REDIRECT_URL|NEXT_URL|LINK_FINAL|TARGET_URL|DESTINO|download_url|download_link|magnet_link|target_url|dest|target|link|url|magnet)\s*[:=]\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#).unwrap()
    });
    if let Some(caps) = re_js_var.captures(html) {
        let val = &caps[1];
        let decoded = if val.starts_with("magnet%3A%3F") || val.starts_with("magnet%3a%3f") {
            crate::shared::decode_uri_component(val).unwrap_or_else(|| val.to_string())
        } else {
            val.to_string()
        };
        if is_valid_magnet_uri(&decoded) {
            return Some(normalize_magnet_uri(&decoded));
        }
    }

    // 2. Redirecionamentos / atribuições de navegação JavaScript
    static RE_JS_NAV: OnceLock<Regex> = OnceLock::new();
    let re_js_nav = RE_JS_NAV.get_or_init(|| {
        Regex::new(r#"(?i)(?:(?:window\.|document\.)?location(?:\.href|\.replace|\.assign)?|window\.open)\s*(?:=|\()\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#).unwrap()
    });
    if let Some(caps) = re_js_nav.captures(html) {
        let val = &caps[1];
        let decoded = if val.starts_with("magnet%3A%3F") || val.starts_with("magnet%3a%3f") {
            crate::shared::decode_uri_component(val).unwrap_or_else(|| val.to_string())
        } else {
            val.to_string()
        };
        if is_valid_magnet_uri(&decoded) {
            return Some(normalize_magnet_uri(&decoded));
        }
    }

    // 3. Atributos customizados
    static RE_ATTR: OnceLock<Regex> = OnceLock::new();
    let re_attr = RE_ATTR.get_or_init(|| {
        Regex::new(r#"(?i)(?:data-magnet|data-url|data-link|data-href|data-download)\s*=\s*["'](magnet:\?[^"']+|magnet%3A%3F[^"']+)["']"#).unwrap()
    });
    if let Some(caps) = re_attr.captures(html) {
        let val = &caps[1];
        let decoded = if val.starts_with("magnet%3A%3F") || val.starts_with("magnet%3a%3f") {
            crate::shared::decode_uri_component(val).unwrap_or_else(|| val.to_string())
        } else {
            val.to_string()
        };
        if is_valid_magnet_uri(&decoded) {
            return Some(normalize_magnet_uri(&decoded));
        }
    }

    // 3.5. data-link base64 (gate-2 do vacadb)
    static RE_B64: OnceLock<Regex> = OnceLock::new();
    let re_b64 = RE_B64
        .get_or_init(|| Regex::new(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#).unwrap());
    if let Some(caps) = re_b64.captures(html) {
        let clean: String = caps[1].chars().filter(|c| !c.is_whitespace()).collect();
        let bytes = b64_decode(&clean);
        if let Ok(decoded) = String::from_utf8(bytes) {
            let dec_trim = decoded.trim();
            if is_valid_magnet_uri(dec_trim) {
                return Some(normalize_magnet_uri(dec_trim));
            }
            // Mutilado: magnet:?xt=urnbtih<hash>
            static RE_MANGLED: OnceLock<fancy_regex::Regex> = OnceLock::new();
            let re_mangled = RE_MANGLED.get_or_init(|| {
                fancy_regex::Regex::new(r"(?i)^magnet:\?xt=urn:?btih:?([a-f0-9]{40})(?![a-f0-9])")
                    .unwrap()
            });
            if let Ok(Some(m)) = re_mangled.captures(dec_trim) {
                if let Some(h) = m.get(1) {
                    return Some(format!(
                        "magnet:?xt=urn:btih:{}",
                        h.as_str().to_ascii_lowercase()
                    ));
                }
            }
        }
    }

    // 4. href entre aspas
    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF
        .get_or_init(|| Regex::new(r#"(?i)href\s*=\s*["'](magnet:\?[^"'<>]+)["']"#).unwrap());
    if let Some(caps) = re_href.captures(html) {
        let m = &caps[1];
        if is_valid_magnet_uri(m) {
            return Some(normalize_magnet_uri(m));
        }
    }

    // 5. Magnet cru no documento
    static RE_RAW: OnceLock<Regex> = OnceLock::new();
    let re_raw = RE_RAW.get_or_init(|| Regex::new(r#"(?i)magnet:\?[^"'<>\s]+"#).unwrap());
    if let Some(m) = re_raw.find(html) {
        if is_valid_magnet_uri(m.as_str()) {
            return Some(normalize_magnet_uri(m.as_str()));
        }
    }

    // 6. Magnet URL-encoded no documento
    static RE_ENCODED: OnceLock<Regex> = OnceLock::new();
    let re_encoded =
        RE_ENCODED.get_or_init(|| Regex::new(r#"(?i)magnet%3A%3F[^"'<>\s]+"#).unwrap());
    if let Some(m) = re_encoded.find(html) {
        if let Some(decoded) = crate::shared::decode_uri_component(m.as_str()) {
            if is_valid_magnet_uri(&decoded) {
                return Some(normalize_magnet_uri(&decoded));
            }
        }
    }

    None
}
