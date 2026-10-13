//! RedeTorrent (`resolvers/profiles/redetorrent-parsers.ts`): as tabelas
//! `table.tbl-mv-list`. Autoridade TS única deste arquivo.
//!
//! O validador/extrator de magnet vem de `br_core::magnet` — não reimplemente
//! aqui: a variante local era justamente uma das cópias que divergiam do TS.

use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

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
            let decoded_url =
                crate::shared::decode_uri_component(&c[1]).unwrap_or_else(|| c[1].to_string());
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
    let re_table = RE_TABLE
        .get_or_init(|| Regex::new(r#"(?i)<table class="tbl-mv-list">[\s\S]*?</table>"#).unwrap());

    static RE_HEADER: OnceLock<Regex> = OnceLock::new();
    let re_header = RE_HEADER
        .get_or_init(|| Regex::new(r#"(?i)<div class="tf[^"]*">([\s\S]*?)</div>"#).unwrap());

    static RE_ROW: OnceLock<Regex> = OnceLock::new();
    let re_row =
        RE_ROW.get_or_init(|| Regex::new(r#"(?i)<tr class="tr-mv-list">([\s\S]*?)</tr>"#).unwrap());

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href = RE_HREF
        .get_or_init(|| Regex::new(r#"(?i)<a\s+[^>]*?href\s*=\s*["']([^"']+)["']"#).unwrap());

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
