//! Leitura de um item do `/find` do TMDB (filme ou série), separada do
//! cliente pela catraca de 400 linhas.

use serde_json::Value;

use crate::wire::{as_integer, nonempty_str, trimmed_title};

/// O que o `/find` entrega por obra. `title` já é o localizado do idioma
/// consultado (`title`/`name`); `original` fica separado e NUNCA promove para
/// o canônico inglês.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct FindItem {
    pub(super) tmdb_id: Option<u64>,
    pub(super) title: Option<String>,
    pub(super) original: Option<String>,
    pub(super) original_language: Option<String>,
    pub(super) year: Option<String>,
    pub(super) is_series: bool,
}

pub(super) fn parse_find_item(value: &Value, is_series: bool) -> FindItem {
    FindItem {
        tmdb_id: value
            .get("id")
            .and_then(as_integer)
            .filter(|id| *id > 0)
            .map(|id| id as u64),
        // Título localizado do idioma consultado. `title` (filme) / `name`
        // (série) — em en-US é o canônico que os trackers globais publicam.
        title: value
            .get("title")
            .and_then(trimmed_title)
            .or_else(|| value.get("name").and_then(trimmed_title)),
        original: value
            .get("original_title")
            .and_then(trimmed_title)
            .or_else(|| value.get("original_name").and_then(trimmed_title)),
        original_language: value
            .get("original_language")
            .and_then(nonempty_str)
            .map(str::to_string),
        year: release_year(value),
        is_series,
    }
}

/// `(release_date || first_air_date || '').slice(0, 4) || null`.
fn release_year(value: &Value) -> Option<String> {
    let raw = value
        .get("release_date")
        .and_then(nonempty_str)
        .or_else(|| value.get("first_air_date").and_then(nonempty_str))?;
    let cut: String = raw.chars().take(4).collect();
    (!cut.is_empty()).then_some(cut)
}
