//! Opcoes do build: overlay do usuario (URL) sobre os defaults do operador.

use adom_core::{QualityLimits, QUALITY_KEYS, UNKNOWN_QUALITY};
use serde_json::Value;

use crate::list_builder::BuildOptions;

// ── Opções do build: usuário (URL) sobre defaults do operador ───────────────

/// Lê o `BuildOptions` das opções JÁ normalizadas pelo runtime (nomes longos do
/// SCHEMA). Campo ausente ou de tipo errado cai no default do operador — o
/// mesmo `clampInt`/`normalize` do Node já rodou antes, então aqui é só
/// transporte.
pub fn build_options_from(options: &Value, fallback: &BuildOptions) -> BuildOptions {
    let mut out = fallback.clone();
    let get = |key: &str| options.get(key);
    if let Some(n) = get("maxResults").and_then(Value::as_f64) {
        out.max_results = n;
    }
    if let Some(n) = get("minSeeders").and_then(Value::as_f64) {
        out.min_seeders = n;
    }
    if let Some(Value::Array(list)) = get("qualities") {
        out.qualities = list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    if let Some(b) = get("preferDubbed").and_then(Value::as_bool) {
        out.prefer_dubbed = b;
    }
    if let Some(b) = get("dubbedOnly").and_then(Value::as_bool) {
        out.dubbed_only = b;
    }
    if let Some(b) = get("excludeCam").and_then(Value::as_bool) {
        out.exclude_cam = b;
    }
    if let Some(n) = get("maxSizeGb").and_then(Value::as_f64) {
        out.max_size_gb = n;
    }
    if let Some(n) = get("brReservedSlots").and_then(Value::as_f64) {
        out.br_reserved_slots = n;
    }
    // Operador-only no Node (fora do SCHEMA); se vier no overlay, aplica.
    if let Some(n) = get("brReservedPerQuality").and_then(Value::as_f64) {
        out.br_reserved_per_quality = n;
    }
    if let Some(n) = get("candidatePoolFactor").and_then(Value::as_f64) {
        out.candidate_pool_factor = n;
    }
    if let Some(b) = get("brFirst").and_then(Value::as_bool) {
        out.br_first = b;
    }
    if let Some(b) = get("brOnly").and_then(Value::as_bool) {
        out.br_only = b;
    }
    if let Some(n) = get("maxPerIndexer").and_then(Value::as_f64) {
        out.max_per_indexer = n;
    }
    if let Some(Value::Array(list)) = get("indexerPriority") {
        out.indexer_priority = list
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    // Inventário da conta (hashes já provados tocáveis): desempate `instant`
    // do sorteio. Chave extra fora do SCHEMA do usuário — o operador injeta.
    if let Some(Value::Array(list)) = get("instantHashes") {
        out.instant_hashes = list
            .iter()
            .filter_map(Value::as_str)
            .map(|hash| hash.trim().to_ascii_lowercase())
            .filter(|hash| !hash.is_empty())
            .collect();
    }
    out.quality_limits = quality_limits_from(options, "max", &out.quality_limits);
    out.indexer_limits = indexer_limits_from(options);
    out
}

/// `max2160p`…`maxUnknown` → mapa por chave de qualidade (`QUALITY_KEYS`).
/// SCHEMA usa `maxSd` (não `maxSD`) — typo aqui ignorava a cota de SD.
fn quality_limits_from(options: &Value, prefix: &str, fallback: &QualityLimits) -> QualityLimits {
    const FIELDS: [&str; 6] = ["2160p", "1080p", "720p", "480p", "Sd", "Unknown"];
    let mut out = fallback.clone();
    for (field, quality) in FIELDS.iter().zip(QUALITY_KEYS.iter()) {
        if let Some(n) = options
            .get(format!("{prefix}{field}"))
            .and_then(Value::as_f64)
        {
            out.insert((*quality).to_string(), n);
        }
    }
    // `maxUnknown` cobre o balde sem resolução (o TS usa a chave `UNKNOWN_QUALITY`).
    debug_assert_eq!(QUALITY_KEYS[5], UNKNOWN_QUALITY);
    out
}

/// `indexerLimits`: mapa `id → limite` (o `normalizeIntMap` do runtime já
/// descartou id inválido e grampeou o teto).
fn indexer_limits_from(options: &Value) -> QualityLimits {
    let mut out = QualityLimits::new();
    let Some(map) = options.get("indexerLimits").and_then(Value::as_object) else {
        return out;
    };
    for (id, value) in map {
        if let Some(n) = value.as_f64() {
            out.insert(id.clone(), n);
        }
    }
    out
}
