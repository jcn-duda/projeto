//! `adom-harvest` — embrião da **Fase E** (fila do colhedor).
//!
//! # O que é
//!
//! Representa a fila `harvest:v1:q` do addon: obras a colher em **fundo**,
//! alimentando o índice de releases. Espelha o contrato de
//! `src/providers/harvest-queue.ts` (+ `harvest-reason.ts`).
//!
//! # O que NÃO é
//!
//! - **Não** roda no caminho de `/stream`. Quem responde a busca usa o índice
//!   já preenchido; o colhedor só enfileira / drena fora da resposta.
//! - **Não** é o worker Jackett (`harvest-worker.ts`) nem o ciclo tick/drain
//!   (`harvester.ts`).
//! - **Não** decide cobertura do índice — contagem pura nunca decide;
//!   `idxPoolCovered` continua no release-index.
//!
//! # API desta fatia
//!
//! | Item | Papel |
//! |---|---|
//! | [`HarvestEntry`] / [`HarvestRequest`] | Entrada da fila |
//! | [`EnqueueOutcome`] | Aceite / motivo (`queued`, `promoted`, …) |
//! | [`obra_identity`] / [`reason_priority`] | Identidade e promoção |
//! | [`HarvestQueue`] | Memória: enqueue / take_head / head / tail + load_from / save_to |
//! | [`HarvestStore`] | L2 SQLite (WAL): `open` / `open_memory` / `load` / `save` |
//! | [`queue_key`] | `harvest:v1:q` (via `adom-core::prefix`) |
//!
//! Priorização BR, dedupe 12h, inflight e tick: **ainda não** — ver `README.md`.

mod queue;
mod reason;
mod store;
mod types;

pub use queue::{
    queue_key, HarvestQueue, HarvestQueueConfig, HARVEST_NAMESPACE, QUEUE_KEY, QUEUE_SUFFIX,
};
pub use reason::{
    entry_identity, is_promotion, is_recent_br_gap, is_valid_imdb_id, obra_identity,
    reason_priority, BR_GAP_PRIORITY_WINDOW_MS,
};
pub use store::{HarvestStore, DEFAULT_ENTRY_TTL_SECONDS};
pub use types::{
    EnqueueOutcome, EnqueueReason, HarvestEntry, HarvestMediaType, HarvestRequest,
};
