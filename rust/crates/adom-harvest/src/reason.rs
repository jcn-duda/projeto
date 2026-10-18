//! Precedência de motivos e identidade da obra — espelho de
//! `src/providers/harvest-reason.ts` (módulo folha no TS).

use crate::types::HarvestEntry;

/// Janela de prioridade do `br-gap` recém-promovido (1h), ms.
pub const BR_GAP_PRIORITY_WINDOW_MS: i64 = 60 * 60 * 1000;

/// Precedência numérica: `next-episode` (2) > `br-gap` (1) > demais (0).
pub fn reason_priority(reason: &str) -> u8 {
    match reason {
        "next-episode" => 2,
        "br-gap" => 1,
        _ => 0,
    }
}

/// O motivo novo é mais forte? Promoção só sobe, nunca rebaixa.
pub fn is_promotion(current_reason: &str, incoming_reason: &str) -> bool {
    reason_priority(incoming_reason) > reason_priority(current_reason)
}

/// Identidade na fila: `imdbId:season:episode` (vazios em filme).
pub fn obra_identity(imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> String {
    let s = season.map(|n| n.to_string()).unwrap_or_default();
    let e = episode.map(|n| n.to_string()).unwrap_or_default();
    format!("{imdb_id}:{s}:{e}")
}

pub fn entry_identity(entry: &HarvestEntry) -> String {
    obra_identity(&entry.imdb_id, entry.season, entry.episode)
}

/// `br-gap` dentro da janela própria (`priority_at` ou fallback `enqueued_at`).
pub fn is_recent_br_gap(entry: &HarvestEntry, now_ms: i64) -> bool {
    if entry.reason != "br-gap" {
        return false;
    }
    let since = entry.priority_at.unwrap_or(entry.enqueued_at);
    now_ms - since < BR_GAP_PRIORITY_WINDOW_MS
}

/// IMDb id canônico: `tt` + dígitos (mesmo regex do enqueue TS).
pub fn is_valid_imdb_id(imdb_id: &str) -> bool {
    let mut chars = imdb_id.chars();
    if chars.next() != Some('t') || chars.next() != Some('t') {
        return false;
    }
    let rest: String = chars.collect();
    !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{HarvestEntry, HarvestMediaType};

    #[test]
    fn precedencia_next_episode_sobre_br_gap() {
        assert!(is_promotion("br-gap", "next-episode"));
        assert!(!is_promotion("next-episode", "br-gap"));
        assert!(!is_promotion("miss", "miss"));
        assert!(is_promotion("miss", "br-gap"));
    }

    #[test]
    fn identidade_filme_e_serie() {
        assert_eq!(obra_identity("tt0111161", None, None), "tt0111161::");
        assert_eq!(
            obra_identity("tt0903747", Some(1), Some(2)),
            "tt0903747:1:2"
        );
    }

    #[test]
    fn br_gap_recente_respeita_janela() {
        let entry = HarvestEntry {
            imdb_id: "tt0111161".into(),
            media_type: HarvestMediaType::Movie,
            season: None,
            episode: None,
            reason: "br-gap".into(),
            enqueued_at: 1_000,
            priority_at: Some(1_000),
            resumed: false,
            br_probe: false,
            full_base: false,
        };
        assert!(is_recent_br_gap(
            &entry,
            1_000 + BR_GAP_PRIORITY_WINDOW_MS - 1
        ));
        assert!(!is_recent_br_gap(&entry, 1_000 + BR_GAP_PRIORITY_WINDOW_MS));
    }

    #[test]
    fn imdb_id_valido() {
        assert!(is_valid_imdb_id("tt0111161"));
        assert!(!is_valid_imdb_id("0111161"));
        assert!(!is_valid_imdb_id("tt"));
        assert!(!is_valid_imdb_id("ttabc"));
    }
}
