//! Parsers dos profiles que os adaptadores usam (parseDownloadLinks, parsePostLinks, parseContentMagnets, etc).
//! Migração fiel de:
//! - `resolvers/profiles/vacatorrent-parsers.ts` e `vacatorrent-shapes.ts`
//! - `resolvers/profiles/apachetorrent-parsers.ts`
//! - `resolvers/profiles/redetorrent-parsers.ts`
//! - `resolvers/profiles/hdrtorrents-parsers.ts`
//! - `resolvers/magnet-extract.ts` e `resolvers/release-format.ts`

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

use adom_core::decode_entities;

/// Botão/link parseado de um post ou página de download.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ResolverLink {
    pub url: String,
    pub quality: Option<u32>,
    pub size: Option<String>,
    pub audio: Option<String>,
    pub episode: Option<u32>,
    pub episode_last: Option<u32>,
    pub season: Option<u32>,
    pub source: Option<String>,
    pub real_title: Option<String>,
    pub description: Option<String>,
}

/// Card de temporada ou batch da página season-internal do VacaTorrent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VacaSeasonCard {
    pub url: String,
    pub is_batch: bool,
    pub season: Option<u32>,
    pub title: String,
}

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
    let re = RE.get_or_init(|| Regex::new(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#).unwrap());
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
    let re_b64 = RE_B64.get_or_init(|| {
        Regex::new(r#"(?i)data-link=["']([A-Za-z0-9+/=]{32,})["']"#).unwrap()
    });
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
                fancy_regex::Regex::new(r"(?i)^magnet:\?xt=urn:?btih:?([a-f0-9]{40})(?![a-f0-9])").unwrap()
            });
            if let Ok(Some(m)) = re_mangled.captures(dec_trim) {
                if let Some(h) = m.get(1) {
                    return Some(format!("magnet:?xt=urn:btih:{}", h.as_str().to_ascii_lowercase()));
                }
            }
        }
    }

    // 4. href entre aspas
    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| {
        Regex::new(r#"(?i)href\s*=\s*["'](magnet:\?[^"'<>]+)["']"#).unwrap()
    });
    if let Some(caps) = re_href.captures(html) {
        let m = &caps[1];
        if is_valid_magnet_uri(m) {
            return Some(normalize_magnet_uri(m));
        }
    }

    // 5. Magnet cru no documento
    static RE_RAW: OnceLock<Regex> = OnceLock::new();
    let re_raw = RE_RAW.get_or_init(|| {
        Regex::new(r#"(?i)magnet:\?[^"'<>\s]+"#).unwrap()
    });
    if let Some(m) = re_raw.find(html) {
        if is_valid_magnet_uri(m.as_str()) {
            return Some(normalize_magnet_uri(m.as_str()));
        }
    }

    // 6. Magnet URL-encoded no documento
    static RE_ENCODED: OnceLock<Regex> = OnceLock::new();
    let re_encoded = RE_ENCODED.get_or_init(|| {
        Regex::new(r#"(?i)magnet%3A%3F[^"'<>\s]+"#).unwrap()
    });
    if let Some(m) = re_encoded.find(html) {
        if let Some(decoded) = crate::shared::decode_uri_component(m.as_str()) {
            if is_valid_magnet_uri(&decoded) {
                return Some(normalize_magnet_uri(&decoded));
            }
        }
    }

    None
}

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

/// Normaliza qualidade de vídeo para resolução numérica (2160, 1080, 720, 576, 480).
pub fn normalize_quality(context: &str) -> Option<u32> {
    static RE: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)\b(2160\s*P|4K|UHD|1080\s*P|FULL\s*HD|720\s*P|\bHD\b(?!\s*TV)|576\s*P|480\s*P|\bSD\b|\d{3,4}\s*P)\b").unwrap()
    });
    let upper = context.to_uppercase();
    let mut last = None;
    static RE_P: OnceLock<Regex> = OnceLock::new();
    let re_p = RE_P.get_or_init(|| Regex::new(r"^(\d{3,4})\s*P$").unwrap());

    for cap_res in re.captures_iter(&upper) {
        let Ok(cap) = cap_res else { continue };
        let token = cap.get(1).unwrap().as_str().trim();
        if token.starts_with("2160") || token == "4K" || token == "UHD" {
            last = Some(2160);
        } else if token.starts_with("1080") || token == "FULL HD" {
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
    m[1].parse::<u32>().ok().and_then(|n| normalize_quality(&format!("{n}p")))
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

/// Formata bytes como tamanho legível ("2.54 GB", "850 MB").
pub fn fmt_size(bytes: Option<u64>) -> Option<String> {
    let bytes = bytes?;
    if bytes == 0 {
        return None;
    }
    let b = bytes as f64;
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

// ─── ApacheTorrent (`parsePostMagnets`) ─────────────────────────────────────

/// Parseia blocos `div.download-block` do ApacheTorrent.
pub fn parse_post_magnets(html: &str, base_url: Option<&str>) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    static RE_BLOCK_SPLIT: OnceLock<Regex> = OnceLock::new();
    let re_block_split = RE_BLOCK_SPLIT.get_or_init(|| {
        Regex::new(r#"(?i)<div[^>]*class=["'][^"']*download-block[^"']*["'][^>]*>"#).unwrap()
    });

    static RE_VERSAO: OnceLock<Regex> = OnceLock::new();
    let re_versao = RE_VERSAO.get_or_init(|| {
        Regex::new(r#"(?i)class=["']download-versao["'][^>]*>([\s\S]*?)</p>"#).unwrap()
    });

    static RE_DESC: OnceLock<Regex> = OnceLock::new();
    let re_desc = RE_DESC.get_or_init(|| {
        Regex::new(r#"(?i)class=["']download-desc["'][^>]*>([\s\S]*?)</p>"#).unwrap()
    });

    static RE_ANCHOR: OnceLock<Regex> = OnceLock::new();
    let re_anchor = RE_ANCHOR.get_or_init(|| {
        Regex::new(r#"(?i)<a\b[\s\S]*?</a>"#).unwrap()
    });

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| {
        Regex::new(r#"(?i)<a\b[^>]*\bhref=["']([^"']+)["']"#).unwrap()
    });

    let mut out = Vec::new();
    let blocks: Vec<&str> = re_block_split.split(html).skip(1).collect();

    for block in blocks {
        let version = re_versao
            .captures(block)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();
        let desc_raw = re_desc
            .captures(block)
            .map(|c| c[1].to_string())
            .unwrap_or_default();
        let desc_no_anchor = re_anchor.replace_all(&desc_raw, " ");
        let desc = strip_tags(&desc_no_anchor);
        let context = format!("{version} {desc}");
        let audio = classify_audio_general(&context);
        let quality = normalize_quality(&context);
        let source = normalize_source(&context);

        let mut desc_parts = Vec::new();
        if !version.is_empty() {
            desc_parts.push(version.as_str());
        }
        if !desc.is_empty() {
            desc_parts.push(desc.as_str());
        }
        let full_desc = if desc_parts.is_empty() {
            None
        } else {
            Some(desc_parts.join(" — "))
        };

        for href_cap in re_href.captures_iter(block) {
            let mut href = decode_entities(&href_cap[1]);
            if let Some(base) = base_url {
                if !href.contains(':') {
                    if let Ok(base_parsed) = url::Url::parse(base) {
                        if let Ok(joined) = base_parsed.join(&href) {
                            href = joined.into();
                        }
                    }
                }
            }
            if !is_valid_magnet_uri(&href) {
                continue;
            }
            let (dn, _) = magnet_params(&href);
            out.push(ResolverLink {
                url: normalize_magnet_uri(&href),
                quality: quality.or_else(|| quality_from_text(&dn)),
                size: None,
                audio: audio.map(String::from),
                source: source.or_else(|| normalize_source(&dn)).map(String::from),
                episode: None,
                episode_last: None,
                season: None,
                real_title: None,
                description: full_desc.clone(),
            });
        }
    }
    out
}

// ─── RedeTorrent (`parsePostLinks`) ─────────────────────────────────────────

fn extract_redetorrent_magnet(href: &str) -> Option<String> {
    let value = decode_entities(href.trim());
    if is_valid_magnet_uri(&value) {
        return Some(normalize_magnet_uri(&value));
    }
    // Token systemads (?token=base64)
    if value.to_lowercase().contains("systemads") {
        static RE_TOKEN: OnceLock<Regex> = OnceLock::new();
        let re_token = RE_TOKEN.get_or_init(|| Regex::new(r#"[?&]token=([^&"']+)"#).unwrap());
        if let Some(c) = re_token.captures(&value) {
            let decoded_url = crate::shared::decode_uri_component(&c[1]).unwrap_or_else(|| c[1].to_string());
            let bytes = b64_decode(&decoded_url);
            if let Ok(decoded_str) = String::from_utf8(bytes) {
                let trimmed = decoded_str.trim();
                if is_valid_magnet_uri(trimmed) {
                    return Some(normalize_magnet_uri(trimmed));
                }
            }
        }
    }
    None
}

fn cell_text(row: &str, class_name: &str) -> String {
    let pattern = format!(r#"(?i)<td class="{class_name}[^"]*"[^>]*>([\s\S]*?)</td>"#);
    if let Ok(re) = Regex::new(&pattern) {
        if let Some(c) = re.captures(row) {
            return strip_tags(&c[1]);
        }
    }
    String::new()
}

/// Parseia tabelas `table.tbl-mv-list` do RedeTorrent.
pub fn parse_post_links(html: &str, base_url: Option<&str>) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    static RE_TABLE: OnceLock<Regex> = OnceLock::new();
    let re_table = RE_TABLE.get_or_init(|| {
        Regex::new(r#"(?i)<table class="tbl-mv-list">[\s\S]*?</table>"#).unwrap()
    });

    static RE_HEADER: OnceLock<Regex> = OnceLock::new();
    let re_header = RE_HEADER.get_or_init(|| {
        Regex::new(r#"(?i)<div class="tf[^"]*">([\s\S]*?)</div>"#).unwrap()
    });

    static RE_ROW: OnceLock<Regex> = OnceLock::new();
    let re_row = RE_ROW.get_or_init(|| {
        Regex::new(r#"(?i)<tr class="tr-mv-list">([\s\S]*?)</tr>"#).unwrap()
    });

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| {
        Regex::new(r#"(?i)<a\s+[^>]*?href\s*=\s*["']([^"']+)["']"#).unwrap()
    });

    static RE_SEASON: OnceLock<Regex> = OnceLock::new();
    let re_season = RE_SEASON.get_or_init(|| Regex::new(r"(?i)^S(\d{1,2})$").unwrap());

    let mut out = Vec::new();

    for table_match in re_table.find_iter(html) {
        let table = table_match.as_str();
        let header_text = re_header
            .captures(table)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();

        for row_cap in re_row.captures_iter(table) {
            let body = &row_cap[1];
            let mut magnet = None;

            for href_cap in re_href.captures_iter(body) {
                let mut href = href_cap[1].to_string();
                if let Some(base) = base_url {
                    if !href.contains(':') {
                        if let Ok(base_parsed) = url::Url::parse(base) {
                            if let Ok(joined) = base_parsed.join(&href) {
                                href = joined.into();
                            }
                        }
                    }
                }
                if let Some(m) = extract_redetorrent_magnet(&href) {
                    magnet = Some(m);
                    break;
                }
            }

            let Some(magnet_url) = magnet else {
                continue;
            };

            let (dn, xl) = magnet_params(&magnet_url);
            let qua = cell_text(body, "td-mv-qua");
            let res = cell_text(body, "td-mv-res");
            let tam = cell_text(body, "td-mv-tam");
            let idi = cell_text(body, "td-mv-idi");
            let leg = cell_text(body, "td-mv-leg");

            let season_num = re_season
                .captures(&qua)
                .and_then(|c| c[1].parse::<u32>().ok());

            let size = if tam.chars().any(|c| c.is_ascii_digit()) {
                Some(tam)
            } else {
                fmt_size(xl)
            };
            let filtered_size = size.filter(|s| !s.to_lowercase().contains("kb"));

            let audio_context = format!("{header_text} {idi} {leg}");
            let audio = classify_audio_general(&audio_context);

            let res_qual = if res.chars().any(|c| c.is_ascii_digit()) {
                normalize_quality(&res)
            } else {
                None
            };
            let quality = res_qual.or_else(|| quality_from_text(&dn));

            let source = if season_num.is_some() {
                None
            } else {
                normalize_source(&format!("{qua} {dn}"))
            };

            out.push(ResolverLink {
                url: magnet_url,
                quality,
                size: filtered_size,
                audio: audio.map(String::from),
                source: source.map(String::from),
                episode: None,
                episode_last: None,
                season: season_num,
                real_title: None,
                description: None,
            });
        }
    }
    out
}

// ─── HDRTorrents (`parseContentMagnets`) ─────────────────────────────────────

fn extract_size_from_tech_sheet(html: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)Tamanho[\s\S]{0,40}?([\d.,]+\s*(?:TB|GB|MB|KB))").unwrap()
    });
    let caps = re.captures(html)?;
    Some(caps[1].replace(',', "."))
}

fn extract_episode_from_name(name: &str) -> Option<u32> {
    static RE_E: OnceLock<Regex> = OnceLock::new();
    let re_e = RE_E.get_or_init(|| Regex::new(r"(?i)\b[Ee](\d{1,3})\b").unwrap());
    if let Some(c) = re_e.captures(name) {
        return c[1].parse::<u32>().ok();
    }
    static RE_EP: OnceLock<Regex> = OnceLock::new();
    let re_ep = RE_EP.get_or_init(|| Regex::new(r"(?i)EPIS[ÓO]DIO\s*(\d+)").unwrap());
    if let Some(c) = re_ep.captures(name) {
        return c[1].parse::<u32>().ok();
    }
    None
}

/// Parseia linhas `.download-row` com magnets diretos do HDRTorrents.
pub fn parse_content_magnets(html: &str, _base_url: Option<&str>) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    static RE_SPLIT: OnceLock<Regex> = OnceLock::new();
    let re_split = RE_SPLIT.get_or_init(|| {
        Regex::new(r#"(?i)<div[^>]*class=["'][^"']*download-row[^"']*["'][^>]*>"#).unwrap()
    });

    static RE_NAME: OnceLock<Regex> = OnceLock::new();
    let re_name = RE_NAME.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*download-name[^"']*"[^>]*>([\s\S]*?)</div"#).unwrap()
    });

    static RE_MAGNET: OnceLock<Regex> = OnceLock::new();
    let re_magnet = RE_MAGNET.get_or_init(|| {
        Regex::new(r#"(?i)<a\b[^>]*href=["'](magnet:[^"']+)["']"#).unwrap()
    });

    let mut out = Vec::new();
    let rows: Vec<&str> = re_split.split(html).skip(1).collect();

    for row in rows {
        let name = re_name
            .captures(row)
            .map(|c| strip_tags(&c[1]))
            .unwrap_or_default();
        let Some(mag_cap) = re_magnet.captures(row) else {
            continue;
        };
        let magnet_raw = decode_entities(&mag_cap[1]);
        if !is_valid_magnet_uri(&magnet_raw) {
            continue;
        }
        let magnet = normalize_magnet_uri(&magnet_raw);
        let (dn, _) = magnet_params(&magnet);

        let audio = classify_audio_general(&name);
        let quality = normalize_quality(&name).or_else(|| normalize_quality(&dn));
        let source = normalize_source(&name).or_else(|| normalize_source(&dn));
        let episode = extract_episode_from_name(&name);

        out.push(ResolverLink {
            url: magnet,
            quality,
            size: None,
            audio: audio.map(String::from),
            source: source.map(String::from),
            episode,
            episode_last: None,
            season: None,
            real_title: None,
            description: if name.is_empty() { None } else { Some(name) },
        });
    }

    if let Some(tech_size) = extract_size_from_tech_sheet(html) {
        for link in &mut out {
            if link.size.is_none() {
                link.size = Some(tech_size.clone());
            }
        }
    }

    out
}

// ─── VacaTorrent Shapes (`vacatorrent-shapes.ts`) ────────────────────────────

/// Filme: página do post → link da página de botões (`/movie-links/<id>/`).
pub fn extract_movie_links(html: &str, base_url: Option<&str>) -> Option<String> {
    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| {
        Regex::new(r#"(?i)href=["']([^"']*\bmovie-links\b[^"']*)["']"#).unwrap()
    });
    static RE_ID: OnceLock<Regex> = OnceLock::new();
    let re_id = RE_ID.get_or_init(|| Regex::new(r"movie-links/(\d+)").unwrap());

    let raw = if let Some(c) = re_href.captures(html) {
        c[1].to_string()
    } else if let Some(c) = re_id.captures(html) {
        format!("/movie-links/{}/", &c[1])
    } else {
        return None;
    };

    if let Some(base) = base_url {
        if let Ok(b) = url::Url::parse(base) {
            if let Ok(joined) = b.join(&raw) {
                return Some(joined.into());
            }
        }
    }
    Some(raw)
}

/// Série: decoding de data-u (base64).
pub fn decode_data_u(html: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?i)data-u\s*=\s*["']([^"']+)["']"#).unwrap());
    let caps = re.captures(html)?;
    let bytes = b64_decode(&caps[1]);
    String::from_utf8(bytes).ok().map(|s| s.trim().to_string())
}

/// Série: link interno da página season-internal.
pub fn series_season_internal_url(html: &str, base_url: Option<&str>) -> Option<String> {
    if let Some(decoded) = decode_data_u(html) {
        if decoded.contains("season-internal") {
            if let Some(base) = base_url {
                if let Ok(b) = url::Url::parse(base) {
                    if let Ok(joined) = b.join(&decoded) {
                        return Some(joined.into());
                    }
                }
            }
            return Some(decoded);
        }
    }

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF.get_or_init(|| Regex::new(r"(?i)season-internal/\?show=\d+").unwrap());
    if let Some(m) = re_href.find(html) {
        let val = m.as_str();
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(val) {
                    return Some(joined.into());
                }
            }
        }
        return Some(val.to_string());
    }

    static RE_SHORT: OnceLock<Regex> = OnceLock::new();
    let re_short = RE_SHORT.get_or_init(|| Regex::new(r"(?i)\?p=(\d{4,})").unwrap());
    if let Some(c) = re_short.captures(html) {
        let path = format!("/pt/season-internal/?show={}", &c[1]);
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(&path) {
                    return Some(joined.into());
                }
            }
        }
        return Some(path);
    }

    None
}

/// Extrai atributo HTML de uma tag.
fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let pattern = format!(r#"(?i)\b{attr}\s*=\s*["']([^"']*)["']"#);
    if let Ok(re) = Regex::new(&pattern) {
        if let Some(c) = re.captures(tag) {
            return Some(c[1].to_string());
        }
    }
    None
}

/// Parseia cards de temporada/batch da página season-internal.
pub fn parse_season_internal(html: &str, base_url: Option<&str>) -> Vec<VacaSeasonCard> {
    static RE_A: OnceLock<Regex> = OnceLock::new();
    let re_a = RE_A.get_or_init(|| Regex::new(r#"(?i)<a\b([^>]*)>([\s\S]*?)</a>"#).unwrap());

    static RE_SEASON_NUM: OnceLock<Regex> = OnceLock::new();
    let re_season_num = RE_SEASON_NUM.get_or_init(|| Regex::new(r"(?i)temporada-(\d+)").unwrap());

    let mut cards = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for cap in re_a.captures_iter(html) {
        let attrs = &cap[1];
        let content = &cap[2];
        let classes = extract_attr(attrs, "class").unwrap_or_default();
        let href = extract_attr(attrs, "href").unwrap_or_default();
        let href = href.trim();
        if href.is_empty() {
            continue;
        }

        let is_batch = classes.contains("sa-card-batch") || href.contains("batch");
        let is_season = classes.contains("sa-card") || href.contains("temporada-");
        if !is_batch && !is_season {
            continue;
        }

        let mut resolved = href.to_string();
        if let Some(base) = base_url {
            if let Ok(b) = url::Url::parse(base) {
                if let Ok(joined) = b.join(href) {
                    resolved = joined.into();
                }
            }
        }

        if !seen.insert(resolved.clone()) {
            continue;
        }

        let season = re_season_num
            .captures(&resolved)
            .and_then(|c| c[1].parse::<u32>().ok())
            .filter(|&s| s > 0);

        cards.push(VacaSeasonCard {
            url: resolved,
            is_batch,
            season,
            title: strip_tags(content),
        });
    }
    cards
}

/// Filtra cards de temporada mantendo batches ou os que casam a temporada solicitada.
pub fn filter_season_cards(
    cards: &[VacaSeasonCard],
    requested_season: Option<u32>,
) -> Vec<VacaSeasonCard> {
    let Some(wanted) = requested_season else {
        return cards.to_vec();
    };
    cards
        .iter()
        .filter(|c| c.season.is_none() || c.season == Some(wanted))
        .cloned()
        .collect()
}

/// Repara entidades destruídas (ex.: "4ordf" -> "4ª", "4ordm" -> "4º").
pub fn repair_mangled_entities(value: &str) -> String {
    static RE_ORDF: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_ordf = RE_ORDF.get_or_init(|| fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordf(?![a-z0-9])").unwrap());
    static RE_ORDM: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_ordm = RE_ORDM.get_or_init(|| fancy_regex::Regex::new(r"(?i)(?<![a-z])(\d{1,2})\s*ordm(?![a-z0-9])").unwrap());

    let s1 = re_ordf.replace_all(value, "${1}ª");
    let s2 = re_ordm.replace_all(&s1, "${1}º");
    s2.into_owned()
}

/// Normaliza o título de um batch: remove prefixo "BATCH – ", repara entidades.
pub fn normalize_batch_title(raw: &str) -> String {
    let repaired = repair_mangled_entities(raw);
    static RE_PREFIX: OnceLock<Regex> = OnceLock::new();
    let re_prefix = RE_PREFIX.get_or_init(|| {
        Regex::new(r"(?i)^\s*(?:batch|pack)\b[\s:–—|·-]*\s*").unwrap()
    });
    let stripped = re_prefix.replace(&repaired, "");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extrai o título real do batch da página (`.bl-hero-title` ou `h1/h2`).
pub fn extract_batch_title(html: &str) -> Option<String> {
    static RE_HERO: OnceLock<Regex> = OnceLock::new();
    let re_hero = RE_HERO.get_or_init(|| {
        Regex::new(r#"(?i)class=["'][^"']*\bbl-hero-title\b[^"']*["'][^>]*>([\s\S]*?)</"#).unwrap()
    });
    if let Some(c) = re_hero.captures(html) {
        return Some(normalize_batch_title(&strip_tags(&c[1])));
    }
    static RE_H: OnceLock<Regex> = OnceLock::new();
    let re_h = RE_H.get_or_init(|| Regex::new(r"(?i)<h[12]\b[^>]*>([\s\S]*?)</h[12]>").unwrap());
    if let Some(c) = re_h.captures(html) {
        return Some(normalize_batch_title(&strip_tags(&c[1])));
    }
    None
}

/// Normaliza blocos `<div class="ss-ep-num">01</div>` para `Episódio 01 `.
pub fn normalize_episode_markup(html: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"(?i)<(?:span|div)\b[^>]*\bss-ep-num(?:-inline)?\b[^>]*>\s*(\d{1,3})\s*</(?:span|div)>"#).unwrap()
    });
    re.replace_all(html, "Episódio $1 ").into_owned()
}

/// Verifica se âncora é de assistir / player ("Veja Online", `.ss-ep-btn-video`, `.ml-btn-video`).
pub fn is_watch_anchor(attrs: &str, anchor_text: &str) -> bool {
    static RE_CLASS: OnceLock<Regex> = OnceLock::new();
    let re_class = RE_CLASS.get_or_init(|| {
        Regex::new(r#"(?i)\bclass\s*=\s*["'][^"']*\b(?:ss-ep-btn-video|ml-btn-video)\b"#).unwrap()
    });
    static RE_TEXT: OnceLock<Regex> = OnceLock::new();
    let re_text = RE_TEXT.get_or_init(|| Regex::new(r"(?i)veja\s+online").unwrap());

    re_class.is_match(attrs) || re_text.is_match(anchor_text)
}

// ─── VacaTorrent / Coletor (`parseDownloadLinks`) ────────────────────────────

/// Sufixos padrão de protetores de link permitidos.
pub const BASE_PROTECTOR_SUFFIXES: &[&str] = &[
    "systemtech.space",
    "encurtador.com.br",
    "linktracker.top",
    "t.co",
    "vacadb.org",
];

/// Verifica se o host é permitido.
pub fn is_default_protector_host(hostname: &str) -> bool {
    let h = hostname.to_lowercase();
    BASE_PROTECTOR_SUFFIXES
        .iter()
        .any(|s| h == *s || h.ends_with(&format!(".{s}")))
}

/// Opções extras para `parse_download_links` (ex.: season e real_title do batch).
#[derive(Debug, Clone, Default)]
pub struct VacaParseOptions {
    pub season: Option<u32>,
    pub real_title: Option<String>,
}

/// Parseia botões de download do VacaTorrent (filme ou episódio).
pub fn parse_download_links(
    html: &str,
    base_url: Option<&str>,
    is_protector_host: Option<&dyn Fn(&str) -> bool>,
    options: Option<&VacaParseOptions>,
) -> Vec<ResolverLink> {
    if html.is_empty() {
        return Vec::new();
    }
    let normalized_html = normalize_episode_markup(html);

    static RE_A: OnceLock<Regex> = OnceLock::new();
    let re_a = RE_A.get_or_init(|| Regex::new(r#"(?i)<a\b([^>]*)>([\s\S]*?)</a>"#).unwrap());

    static RE_SIZE: OnceLock<Regex> = OnceLock::new();
    let re_size = RE_SIZE.get_or_init(|| Regex::new(r"(?i)([\d.,]+)\s*(TB|GB|MB|KB)\b").unwrap());

    static RE_EP: OnceLock<Regex> = OnceLock::new();
    let re_ep = RE_EP.get_or_init(|| {
        Regex::new(r"(?i)(?:EPIS[ÓO]DIO|EP|CAP[ÍI]TULO|CAP)[.\s-]*(\d{1,3})\b|\bS\d{1,2}E(\d{1,3})\b|\bE(\d{1,3})\b").unwrap()
    });

    let mut links = Vec::new();
    let mut current_audio: Option<String> = None;
    let mut current_ep: Option<u32> = None;
    let mut cursor = 0;

    let checker = is_protector_host.unwrap_or(&is_default_protector_host);

    for cap in re_a.captures_iter(&normalized_html) {
        let whole_match = cap.get(0).unwrap();
        let attrs = &cap[1];
        let anchor_raw = &cap[2];
        let anchor_text = strip_tags(anchor_raw);

        if is_watch_anchor(attrs, &anchor_text) {
            continue;
        }

        let raw_href = extract_attr(attrs, "href").unwrap_or_default();
        let raw_href = raw_href.trim();
        if raw_href.is_empty() {
            continue;
        }

        let resolved_url = if raw_href.starts_with("magnet:") || raw_href.starts_with("MAGNET:") {
            Some(normalize_magnet_uri(raw_href))
        } else {
            let mut resolved = None;
            if let Some(base) = base_url {
                if let Ok(b) = url::Url::parse(base) {
                    if let Ok(target) = b.join(raw_href) {
                        let mut check_host = target.host_str().unwrap_or("").to_string();
                        // Verifica parâmetro ?to=
                        for (k, v) in target.query_pairs() {
                            if k.eq_ignore_ascii_case("to") {
                                if let Ok(nested) = url::Url::parse(&v) {
                                    if let Some(nh) = nested.host_str() {
                                        check_host = nh.to_string();
                                    }
                                }
                            }
                        }
                        if checker(&check_host) {
                            resolved = Some(target.into());
                        }
                    }
                }
            }
            resolved
        };

        let Some(target_url) = resolved_url else {
            cursor = whole_match.end();
            continue;
        };

        let segment_slice = &normalized_html[cursor..whole_match.start()];
        let segment = strip_tags(segment_slice);
        cursor = whole_match.end();

        // 1. Áudio
        if let Some(seg_aud) = classify_vaca_audio(&segment) {
            current_audio = Some(seg_aud.to_string());
        }
        let local_audio = classify_vaca_audio(&anchor_text).map(String::from);
        let audio = local_audio.or_else(|| current_audio.clone());

        // 2. Episódio
        if let Some(c) = re_ep.captures(&anchor_text) {
            let num = c[1].parse::<u32>().ok();
            current_ep = num;
        } else if let Some(c) = re_ep.captures(&segment) {
            let num = c[1].parse::<u32>().ok();
            current_ep = num;
        }

        // 3. Qualidade, fonte e tamanho
        let context = format!("{segment} {anchor_text}");
        let quality = normalize_quality(&context);
        let source = normalize_source(&context);

        let size = re_size
            .captures_iter(&context)
            .last()
            .map(|c| format!("{} {}", &c[1], &c[2]));

        let item = ResolverLink {
            url: target_url,
            quality,
            size,
            audio,
            episode: current_ep,
            episode_last: None,
            season: options.and_then(|o| o.season),
            source: source.map(String::from),
            real_title: options.and_then(|o| o.real_title.clone()),
            description: None,
        };

        links.push(item);
    }

    links
}

// ─── Títulos de Release ─────────────────────────────────────────────────────

/// Limpeza do título do post em 7 passos (padrão geral).
pub fn clean_post_title(title: &str) -> String {
    let mut clean = decode_entities(title);

    static RE_TORRENT: OnceLock<Regex> = OnceLock::new();
    let re_torrent = RE_TORRENT.get_or_init(|| {
        Regex::new(r"(?i)\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*").unwrap()
    });
    clean = re_torrent.replace_all(&clean, " ").into_owned();

    static RE_RES: OnceLock<fancy_regex::Regex> = OnceLock::new();
    let re_res = RE_RES.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)\b(?:2160p|1080p|720p|576p|480p|\d{3,4}p|4K|8K|UHD|ULTRA\s*HD|FULL\s*HD|\bHD\b(?!\s*TV)|\bSD\b)\b").unwrap()
    });
    clean = re_res.replace_all(&clean, " ").into_owned();

    static RE_SOURCE: OnceLock<Regex> = OnceLock::new();
    let re_source = RE_SOURCE.get_or_init(|| {
        Regex::new(r"(?i)\b(?:BDREMUX|REMUX|BLU[- ]?RAY|BLURAY|BDRIP|BRRIP|WEB[-. ]?DL|WEB[-. ]?RIP|WEBRIP|HDTV|CAMRIP|CAM|IMAX|3D|REMASTERED|REMASTER|HDR(?:10\+?)?|DOLBY\s*VISION|DV)\b").unwrap()
    });
    clean = re_source.replace_all(&clean, " ").into_owned();

    static RE_AUDIO: OnceLock<Regex> = OnceLock::new();
    let re_audio = RE_AUDIO.get_or_init(|| {
        Regex::new(r"(?i)\b(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS)\b").unwrap()
    });
    clean = re_audio.replace_all(&clean, " ").into_owned();

    static RE_LANG: OnceLock<Regex> = OnceLock::new();
    let re_lang = RE_LANG.get_or_init(|| {
        Regex::new(r"(?i)\b(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original)\b").unwrap()
    });
    clean = re_lang.replace_all(&clean, " ").into_owned();

    static RE_SEO: OnceLock<Regex> = OnceLock::new();
    let re_seo = RE_SEO.get_or_init(|| {
        Regex::new(r"(?i)\b(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir)\b").unwrap()
    });
    clean = re_seo.replace_all(&clean, " ").into_owned();

    static RE_SEPARATORS: OnceLock<Regex> = OnceLock::new();
    let re_separators = RE_SEPARATORS.get_or_init(|| {
        Regex::new(r"\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+").unwrap()
    });
    clean = re_separators.replace_all(&clean, " ").into_owned();

    clean.trim_matches(|c: char| matches!(c, '–' | '-' | '—' | '/' | '|' | ':' | '&' | '+' | ' '))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Limpeza do título do post específica do VacaTorrent.
pub fn clean_mark_title(title: &str) -> String {
    let decoded = decode_entities(title);
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)\s*(?:Vaca\s+Torrent|Download|Baixar|ver\s+online|\b(?:dublado|dublada|legendado|legendada)\b)\s*").unwrap()
    });
    let stripped = re.replace_all(&decoded, " ");
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Formata o título completo da release para o Jackett/Stremio.
pub fn release_title(
    post_title: &str,
    post_year: Option<u32>,
    link: &ResolverLink,
    index: Option<usize>,
) -> String {
    let clean = if let Some(ref real) = link.real_title {
        clean_mark_title(real)
    } else {
        clean_mark_title(post_title)
    };

    let year_part = if link.real_title.is_none() {
        post_year.map(|y| format!(" ({y})")).unwrap_or_default()
    } else {
        String::new()
    };

    let season_part = if link.real_title.is_none() {
        link.season.map(|s| format!("S{s:02}")).unwrap_or_default()
    } else {
        String::new()
    };

    let ep_part = if link.real_title.is_none() {
        link.episode
            .map(|e| {
                if let Some(last) = link.episode_last {
                    if last > e {
                        format!("E{e:02}-E{last:02}")
                    } else {
                        format!("E{e:02}")
                    }
                } else {
                    format!("E{e:02}")
                }
            })
            .unwrap_or_default()
    } else {
        String::new()
    };

    let se_combined = format!("{season_part}{ep_part}");
    let base = if se_combined.is_empty() {
        format!("{clean}{year_part}")
    } else {
        format!("{clean}{year_part} {se_combined}")
    };

    let audio_tag = match link.audio.as_deref() {
        Some("dublado") => Some("DUBLADO"),
        Some("dual") => Some("DUAL"),
        Some("legendado") => Some("LEGENDADO"),
        _ => None,
    };

    let size_tag = link.size.clone().or_else(|| index.map(|i| format!("opção {}", i + 1)));

    let mut tags = Vec::new();
    if let Some(q) = link.quality {
        tags.push(format!("{q}p"));
    }
    if let Some(ref s) = link.source {
        tags.push(s.clone());
    }
    if let Some(a) = audio_tag {
        tags.push(a.to_string());
    }
    if let Some(s) = size_tag {
        tags.push(s);
    }

    if tags.is_empty() {
        base
    } else {
        format!("{base} [{}]", tags.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_valid_magnet_uri() {
        let valid = "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Ubuntu";
        assert!(is_valid_magnet_uri(valid));

        let valid_upper = "MAGNET:?XT=URN:BTIH:C90BA3B1E4AFF23EDDE22EB755CA4392C12BC91D";
        assert!(is_valid_magnet_uri(valid_upper));

        let base32 = "magnet:?xt=urn:btih:4w3mwyxvg4e7o7j7j2k5uvqg24xxxxxx&dn=Test";
        assert!(is_valid_magnet_uri(base32));

        let invalid_no_xt = "magnet:?dn=Test";
        assert!(!is_valid_magnet_uri(invalid_no_xt));

        let invalid_hash = "magnet:?xt=urn:btih:123";
        assert!(!is_valid_magnet_uri(invalid_hash));
    }

    #[test]
    fn test_normalize_magnet_uri() {
        let raw = "MAGNET:?xt=urn:btih:abc1234567890123456789012345678901234567&amp;dn=Nome com espaco";
        let norm = normalize_magnet_uri(raw);
        assert!(norm.starts_with("magnet:?"));
        assert!(norm.contains("&dn=Nome%20com%20espaco"));
        assert!(!norm.contains("&amp;"));
    }

    #[test]
    fn test_extract_magnet_variants() {
        // 1. Variável JS
        let js = r#"const DOWNLOAD_URL = "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test";"#;
        assert_eq!(
            extract_magnet(js),
            Some("magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test".to_string())
        );

        // 2. data-link base64
        let magnet = "magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&tr=udp%3A%2F%2Ftracker.com";
        let b64 = {
            let bytes = magnet.as_bytes();
            let mut out = String::new();
            for chunk in bytes.chunks(3) {
                let n = ((chunk[0] as u32) << 16)
                    | (if chunk.len() > 1 { chunk[1] as u32 } else { 0 } << 8)
                    | (if chunk.len() > 2 { chunk[2] as u32 } else { 0 });
                let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                out.push(alphabet[((n >> 18) & 63) as usize] as char);
                out.push(alphabet[((n >> 12) & 63) as usize] as char);
                out.push(if chunk.len() > 1 { alphabet[((n >> 6) & 63) as usize] as char } else { '=' });
                out.push(if chunk.len() > 2 { alphabet[(n & 63) as usize] as char } else { '=' });
            }
            out
        };
        let html_b64 = format!(r#"<body data-link="{b64}">"#);
        assert_eq!(extract_magnet(&html_b64), Some(magnet.to_string()));

        // 3. Link direto href
        let a = r#"<a href="magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test">Download</a>"#;
        assert_eq!(
            extract_magnet(a),
            Some("magnet:?xt=urn:btih:c90ba3b1e4aff23edde22eb755ca4392c12bc91d&dn=Test".to_string())
        );
    }

    #[test]
    fn test_b64_data_link_is_http() {
        let _drive = "https://drive.google.com/file/d/123/view";
        let b64 = "aHR0cHM6Ly9kcml2ZS5nb29nbGUuY29tL2ZpbGUvZC8xMjMvdmlldw==";
        let html = format!(r#"<body data-link="{b64}">"#);
        assert!(b64_data_link_is_http(&html));

        assert!(!b64_data_link_is_http("<body>sem data link</body>"));
    }

    #[test]
    fn test_parse_post_magnets_apache() {
        let html = r###"
        <div class="download-block">
            <p class="download-versao">VERSÃO DUBLADA</p>
            <p class="download-desc">1080p DUAL ÁUDIO 5.1 <a href="#">Download</a></p>
            <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Filme.2024.1080p">Download Torrent</a>
        </div>
        "###;
        let links = parse_post_magnets(html, None);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].quality, Some(1080));
        assert_eq!(links[0].audio.as_deref(), Some("dual"));
        assert_eq!(
            links[0].description.as_deref(),
            Some("VERSÃO DUBLADA — 1080p DUAL ÁUDIO 5.1")
        );
    }

    #[test]
    fn test_parse_content_magnets_hdr() {
        let html = r#"
        <b>Tamanho: 4.62 GB</b>
        <div class="download-row">
            <div class="download-name">Episódio 01 - 1080p DUAL ÁUDIO</div>
            <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=S01E01">Download</a>
        </div>
        "#;
        let links = parse_content_magnets(html, None);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].episode, Some(1));
        assert_eq!(links[0].quality, Some(1080));
        assert_eq!(links[0].audio.as_deref(), Some("dual"));
        assert_eq!(links[0].size.as_deref(), Some("4.62 GB"));
    }

    #[test]
    fn test_vaca_shapes() {
        let html_movie = r#"<a href="/movie-links/12345/">Links</a>"#;
        assert_eq!(
            extract_movie_links(html_movie, Some("https://vaqueirofilmes1.com")),
            Some("https://vaqueirofilmes1.com/movie-links/12345/".to_string())
        );

        let markup = r#"<div class="ss-ep-num">05</div>"#;
        assert_eq!(normalize_episode_markup(markup), "Episódio 05 ");

        assert!(is_watch_anchor(r#"class="ss-ep-btn-video""#, "Assistir"));
        assert!(is_watch_anchor("", "Veja Online"));
        assert!(!is_watch_anchor(r#"class="download-btn""#, "Baixar 1080p"));

        let batch_hero = r#"<h1 class="bl-hero-title">BATCH – Sacrifício 4ordf Temporada</h1>"#;
        assert_eq!(
            extract_batch_title(batch_hero),
            Some("Sacrifício 4ª Temporada".to_string())
        );
    }

    #[test]
    fn test_release_title_formatting() {
        let link = ResolverLink {
            url: "magnet:?...".to_string(),
            quality: Some(1080),
            source: Some("WEB-DL".to_string()),
            audio: Some("dual".to_string()),
            size: Some("2.54 GB".to_string()),
            episode: None,
            episode_last: None,
            season: None,
            real_title: None,
            description: None,
        };
        let rel = release_title("Um Dia de Sorte em Nova York", Some(2025), &link, None);
        assert_eq!(
            rel,
            "Um Dia de Sorte em Nova York (2025) [1080p WEB-DL DUAL 2.54 GB]"
        );

        // Com real_title (batch)
        let mut link_batch = link.clone();
        link_batch.real_title = Some("Sacrifício de Sangue S05".to_string());
        let rel_batch = release_title("Outer Banks", Some(2020), &link_batch, None);
        assert_eq!(
            rel_batch,
            "Sacrifício de Sangue S05 [1080p WEB-DL DUAL 2.54 GB]"
        );
    }

    #[test]
    fn test_parse_post_links_redetorrent() {
        let html = r#"
        <table class="tbl-mv-list">
            <div class="tf theme-dark">DUBLADO</div>
            <tr class="tr-mv-list">
                <td class="td-mv-qua">1080p</td>
                <td class="td-mv-res">1080p</td>
                <td class="td-mv-idi">Português</td>
                <td class="td-mv-leg">Sem Legenda</td>
                <td class="td-mv-tam">2.1 GB</td>
                <td>
                    <a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Filme.1080p">Download</a>
                </td>
            </tr>
        </table>
        "#;
        let links = parse_post_links(html, None);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].quality, Some(1080));
        assert_eq!(links[0].audio.as_deref(), Some("dublado"));
        assert_eq!(links[0].size.as_deref(), Some("2.1 GB"));
    }

    #[test]
    fn test_parse_download_links_vaca() {
        let html = r#"
        <div class="downloads">
            <p>Português | Inglês</p>
            <a href="https://systemtech.space/enc/go.php?id=abc">Download 1080p WEB-DL (2.54 GB)</a>
            <a class="ss-ep-btn-video" href="https://systemtech.space/enc/player.php">Veja Online</a>
        </div>
        "#;
        let links = parse_download_links(html, Some("https://vaqueirofilmes1.com"), None, None);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://systemtech.space/enc/go.php?id=abc");
        assert_eq!(links[0].quality, Some(1080));
        assert_eq!(links[0].source.as_deref(), Some("WEB-DL"));
        assert_eq!(links[0].audio.as_deref(), Some("dual"));
        assert_eq!(links[0].size.as_deref(), Some("2.54 GB"));
    }
}
