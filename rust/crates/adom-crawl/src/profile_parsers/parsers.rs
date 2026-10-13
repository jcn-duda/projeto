use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

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
    let re_anchor = RE_ANCHOR.get_or_init(|| Regex::new(r#"(?i)<a\b[\s\S]*?</a>"#).unwrap());

    static RE_HREF: OnceLock<Regex> = OnceLock::new();
    let re_href =
        RE_HREF.get_or_init(|| Regex::new(r#"(?i)<a\b[^>]*\bhref=["']([^"']+)["']"#).unwrap());

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
    let re_magnet = RE_MAGNET
        .get_or_init(|| Regex::new(r#"(?i)<a\b[^>]*href=["'](magnet:[^"']+)["']"#).unwrap());

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
