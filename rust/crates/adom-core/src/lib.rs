//! Núcleo Rust do Adom — fatias F0/F1 da migração TS→Rust.
//!
//! F0 ancorou o golden em `rust/golden/` e os testes de integridade em
//! `tests/golden_corpus.rs`. F1 porta SÓ o comportamento string→string de
//! `normalizeTitle` (módulo `title_normalization`), sem matching nem providers.
//! O parse do JSONL/manifest continua no próprio teste, que é o consumidor.
//!
//! Vocabulário: porta SÓ `titleTokens` (módulo `matching_vocabulary`), com
//! golden próprio em `rust/golden/matching-vocabulary-title-tokens.jsonl`.

mod br_origin;
mod catalog_year;
mod info_hash;
mod js_text;
mod latin_table;
mod magnet_uri;
mod matching_decisions;
mod matching_tokens;
mod matching_vocabulary;
mod short_name_tail;
mod title_normalization;

pub use info_hash::extract_info_hash;
pub use magnet_uri::{default_magnet, sanitize_magnet};

pub use br_origin::{br_origin_mark, has_pt_signs};
pub use catalog_year::{catalog_alt_year_of, catalog_year_of};
pub use short_name_tail::short_name_tail_contradicts;

pub use matching_decisions::{
    adaptation_identity_contradicts, first_significant_token, live_action_year_contradicts,
    named_sequel_contradicts, title_precision, year_contradicts,
};

pub use matching_tokens::{
    episode_work_tokens, extract_sequence_markers, first_unmarked_token, first_work_token,
    is_non_latin_token, is_non_naming_token, Marker,
};
pub use matching_vocabulary::{
    episode_token_test, title_tokens, vocabulary_contents, year_range_test,
};
pub use title_normalization::normalize_title;

/// Único formato de manifest aceito pelo consumidor do golden.
///
/// Contrato on-disk compartilhado com o gerador `scripts/golden` e com o
/// checker Node; aqui é só a constante do formato, sem comportamento.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";
