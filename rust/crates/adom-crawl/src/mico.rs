//! Mico Leão Dublado utilitários e paginação (strideAt, bucketLastmod, parseMicoUrl, listTargetEpisodes).
//! Porte fiel de `src/providers/crawl-sites/mico-shared.ts`, `mico-series.ts` e `mico.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Id do catálogo de filmes do Mico.
pub const MOVIE_CATALOG_ID: &str = "MicoFilmes";
/// Id do catálogo de séries do Mico.
pub const SERIES_CATALOG_ID: &str = "MicoSeries";

/// Ponto de transição do passo de skip (abaixo usa 25, acima 50).
pub const STRIDE_SWITCH: u32 = 1000;

/// Passo fixo do `skip`: 25 até 1000, 50 depois.
pub fn stride_at(skip: u32) -> u32 {
    if skip < STRIDE_SWITCH {
        25
    } else {
        50
    }
}

const DAY_MS: i64 = 86_400_000;

/// Hash determinístico de string (FNV-1a 32 bits) — sem dependência externa.
/// Itera sobre UTF-16 code units como `charCodeAt` no JavaScript.
pub fn fnv1a(str: &str) -> u32 {
    let mut h: u32 = 0x811c9dc5;
    for c in str.encode_utf16() {
        h ^= c as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

/// Converte o número do dia (desde Unix epoch 1970-01-01 UTC) para `YYYY-MM-DD`.
pub fn epoch_days_to_iso_day(days: i64) -> String {
    // Algoritmo de Howard Hinnant para conversão civil de dias do epoch
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Data ISO (`YYYY-MM-DD`) do início do balde de releitura da obra.
/// Fórmula:
/// `phase = fnv1a(tt) % period` (0..period-1)
/// `cycle = floor((dayIndex - phase) / period)`
/// `lastmod = cycle * period + phase`
pub fn bucket_lastmod(tt: &str, now: i64, period_days: u32) -> String {
    let period = if period_days == 0 {
        14
    } else {
        period_days as i64
    };
    let day_index = if now >= 0 {
        now / DAY_MS
    } else {
        (now - (DAY_MS - 1)) / DAY_MS
    };
    let phase = (fnv1a(tt) as i64) % period;
    let diff = day_index - phase;
    let cycle = if diff >= 0 {
        diff / period
    } else {
        (diff - (period - 1)) / period
    };
    epoch_days_to_iso_day(cycle * period + phase)
}

/// URL base padrão da API do Mico Leão Dublado.
pub const DEFAULT_MICO_URL: &str = "https://mico-leao-dublado-apiv-2.vercel.app";

/// Tipo de obra (filme ou série) para URL sintética do Mico.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MicoKind {
    Movie,
    Series,
}

/// URL sintética parseada (`kind`, `imdb`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MicoParsedUrl {
    pub kind: MicoKind,
    pub imdb: String,
}

/// Valida IMDb id no formato `tt\d{1,10}`.
pub fn is_valid_imdb(tt: &str) -> bool {
    if !tt.starts_with("tt") {
        return false;
    }
    let digits = &tt[2..];
    !digits.is_empty() && digits.len() <= 10 && digits.chars().all(|c| c.is_ascii_digit())
}

/// URL sintética → `{ kind, imdb }`. Valida host === base_url e
/// caminho `/crawl/(movie|series)/(tt\d{1,10})/`.
pub fn parse_mico_url(url: &str, base_url: Option<&str>) -> Option<MicoParsedUrl> {
    let parsed = url::Url::parse(url).ok()?;
    let base_str = base_url.unwrap_or(DEFAULT_MICO_URL);
    let base = url::Url::parse(base_str).ok()?;
    if parsed.host_str() != base.host_str() {
        return None;
    }
    let path = parsed.path();
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 5 || !parts[0].is_empty() || parts[1] != "crawl" || !parts[4].is_empty() {
        return None;
    }
    let kind = match parts[2] {
        "movie" => MicoKind::Movie,
        "series" => MicoKind::Series,
        _ => return None,
    };
    let imdb = parts[3];
    if !is_valid_imdb(imdb) {
        return None;
    }
    Some(MicoParsedUrl {
        kind,
        imdb: imdb.to_string(),
    })
}

/// Monta a URL sintética estável de uma obra (identidade na fila).
pub fn synthetic_url(kind: MicoKind, tt: &str, base_url: Option<&str>) -> String {
    let base = base_url.unwrap_or(DEFAULT_MICO_URL).trim_end_matches('/');
    let kind_str = match kind {
        MicoKind::Movie => "movie",
        MicoKind::Series => "series",
    };
    format!("{base}/crawl/{kind_str}/{tt}/")
}

/// Metadata de série retornado pela Cinemeta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct SeriesMeta {
    #[serde(default)]
    pub episodes: HashMap<String, u32>,
    #[serde(rename = "episodeAired", default)]
    pub episode_aired: HashMap<String, String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub year: Option<serde_json::Value>,
}

