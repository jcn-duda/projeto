//! `adom-parity` — harness de paridade do corpus `rust/golden/stream-e2e`.
//!
//! O corpus mede a rota `/stream` do addon Node: cada caso tem a requisição
//! (`request.json`) e a resposta gravada (`response.json`); o `manifest.json`
//! amarra ids, tipos, status e sha256. Este crate é o consumidor Rust do
//! corpus e a base do critério de zero divergência do §9 do contrato
//! (`docs/rust-stream-contract.md`):
//!
//! 1. [`corpus`] lê o manifest e os casos **tolerando esquema ausente**, confere
//!    os sha256 e produz um diagnóstico do que o corpus realmente tem;
//! 2. [`normalize`] põe a resposta numa forma determinística: streams ordenados,
//!    origem/host → `{{base}}`, `sig` → `{{sig}}`, config → `{{config}}`,
//!    relógio/campos internos fora, `cacheMaxAge` mascarável;
//! 3. [`diff`] compara duas respostas normalizadas e devolve diferenças
//!    legíveis (campo, índice, esperado × obtido);
//! 4. [`runner`] injeta a fonte Rust via [`runner::StreamSource`] e compara com
//!    o Node gravado. Enquanto o orquestrador não expõe API estável, a fonte é
//!    [`runner::ReplaySource`] (o corpus contra ele mesmo) e o binário tem
//!    `--dump` para validar só o corpus.
//!
//! O crate **não** depende de `adom-search` de propósito: a API do orquestrador
//! ainda está sendo montada por outro agente. O ponto de costura está marcado
//! com TODO em [`runner`].

pub mod corpus;
pub mod diff;
pub mod normalize;
pub mod runner;

pub use corpus::{
    Case, CaseMeta, CaseRequest, Corpus, CorpusError, CorpusStats, Diagnostic, DiagnosticLevel,
    LoadOptions, Manifest, RecordedResponse, FORMAT,
};
pub use diff::{Diff, DiffEntry};
pub use normalize::{
    canonical_json, mask_url, normalize_body, NormalizeError, NormalizeOptions, NormalizedResponse,
    NormalizedStream,
};
pub use runner::{
    run_corpus, CaseReport, CaseStatus, ParityReport, ReplaySource, SourceError, StreamSource,
};

use sha2::{Digest, Sha256};

/// sha256 em hexadecimal minúsculo — o mesmo formato do `manifest.json`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.as_slice() {
        // `write!` em `String` só falha se o `fmt::Write` falhar; String não falha.
        let _ = write!(out, "{byte:02x}");
    }
    out
}
