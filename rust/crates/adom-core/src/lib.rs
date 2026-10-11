//! Núcleo Rust do Adom — fatia F0 da migração TS→Rust.
//!
//! Esta fatia NÃO porta `normalizeTitle` nem expõe API de matching: existe só
//! para ancorar o golden em `rust/golden/` e os testes de integridade em
//! `tests/golden_corpus.rs`. O crate fica SEM dependências (nem de runtime); o
//! parse do JSONL/manifest é feito no próprio teste, que é o consumidor.

/// Único formato de manifest aceito pelo consumidor do golden.
///
/// Contrato on-disk compartilhado com o gerador `scripts/golden` e com o
/// checker Node; aqui é só a constante do formato, sem comportamento.
pub const MANIFEST_FORMAT: &str = "adom-golden-manifest/1";