/// Episódio-alvo (temporada e episódio).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TargetEpisode {
    pub season: u32,
    pub episode: u32,
}

/// Converte data ISO (`2022-05-27T00:00:00.000Z` ou `2022-05-27`) em timestamp ms UTC.
pub fn parse_iso_date_to_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.len() < 10 {
        return None;
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    if s.as_bytes().get(4)? != &b'-' {
        return None;
    }
    let month: u32 = s.get(5..7)?.parse().ok()?;
    if s.as_bytes().get(7)? != &b'-' {
        return None;
    }
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }

    // Dias desde 1970-01-01
    // Algoritmo inverso de Howard Hinnant
    let m = if month <= 2 { month + 9 } else { month - 3 };
    let y = (if month <= 2 { year - 1 } else { year }) as i64;
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + (doe as i64) - 719468;

    let mut ms = days * DAY_MS;

    if s.len() > 10 && (s.as_bytes()[10] == b'T' || s.as_bytes()[10] == b' ') {
        let rest = &s[11..];
        // Parse time: HH:MM:SS[.sss]
        if rest.len() >= 8 {
            let hour: i64 = rest.get(0..2)?.parse().ok()?;
            let min: i64 = rest.get(3..5)?.parse().ok()?;
            let sec: i64 = rest.get(6..8)?.parse().ok()?;
            ms += hour * 3_600_000 + min * 60_000 + sec * 1000;

            if rest.len() > 8 && rest.as_bytes()[8] == b'.' {
                let mut milli_str = String::new();
                for &b in rest.as_bytes()[9..].iter() {
                    if b.is_ascii_digit() {
                        milli_str.push(b as char);
                    } else {
                        break;
                    }
                }
                if !milli_str.is_empty() {
                    let millis: i64 = match milli_str.len() {
                        1 => milli_str.parse::<i64>().ok()? * 100,
                        2 => milli_str.parse::<i64>().ok()? * 10,
                        3 => milli_str.parse::<i64>().ok()?,
                        _ => milli_str[..3].parse::<i64>().ok()?,
                    };
                    ms += millis;
                }
            }
        }
    }

    Some(ms)
}

/// Lista os episódios-alvo da obra: só as `max_seasons` temporadas mais recentes,
/// da mais nova para trás, e só os episódios já exibidos (com data <= `now`).
pub fn list_target_episodes(
    meta: Option<&SeriesMeta>,
    max_seasons: usize,
    now: i64,
) -> Vec<TargetEpisode> {
    let Some(meta) = meta else {
        return Vec::new();
    };
    let mut seasons: Vec<u32> = meta
        .episodes
        .keys()
        .filter_map(|k| k.parse::<u32>().ok())
        .filter(|&n| n > 0)
        .collect();
    seasons.sort_by(|a, b| b.cmp(a));

    let kept_count = max_seasons.max(1);
    let kept = if seasons.len() > kept_count {
        &seasons[..kept_count]
    } else {
        &seasons[..]
    };

    let mut out = Vec::new();
    for &season in kept {
        let count = meta.episodes.get(&season.to_string()).copied().unwrap_or(0);
        for episode in 1..=count {
            let key = format!("{season}:{episode}");
            let Some(date_str) = meta.episode_aired.get(&key) else {
                continue; // sem data -> não confirmado -> pula
            };
            let Some(t) = parse_iso_date_to_ms(date_str) else {
                continue; // data ilegível -> pula
            };
            if t > now {
                continue; // futura -> pula
            }
            out.push(TargetEpisode { season, episode });
        }
    }
    out
}

