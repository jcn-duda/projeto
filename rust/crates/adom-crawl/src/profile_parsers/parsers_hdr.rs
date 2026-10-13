//! HDRTorrents (`resolvers/profiles/hdrtorrents-parsers.ts`): as linhas
//! `.download-row` com magnet direto e o tamanho da ficha técnica. Autoridade TS
//! única deste arquivo.

use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

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
