//! Bindings NAPI do texto de magnet e título (`adom-core`).
//!
//! Porte da fronteira de `src/utils/title-normalization.ts`: parse de magnet
//! (`extract_info_hash`, `magnet_display_name`) e texto (`decode_entities`,
//! `bytes_to_size`, `strip_diacritics`, `collapse_acronyms`, `dedupe_names`).
//! A lógica real vive em `adom-core` (golden contra o TS do `esm`); aqui só
//! se convertem tipos na fronteira.
//!
//! SEM lote: medido em `tmp/g1-measure.mjs` (450 magnets reais do
//! `magnets.db`), o laço por item custa ~0,26 ms — abaixo do piso de 0,5 ms —
//! e as variantes em lote (`extract_info_hashes`/`magnet_display_names`) são
//! MAIS LENTAS (0,29/0,52 ms): a montagem do array de objetos no lado JS
//! domina. Regra de ouro vale nos dois sentidos: chamada direta vence.

use napi_derive::napi;

use adom_core::magnet_display_name as core_magnet_display_name;

/// Extrai o nome da release do `dn=` do magnet — porte de `magnetDisplayName`.
#[napi(catch_unwind)]
pub fn magnet_display_name(
    magnet: Option<String>,
    magnet_uri: Option<String>,
    guid: Option<String>,
) -> String {
    core_magnet_display_name(magnet.as_deref(), magnet_uri.as_deref(), guid.as_deref())
}

/// Decodifica entidades HTML numéricas e da tabela nomeada — porte de
/// `decodeEntities`.
#[napi(catch_unwind)]
pub fn decode_entities(text: String) -> String {
    adom_core::decode_entities(&text)
}

/// Tamanho legível ("1.00 GB") ou `None` quando não é tamanho — porte de
/// `bytesToSize`.
#[napi(catch_unwind)]
pub fn bytes_to_size(bytes: f64) -> Option<String> {
    adom_core::bytes_to_size(bytes)
}

/// Tira só o diacrítico, preservando caixa e pontuação — porte de
/// `stripDiacritics`.
#[napi(catch_unwind)]
pub fn strip_diacritics(text: String) -> String {
    adom_core::strip_diacritics(&text)
}

/// Colapsa sigla pontuada ("S.W.A.T." → "SWAT") — porte de `collapseAcronyms`.
#[napi(catch_unwind)]
pub fn collapse_acronyms(text: String) -> String {
    adom_core::collapse_acronyms(&text)
}

/// Deduplica nomes por forma normalizada (`None` = null/undefined) — porte de
/// `dedupeNames`; uma chamada cobre a lista inteira.
#[napi(catch_unwind)]
pub fn dedupe_names(names: Vec<Option<String>>) -> Vec<String> {
    let refs: Vec<Option<&str>> = names.iter().map(|name| name.as_deref()).collect();
    adom_core::dedupe_names(&refs)
}