/// Primeira linha sem os sufixos `(brazilian, eng)`, `👥 N`, `💾 X GB` e emojis.
pub fn clean_title(first_line: &str) -> String {
    let mut s = first_line.to_string();
    if let Some(pos) = s.find('👥') {
        s.truncate(pos);
    }
    if let Some(pos) = s.find('💾') {
        s.truncate(pos);
    }
    // Remove (brazilian, eng) ou sufixos de idioma entre parênteses
    if let Ok(re) = regex::Regex::new(r"(?i)\s*\((?:[a-z]+(?:\s*,\s*[a-z]+)*)\)\s*$") {
        s = re.replace(&s, "").to_string();
    }
    if let Ok(re) = regex::Regex::new(r"(?i)\s*\([a-z ,]*…\s*$") {
        s = re.replace(&s, "").to_string();
    }
    s = s.trim_end_matches('…').trim_end().to_string();

    // Remove emojis e pictográficos
    let filtered: String = s
        .chars()
        .filter(|&c| {
            let u = c as u32;
            !(0x1F300..=0x1FAFF).contains(&u) && !(0x2600..=0x27BF).contains(&u) && u != 0xFE0F
        })
        .collect();

    // Colapsa espaços
    let mut words = filtered.split_whitespace();
    let mut out = String::new();
    if let Some(first) = words.next() {
        out.push_str(first);
        for w in words {
            out.push(' ');
            out.push_str(w);
        }
    }
    out
}

/// URL do endpoint de filme do Mico (`/stream/movie/<tt>.json`).
pub fn mico_movie_stream_url(tt: &str, base_url: Option<&str>) -> Option<String> {
    if !is_valid_imdb(tt) {
        return None;
    }
    let base = base_url.unwrap_or(DEFAULT_MICO_URL).trim_end_matches('/');
    Some(format!("{base}/stream/movie/{tt}.json"))
}

/// URL do endpoint de episódio (`/stream/series/<tt>:<S>:<E>.json`).
pub fn mico_episode_stream_url(tt: &str, s: u32, e: u32, base_url: Option<&str>) -> Option<String> {
    if !is_valid_imdb(tt) {
        return None;
    }
    let base = base_url.unwrap_or(DEFAULT_MICO_URL).trim_end_matches('/');
    Some(format!("{base}/stream/series/{tt}:{s}:{e}.json"))
}

