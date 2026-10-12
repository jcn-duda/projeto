//! Núcleo Rust do Adom — fatias F0/F1 da migração TS→Rust.
//!
//! F0 ancorou o golden em `rust/golden/` e os testes de integridade em
//! `tests/golden_corpus.rs`. F1 porta SÓ o comportamento string→string de
//! `normalizeTitle` (módulo `title_normalization`), sem matching nem providers.
//! O parse do JSONL/manifest continua no próprio teste, que é o consumidor.
//!
//! Vocabulário: porta SÓ `titleTokens` (módulo `matching_vocabulary`), com
//! golden próprio em `rust/golden/matching-vocabulary-title-tokens.jsonl`.

mod matching_vocabulary;
mod title_normalization;

pub use matching_vocabulary::{title_tokens, vocabulary_contents};
pub use title_normalization::normalize_title;

/// Único formato de manifest aceito pelo consumidor do golden.
///
/// Contrato on-disk compartilhado com o gerador `scripts/golden` e com o
/// checker Node; aqui é só a constante do formato, sem comportamento.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";
