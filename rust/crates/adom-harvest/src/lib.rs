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
//! - **Não** pluga Jackett nem gateway — o [`HarvestWorker`] só orquestra
//!   freio/teto/`take_head` e delega ao callback ([`HarvestDrain`] sync ou
//!   [`HarvestDrainAsync`]); quem fala rede é o chamador.
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
//! | [`prioritize`] / [`BrEvidence`] | Reordenação com evidência BR injetável |
//! | [`HarvestQueue`] | Memória: enqueue / take_head / prioritize / load_from |
//! | [`HarvestStore`] | L2 SQLite (WAL): `open` / `open_memory` / `load` / `save` |
//! | [`Lease`] / [`InflightEntry`] | Claim DURÁVEL da obra em voo (sobrevive ao restart) |
//! | [`seen_key`] / [`was_recently_queued`] | Dedupe 12h por obra+motivo |
//! | [`HarvestInflight`] / [`HarvestIntent`] | Coalescing da obra em voo (slot único) |
//! | [`hour_key`] / [`load_hour`] / [`save_hour`] | Balde horário durável (`harvest:v1:hour`) |
//! | [`BrProbe`] / [`probe_key`] | Sonda BR: estados, lease e `pending` a partir da fila |
//! | [`JournalRun`] / [`journal_key`] | Journal do run (`harvest:v1:run:<id>`, TTL 24 h) |
//! | [`OutboxItem`] / [`OUTBOX_KEY`] | Outbox de invalidação: lote com tentativas + cemitério |
//! | [`HarvestWorker`] / [`tick`](HarvestWorker::tick) | Ciclo: freio + teto + `take_head` + drain |
//! | [`HarvestDrainAsync`] / [`tick_async`](HarvestWorker::tick_async) | Mesma decisão, drain que espera rede (gateway) |
//! | [`queue_key`] | `harvest:v1:q` (via `adom-core::prefix`) |
//!
//! A foto de `BrEvidence` (índice nativo) mora no gateway; este crate só
//! ordena e evicta com o snapshot recebido.

mod hour;
mod inflight;
mod intent;
mod journal;
mod lease;
mod outbox;
mod prioritize;
mod probe;
mod queue;
mod queue_config;
mod reason;
mod seen;
mod store;
mod types;
mod worker;
mod worker_types;

pub use hour::{
    hour_bucket, hour_key, hour_ttl_seconds, load_hour, save_hour, HourMeter, StoredHour, HOUR_KEY,
    HOUR_MS,
};
pub use inflight::{HarvestInflight, HarvestIntent, PendingIntent};
pub use journal::{journal_key, JournalRun, JOURNAL_PREFIX, JOURNAL_TTL_SECONDS};
pub use lease::{
    InflightEntry, Lease, TerminalEntry, LEASE_TTL_MS, MAX_CLAIM_ATTEMPTS, TERMINAL_TTL_SECONDS,
};
pub use outbox::{
    OutboxItem, OUTBOX_BATCH_LIMIT, OUTBOX_DEAD_KEY, OUTBOX_KEY, OUTBOX_MAX_TRIES,
    OUTBOX_TTL_SECONDS,
};
pub use prioritize::{
    br_evidence_rank, prioritize, priority_tier, BrEvidence, PrioritizeConfig, StubBrEvidence,
};
pub use probe::{
    probe_identity, probe_key, BrProbe, DEFAULT_PROBE_TTL_SECONDS, PENDING_LEASE_MS,
    PROBE_NAMESPACE, RETRY_MS,
};
pub use queue::{
    queue_key, HarvestQueue, HarvestQueueConfig, HARVEST_NAMESPACE, QUEUE_KEY, QUEUE_SUFFIX,
};
pub use reason::{
    entry_identity, is_promotion, is_recent_br_gap, is_valid_imdb_id, obra_identity,
    reason_priority, BR_GAP_PRIORITY_WINDOW_MS,
};
pub use seen::{
    entry_seen_key, mark_recently_queued, seen_key, was_recently_queued, DEDUPE_TTL_SECONDS,
};
pub use store::{HarvestStore, StoredQueue, DEFAULT_ENTRY_TTL_SECONDS};
pub use types::{
    BrProbeRecord, BrProbeState, BrProbeWork, EnqueueOutcome, EnqueueReason, HarvestEntry,
    HarvestMediaType, HarvestRequest, PendingFull, ProbeConfig, ProbeFinal, RequestProbeResult,
};
pub use worker::{
    DrainOutcome, HarvestDrain, HarvestDrainAsync, HarvestWorker, HarvestWorkerConfig, StubTraffic,
    TickOutcome, TickStart, TrafficSense,
};
