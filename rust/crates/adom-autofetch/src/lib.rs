//! Estado durável do Chupim (autofetch) sobre o `cache.db` compartilhado.
//!
//! Crate **puro**: fila, lease do hash em voo (`hold`), marker de aceite, obras
//! que desistiram (`suppressed`), obra/episódio terminal e o registro de obra.
//! Sem rede, sem tokio, sem debrid — a execução (checagem de cache, enqueue no
//! serviço, recheck) é do worker da T3-L5/T3-L6.
//!
//! # Dono do namespace
//!
//! `autofetch:v1` é do Rust a partir da T3-L5 (`RUST_OWNED_PREFIXES`). Enquanto
//! o Node drena, as chaves dele são outras (`q:<sha>`, `m:`, `sup:`, `dead:`),
//! então as duas metades convivem no mesmo `cache.db` sem se atropelar.
//!
//! # Relógio
//!
//! Nenhuma função lê o relógio: `now_ms` entra por parâmetro e o TTL é aplicado
//! pelo [`adom_store::kv::NativeKv`]. É o que torna os testes determinísticos.
//!
//! # Exemplo
//!
//! ```no_run
//! use adom_autofetch::{AutofetchQueue, EnqueueOutcome};
//! use adom_store::kv::NativeKv;
//!
//! let queue = AutofetchQueue::new(NativeKv::open_memory().unwrap());
//! assert_eq!(queue.enqueue("tt1", None, 1_000).unwrap(), EnqueueOutcome::Enqueued);
//! let hold = queue.hold("tt1", None, "hash-a", 1_000).unwrap();
//! queue.release(&hold, true, 1_001).unwrap();
//! assert!(queue.marker("hash-a", 1_002).unwrap().is_some());
//! ```

pub mod queue;
pub mod state;
pub mod suppressed;
pub mod terminal;

pub use queue::{AutofetchQueue, EnqueueOutcome, Hold};
pub use state::{Episode, MarkerRecord, ObraRecord, QueueEntry, SuppressedRecord, TerminalRecord};