/// Converte header `Retry-After` em milissegundos.
pub fn retry_after_ms(header: Option<&str>, _now_ms: i64) -> Option<i64> {
    let raw = header?.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(secs) = raw.parse::<f64>() {
        if secs.is_finite() && secs >= 0.0 {
            return Some((secs * 1000.0).round() as i64);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stride_at() {
        assert_eq!(stride_at(0), 25);
        assert_eq!(stride_at(500), 25);
        assert_eq!(stride_at(999), 25);
        assert_eq!(stride_at(1000), 50);
        assert_eq!(stride_at(1050), 50);
        assert_eq!(stride_at(5000), 50);
    }

    #[test]
    fn test_fnv1a_values() {
        assert_eq!(fnv1a("tt0133093"), 3640502656);
        assert_eq!(fnv1a("tt0468569"), 3799686459);
    }

    #[test]
    fn test_bucket_lastmod_properties() {
        // Base: 2026-10-02 UTC (1790899200000 ms)
        let base = 1790899200000_i64;
        let l0 = bucket_lastmod("tt0133093", base, 14);
        assert_eq!(l0, "2026-09-24");

        // 1. Estável dentro do período de 14 dias (do início do balde start_day até +13 dias)
        let start_ms = 20720 * DAY_MS; // 2026-09-24T00:00:00Z
        for d in 0..14 {
            let now = start_ms + d * DAY_MS + 43_210;
            assert_eq!(bucket_lastmod("tt0133093", now, 14), l0);
        }

        // 2. Muda no período seguinte
        let l1 = bucket_lastmod("tt0468569", base, 14);
        assert_eq!(l1, "2026-09-19");
        let l2 = bucket_lastmod("tt0468569", base + 14 * DAY_MS, 14);
        assert_ne!(l1, l2);
        assert!(l2 > l1);
    }

    #[test]
    fn test_parse_mico_url() {
        let base = "https://mico-leao-dublado-apiv-2.vercel.app";
        let movie_url = format!("{base}/crawl/movie/tt0133093/");
        let series_url = format!("{base}/crawl/series/tt0944947/");

        assert_eq!(
            parse_mico_url(&movie_url, Some(base)),
            Some(MicoParsedUrl {
                kind: MicoKind::Movie,
                imdb: "tt0133093".to_string(),
            })
        );
        assert_eq!(
            parse_mico_url(&series_url, Some(base)),
            Some(MicoParsedUrl {
                kind: MicoKind::Series,
                imdb: "tt0944947".to_string(),
            })
        );

        // Casos inválidos
        assert_eq!(
            parse_mico_url("https://inimigo.test/crawl/movie/tt0133093/", Some(base)),
            None
        );
        assert_eq!(
            parse_mico_url(&format!("{base}/filme/tt0133093/"), Some(base)),
            None
        );
        assert_eq!(
            parse_mico_url(&format!("{base}/crawl/movie/12345/"), Some(base)),
            None
        );
        assert_eq!(
            parse_mico_url(&format!("{base}/crawl/movie/tt0133093"), Some(base)),
            None
        );
        assert_eq!(
            parse_mico_url(&format!("{base}/crawl/tv/tt0133093/"), Some(base)),
            None
        );
        assert_eq!(parse_mico_url("não é url", Some(base)), None);
        assert_eq!(parse_mico_url("", Some(base)), None);
    }

    #[test]
    fn test_list_target_episodes() {
        let mut episodes = HashMap::new();
        episodes.insert("3".to_string(), 4);
        episodes.insert("2".to_string(), 3);
        episodes.insert("1".to_string(), 2);

        let mut episode_aired = HashMap::new();
        episode_aired.insert("3:1".to_string(), "2022-05-27T00:00:00.000Z".to_string());
        episode_aired.insert("3:2".to_string(), "2022-05-27T00:00:00.000Z".to_string());
        episode_aired.insert("3:3".to_string(), "2099-01-01T00:00:00.000Z".to_string()); // futura
                                                                                         // 3:4 ausente
        episode_aired.insert("2:1".to_string(), "2017-10-27T00:00:00.000Z".to_string());
        episode_aired.insert("2:2".to_string(), "2017-10-27T00:00:00.000Z".to_string());
        episode_aired.insert("2:3".to_string(), "2017-10-27T00:00:00.000Z".to_string());
        episode_aired.insert("1:1".to_string(), "2016-07-15T00:00:00.000Z".to_string());
        episode_aired.insert("1:2".to_string(), "2016-07-15T00:00:00.000Z".to_string());

        let meta = SeriesMeta {
            episodes,
            episode_aired,
            name: Some("Stranger Things".to_string()),
            year: None,
        };

        let now = 1790899200000_i64; // 2026-10-02

        // maxSeasons = 1 -> S3
        let t1 = list_target_episodes(Some(&meta), 1, now);
        assert_eq!(
            t1,
            vec![
                TargetEpisode {
                    season: 3,
                    episode: 1
                },
                TargetEpisode {
                    season: 3,
                    episode: 2
                }
            ]
        );

        // maxSeasons = 2 -> S3 e S2
        let t2 = list_target_episodes(Some(&meta), 2, now);
        assert_eq!(
            t2,
            vec![
                TargetEpisode {
                    season: 3,
                    episode: 1
                },
                TargetEpisode {
                    season: 3,
                    episode: 2
                },
                TargetEpisode {
                    season: 2,
                    episode: 1
                },
                TargetEpisode {
                    season: 2,
                    episode: 2
                },
                TargetEpisode {
                    season: 2,
                    episode: 3
                },
            ]
        );

        // maxSeasons = 3 -> S3, S2 e S1
        let t3 = list_target_episodes(Some(&meta), 3, now);
        assert_eq!(t3.len(), 7);

        // Vazia
        assert_eq!(list_target_episodes(None, 2, now), vec![]);
    }

    #[test]
    fn test_clean_title() {
        assert_eq!(
            clean_title("Coringa 2019 1080p DUAL 👥 12 💾 2.5 GB"),
            "Coringa 2019 1080p DUAL"
        );
        assert_eq!(clean_title("Matrix (brazilian, eng)"), "Matrix");
    }
}
