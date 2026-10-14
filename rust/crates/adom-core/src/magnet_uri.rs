//! Porte de `sanitizeMagnet` e `defaultMagnet` (`src/utils/magnet-uri.ts`).
//!
//! Valida o hash pelo `xt=urn:btih:`, descarta trackers com credencial,
//! deduplica e remonta a URI com `xt`, `dn` e `tr` sob teto de
//! `MAX_URI_BYTES`. Toda a varredura é manual sobre ASCII, sem regex, porque
//! as regras do JS (`/i` restrito a ASCII, `split`, `indexOf`) são mais
//! simples de reproduzir byte a byte assim.

use crate::info_hash::extract_info_hash;
use crate::js_text::{
    js_decode_uri_component, js_encode_char, js_encode_uri_component, js_trim, safe_decode,
};

const MAX_URI_BYTES: i64 = 2048;

/// Piso de trackers do magnet padrão (`TRACKERS` de search-names.ts). Os seis
/// vêm do TS; o golden `magnet-uri` confere a saída contra o dist.
const TRACKERS: [&str; 6] = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
];

/// Nomes de parâmetro que carregam credencial (`CREDENTIAL_PARAM`).
const CREDENTIAL_NAMES: [&str; 13] = [
    "passkey",
    "pass_key",
    "authkey",
    "auth_key",
    "token",
    "torrent_pass",
    "apikey",
    "api_key",
    "auth",
    "pid",
    "key",
    "uid",
    "secure",
];

/// Prefixo de tracker do piso, em `&tr=` e já percent-encoded.
fn floor_suffix() -> String {
    TRACKERS
        .iter()
        .map(|t| format!("&tr={}", js_encode_uri_component(t)))
        .collect()
}

/// Magnet padrão de um hash (`defaultMagnet`).
pub fn default_magnet(info_hash: &str) -> String {
    format!("magnet:?xt=urn:btih:{info_hash}{}", floor_suffix())
}

