//! BUILD da lista do `/stream` — porte da orquestração de
//! `stream-builder.ts` + `stream-builder-pipeline.ts` (oráculo: branch `esm`).
//!
//! Dos ITENS CRUS (saída da janela de coleta) até a LISTA FINAL, na ordem do
//! TS (as réguas são TODAS do `adom-core`; aqui é só sequência e estado):
//!
//! 1. entidades HTML saem do título (`decode_entities`) — a decisão não pode
//!    ver `&ordf;`;
//! 2. release falsa executável (`.exe` e hash gêmeo) sai antes de tudo;
//! 3. **filtro de título** (`adom_core::filter_relevant_raw`) — itens da conta
//!    pulam (já passaram pelo filtro deles no provider);
//! 4. **pack multiobra**: marcação (`admits_multi_work_pack`) e guarda de
//!    coleção (sem debrid/sem ano, pack retido);
//! 5. **episódio** (`adom_core::filter_series_episode`) com pré-air (margem
//!    48h sobre publish/first_seen) e unaired (margem 24h);
//! 6. **sortAndLimit** no POOL AMPLIADO (`max_results * candidatePoolFactor`),
//!    com piso de seeders sob `seedFloorFor` (invariante 3);
//! 7. **💾 de episódio** (`annotate_pack_sizes_core`/`annotate_movie_sizes_core`)
//!    — antes do debrid, como no TS;
//! 8. **applyDebrid** — [`DebridCheck`] (lote via `prepare`, depois por stream);
//! 9. **limitReservingBr** (corte final DEPOIS do pool ampliado, vagas BR por
//!    faixa);
//! 10. **aviso se vazia** (relativo, sem host) e conversão para o contrato.
//!
//! Fica para as próximas fatias: o index de releases (`releaseIndex.record`,
//! I/O) e o enriquecimento do magnet pelo banco (o caller injeta `dn=` via
//! `magnet`).

mod audio_proof;
mod build;
// Seleção dos efeitos de cauda (dub_audit/warmer) sobre o lote pós-debrid.
mod effects;
mod file_wants;
mod finalize;
mod finalize_play;
mod helpers;
mod stats;
mod stream_map;
mod types;
mod types_context;

#[cfg(test)]
#[path = "file_wants_tests.rs"]
mod file_wants_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "tests_bludv_br.rs"]
mod tests_bludv_br;

pub use audio_proof::{apply_pt_title_dual, AudioAudit};
pub use build::{build_stream_list, relevant_count};
pub use effects::{AuditSeed, AutofetchItem, EffectSeeds, WarmerSeed};
pub use file_wants::pack_hashes_missing_files;
pub use types::{
    apply_notice_origin, seed_floor_for, BuildContext, BuildOptions, BuiltList, BuiltStream,
    DebridAnswer, DebridCheck, WorkHint,
};
