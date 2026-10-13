use super::*;
use adom_core::decode_entities;
use regex::Regex;
use std::sync::OnceLock;

// ─── Títulos de Release ─────────────────────────────────────────────────────

/// Limpeza do título do post em 7 passos (padrão geral).
pub fn clean_post_title(title: &str) -> String {
    let mut clean = decode_entities(title);

    static RE_TORRENT: OnceLock<Regex> = OnceLock::new();
    let re_torrent = RE_TORRENT
        .get_or_init(|| Regex::new(r"(?i)\s*Torrent(?:s)?\s*(?:[–\-—/|:&+]|&#8211;)?\s*").unwrap());
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
    let re_audio = RE_AUDIO
        .get_or_init(|| Regex::new(r"(?i)\b(?:5\.1|7\.1|2\.0|7\.2|DDP\s*5\.1|ATMOS)\b").unwrap());
    clean = re_audio.replace_all(&clean, " ").into_owned();

    static RE_LANG: OnceLock<Regex> = OnceLock::new();
    let re_lang = RE_LANG.get_or_init(|| {
        Regex::new(r"(?i)\b(?:Dublado|Dublada|Legendado|Legendada|Dual\s*[AÁ]udio|Nacional|Multi\s*[AÁ]udio|Tri\s*[AÁ]udio|[AÁ]udio\s*Original)\b").unwrap()
    });
    clean = re_lang.replace_all(&clean, " ").into_owned();

    static RE_SEO: OnceLock<Regex> = OnceLock::new();
    let re_seo = RE_SEO.get_or_init(|| {
        Regex::new(r"(?i)\b(?:Download|Baixar|Gr[áa]tis|Online|Completo|Completa|Assistir)\b")
            .unwrap()
    });
    clean = re_seo.replace_all(&clean, " ").into_owned();

    static RE_SEPARATORS: OnceLock<Regex> = OnceLock::new();
    let re_separators =
        RE_SEPARATORS.get_or_init(|| Regex::new(r"\s*[/|–\-—:&+]\s*([/|–\-—:&+]\s*)+").unwrap());
    clean = re_separators.replace_all(&clean, " ").into_owned();

    clean
        .trim_matches(|c: char| matches!(c, '–' | '-' | '—' | '/' | '|' | ':' | '&' | '+' | ' '))
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

    let size_tag = link
        .size
        .clone()
        .or_else(|| index.map(|i| format!("opção {}", i + 1)));

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