/// Valor de um parâmetro `[?&]name=` com `name` sem distinção de caixa (ASCII).
/// Com `allow_empty`, o valor pode ser vazio (`[^&]*`); senão exige um byte
/// (`[^&]+`). Devolve os valores na ordem do texto, sem sobreposição.
fn param_values<'a>(text: &'a str, name: &str, allow_empty: bool) -> Vec<&'a str> {
    let b = text.as_bytes();
    let key = format!("{name}=");
    let key = key.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let delimiter = matches!(b[i], b'?' | b'&');
        let start = i + 1;
        if delimiter
            && start + key.len() <= b.len()
            && b[start..start + key.len()].eq_ignore_ascii_case(key)
        {
            let value_start = start + key.len();
            let end = b[value_start..]
                .iter()
                .position(|&c| c == b'&')
                .map_or(b.len(), |p| value_start + p);
            if allow_empty || end > value_start {
                out.push(&text[value_start..end]);
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// `btihFromXt`: hash do primeiro `xt=urn:btih:` válido. Outro esquema
/// (ed2k, sha1) não conta, e `btih:` em `dn` não forja a identidade.
fn btih_from_xt(raw: &str) -> Option<String> {
    for value in param_values(raw, "xt", false) {
        let value = safe_decode(value);
        // Por bytes: um caractere multibyte no meio não pode cortar o texto.
        let head = value.as_bytes().get(..9);
        if !head.is_some_and(|h| h.eq_ignore_ascii_case(b"urn:btih:")) {
            continue;
        }
        if let Some(hash) = extract_info_hash(&value) {
            return Some(hash);
        }
    }
    None
}

/// `strip` do JS: remove `scheme://host` do começo do texto, se houver.
/// Equivale a `replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')`.
fn strip_scheme_host(text: &str) -> &str {
    let b = text.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphabetic) {
        return text;
    }
    let scheme_end = b[1..]
        .iter()
        .position(|&c| !(c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-')));
    let Some(off) = scheme_end else {
        return text;
    };
    let at = 1 + off;
    if b.get(at) != Some(&b':') || b.get(at + 1) != Some(&b'/') || b.get(at + 2) != Some(&b'/') {
        return text;
    }
    let host_end = b[at + 3..]
        .iter()
        .position(|&c| matches!(c, b'/' | b'?' | b'#'))
        .map_or(b.len(), |p| at + 3 + p);
    &text[host_end..]
}

/// `/^[A-Za-z0-9_-]{16,}$/`: segredo genérico de passkey, token ou UUID.
fn is_long_token(s: &str) -> bool {
    s.len() >= 16
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// `trackerHasCredential`: nome de parâmetro privado com qualquer valor, ou
/// segmento de caminho e valor de query com 16+ chars de segredo.
fn tracker_has_credential(tr: &str) -> bool {
    let decoded = safe_decode(tr);
    let d = decoded.as_bytes();
    for i in 0..d.len() {
        if !matches!(d[i], b'?' | b'&') {
            continue;
        }
        for name in CREDENTIAL_NAMES {
            let end = i + 1 + name.len();
            if end < d.len()
                && d[i + 1..end].eq_ignore_ascii_case(name.as_bytes())
                && d[end] == b'='
            {
                return true;
            }
        }
    }
    let path_and_query = strip_scheme_host(&decoded);
    // `split(/[?#]/)`: o caminho é antes do primeiro delimitador, e a query é o
    // pedaço seguinte, até o segundo delimitador.
    let (path, rest) = match path_and_query.find(['?', '#']) {
        Some(p) => (&path_and_query[..p], &path_and_query[p + 1..]),
        None => (path_and_query, ""),
    };
    let query = rest.find(['?', '#']).map_or(rest, |p| &rest[..p]);
    if path.split('/').any(is_long_token) {
        return true;
    }
    query.split('&').any(|kv| {
        let value = match kv.find('=') {
            Some(eq) => &kv[eq + 1..],
            None => kv,
        };
        is_long_token(value)
    })
}

/// `fitDn`: ajusta o `dn` (já codificado) a `max` bytes. Cabe inteiro, mantém o
/// encoding. Senão decodifica e recodifica por code point até o limite, sem
/// partir um `%XX` nem um caractere multibyte. Escape quebrado vira vazio.
fn fit_dn(encoded: &str, max: usize) -> String {
    if encoded.len() <= max {
        return encoded.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let Some(decoded) = js_decode_uri_component(encoded) else {
        return String::new();
    };
    let mut out = String::new();
    for c in decoded.chars() {
        let piece = js_encode_char(c);
        if out.len() + piece.len() > max {
            break;
        }
        out.push_str(&piece);
    }
    out
}

/// `sanitizeMagnet`: `None` quando a URI não é válida para o hash, ou quando o
/// resultado equivale ao magnet padrão (não vale guardar).
pub fn sanitize_magnet(uri: Option<&str>, info_hash: &str) -> Option<String> {
    let raw = js_trim(uri.unwrap_or(""));
    if !raw.starts_with("magnet:?") {
        return None;
    }
    let btih = btih_from_xt(raw)?;
    if btih != info_hash.to_ascii_lowercase() {
        return None;
    }

    let dn_value = param_values(raw, "dn", true).into_iter().next();

    // Trackers do post: sem credencial, deduplicados, e sem os que já estão no
    // piso (que é acrescentado por inteiro no fim).
    let mut seen: Vec<String> = Vec::new();
    let mut post_trackers: Vec<String> = Vec::new();
    for tr in param_values(raw, "tr", false) {
        if tracker_has_credential(tr) {
            continue;
        }
        let decoded = safe_decode(tr);
        if TRACKERS.contains(&decoded.as_str()) || seen.contains(&decoded) {
            continue;
        }
        seen.push(decoded);
        post_trackers.push(format!("tr={tr}"));
    }

    // Piso reservado por inteiro; o resto do teto é dividido entre o `dn` e os
    // trackers do post. O corte é por byte, e o `dn` é o primeiro a ceder.
    let xt = format!("magnet:?xt=urn:btih:{btih}");
    let floor = floor_suffix();
    let mut available = MAX_URI_BYTES - xt.len() as i64 - floor.len() as i64;

    let mut dn = String::new();
    if let Some(value) = dn_value {
        let max = (available - "&dn=".len() as i64).max(0) as usize;
        let fitted = fit_dn(value, max);
        // `dn=` vazio original é preservado; truncado até zero vira omissão.
        if !fitted.is_empty() || value.is_empty() {
            dn = format!("&dn={fitted}");
            available -= dn.len() as i64;
        }
    }

    let mut extra = String::new();
    for tr in &post_trackers {
        let piece = format!("&{tr}");
        // Tracker grande demais não bloqueia um menor depois.
        if piece.len() as i64 > available {
            continue;
        }
        extra.push_str(&piece);
        available -= piece.len() as i64;
    }

    let result = format!("{xt}{dn}{extra}{floor}");
    if result == default_magnet(&btih) {
        return None;
    }
    Some(result)
}
