use crate::{
    audio_from_title, parse_title_season_episode, quality_from_title, source_from_title,
    UNKNOWN_QUALITY,
};

/// A regex de temporada do laço TS, portada à mão: menor ocorrência de
/// `\bS(\d{1,2})\b` ou `(\d{1,2})\s*[ªº]\s*Temporada` (case-insensitive,
/// bordas de palavra ASCII como no JS).
pub fn title_season_marker(title: &str) -> Option<i64> {
    let chars: Vec<char> = title.chars().collect();
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let parse_at = |slice: &[char]| -> Option<i64> {
        let text: String = slice.iter().collect();
        text.parse().ok()
    };
    let temporada_at = |slice: &[char]| -> bool {
        let rest = slice.iter().collect::<String>().to_ascii_lowercase();
        rest.starts_with("temporada")
    };
    for i in 0..chars.len() {
        // Padrão A: \bS(\d{1,2})\b — com backtracking greedy (2 dígitos, depois 1).
        if (chars[i] == 'S' || chars[i] == 's') && (i == 0 || !is_word(chars[i - 1])) {
            let mut digits = 0;
            while digits < 2
                && i + 1 + digits < chars.len()
                && chars[i + 1 + digits].is_ascii_digit()
            {
                digits += 1;
            }
            for take in (1..=digits).rev() {
                let end = i + 1 + take;
                if end >= chars.len() || !is_word(chars[end]) {
                    return parse_at(&chars[i + 1..end]);
                }
            }
        }
        // Padrão B: (\d{1,2})\s*[ªº]\s*Temporada.
        if chars[i].is_ascii_digit() {
            for take in [2usize, 1] {
                let Some(head) = chars.get(i..i + take) else {
                    continue;
                };
                if !head.iter().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let mut j = i + take;
                while j < chars.len() && chars[j].is_whitespace() {
                    j += 1;
                }
                if j < chars.len() && (chars[j] == 'ª' || chars[j] == 'º') {
                    j += 1;
                    while j < chars.len() && chars[j].is_whitespace() {
                        j += 1;
                    }
                    if temporada_at(&chars[j..]) {
                        return parse_at(head);
                    }
                }
            }
        }
    }
    None
}

/// Score de escolha do candidato (`resolveCandidateScore` do TS), porte fiel.
pub fn resolve_candidate_score(title: &str, season: Option<i64>, episode: Option<i64>) -> i64 {
    let parsed = parse_title_season_episode(title);
    let mut score: i64 = 0;
    if let (Some(season), Some(episode)) = (season, episode) {
        if parsed.seasons.contains(&season) && parsed.episodes.contains(&episode) {
            score += 100;
        } else if parsed.episodes.is_empty()
            && parsed.seasons.len() == 1
            && parsed.seasons[0] == season
        {
            score += 70;
        } else if parsed.episodes.is_empty() && parsed.seasons.contains(&season) {
            score += 50;
        } else if parsed.episodes.is_empty()
            && (parsed.complete || (parsed.season_pack && parsed.seasons.is_empty()))
        {
            score += 30;
        }
    }
    match audio_from_title(title) {
        "Dual" => score += 110,
        "Dublado" => score += 100,
        "Nacional" => score += 95,
        "Legendado" => score -= 50,
        _ => {}
    }
    score += match quality_from_title(title) {
        "2160p" => 15,
        "1080p" => 12,
        "720p" => 6,
        "480p" => 3,
        "SD" => 1,
        UNKNOWN_QUALITY => 4,
        _ => 0,
    };
    match source_from_title(title) {
        "BluRay" => score += 8,
        "WEB-DL" => score += 6,
        "WEBRip" | "HDTV" => score += 4,
        "CAM" => score -= 200,
        _ => {}
    }
    score
}
