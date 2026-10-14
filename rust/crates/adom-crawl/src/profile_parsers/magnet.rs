//! Magnet do raspador: reexporta o núcleo fiel (`br_core::magnet`) e mantém
//! `normalize_magnet_uri` (normalização própria do crawl: lowercase do scheme,
//! espaços → `%20`, decode de entidades). O `extract_magnet` daqui é o do
//! crawl (valida cada candidato com `is_valid_magnet_uri` e normaliza); o do
//! `br_core::magnet::MagnetExtractor` é a factory fiel ao TS (sem validação).
//!
//! Divergências eliminadas (o código local NÃO aceitava o que o TS aceita):
//! - `is_valid_magnet_uri`: só `magnet:`/`MAGNET:`/`Magnet:` literais → agora
//!   usa regex `(?i)^magnet:` (qualquer caixa, como `bludv-parsers.ts:78`).
//! - `magnet_params`: `xl` só `u64` decimal → agora `f64` com `js_number`
//!   (como `redetorrent-parsers.ts:139-149`).
//! - `extract_magnet`: usava o validador fraco → agora delega ao `br_core`.

// Reexporta o núcleo fiel. `is_valid_magnet_uri`, `is_valid_btih_hash`,
// `magnet_params`, `fmt_size`, `extract_magnet_href`, `decode_uri_strict` e
// `b64_decode` passam a ser os do `br_core::magnet` (fiéis ao TS).
pub use crate::br_core::magnet::{
    b64_decode, decode_uri_strict, extract_magnet_href, is_valid_btih_hash, is_valid_magnet_uri,
    magnet_params,
};

use regex::Regex;
use std::sync::OnceLock;

/// Normaliza URI magnet: decodifica entidades HTML, garante `magnet:` minúsculo
/// e substitui espaços no magnet por `%20`. Específico do crawl (o resolver não
/// normaliza — usa o magnet como extraído).
pub fn normalize_magnet_uri(value: &str) -> String {
    let trimmed = value.trim();
    let decoded = crate::br_core::text::decode_entities(trimmed);
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

/// Gate-2 do vacadb cujo `data-link` base64 decodifica para uma URL http(s)
/// — é download direto (Google Drive), não torrent.
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

// ─── Extract Magnet Genérico (crawl) ────────────────────────────────────────

/// Extrai magnet de HTML buscando variáveis JS, atributos customizados, base64
/// data-link, tags `<a href="magnet:...">`, ou menções diretas / codificadas.
/// Cada candidato é validado com `is_valid_magnet_uri` (fiel ao TS) e
/// normalizado com `normalize_magnet_uri` (específico do crawl).
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
