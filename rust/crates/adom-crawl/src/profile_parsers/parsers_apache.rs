//! ApacheTorrent (`resolvers/profiles/apachetorrent-parsers.ts`): os blocos
//! `div.download-block` viram links. Autoridade TS única deste arquivo.

use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

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
