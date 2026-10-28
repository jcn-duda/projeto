//! O formato REAL da fila do Chupim (`autofetch:v3`) — a que o Node grava e
//! drena hoje (`autofetch.ts`, `autofetch-drain.ts`).
//!
//! # Por que um módulo separado da fila `v1`
//!
//! A fila de [`crate::queue`] é o ALVO do plano (uma fila única por obra+episódio
//! com lease durável); a `v3` é o CONTRATO VIVO: uma fila POR BUSCA
//! (`q:<sha256(searchKey)>`) com [`QueueCandidate`] — hash, pool, br/dubbed/lied,
//! tamanho, seeders, `slotLimit`, sonda (`probeSeason`/`probeEpisode`). O dreno
//! do Node só conhece este formato: enfileirar nativo em `v1` faria o Chupim
//! parar de baixar sem erro visível. A T3-L5/L6 só pode fiar o worker quando
//! enqueue e dreno conversarem ESTE formato — daí o porto vir antes do wiring.
//!
//! # Fidelidade de round-trip com o TS
//!
//! - Chaves: `crypto.createHash('sha256').update(s).digest('hex')` é hex
//!   minúsculo — [`sha256_hex`] idem.
//! - Números: ver [`candidate::Number`]; campos desconhecidos preservados no
//!   `extra` (o `writeQueue` do Node espalha `{ ...c }` de volta); `null` ×
//!   ausente reproduzido como o `toQueueCandidate` grava.
//! - [`queue::QueueV3`] é o par do `writeQueue`/`readQueue`/`dropQueue` do
//!   Node sobre o [`NativeKv`]; blacklist e marker fazem parte do MESMO contrato
//!   do dreno (`dead:` filtra na escrita; `m:` é o `is_obsolete` do dreno). O
//!   `isDeadQuiet` do Node (peek sem LRU) não tem equivalente aqui: o `NativeKv`
//!   não tem LRU, toda leitura é "quiet".

mod candidate;
mod dispatch;
mod drain;
mod evict;
mod obra;
mod obra_reservation;
mod probe;
mod queue;
mod recheck;
mod season;
mod seeds;
mod suppressed;

use sha2::{Digest, Sha256};

pub use candidate::{Number, QueueCandidate};
pub use dispatch::{dispatch, DispatchDecision, DispatchInput};
pub use drain::{select_drain_candidate, DrainSelection};
pub use evict::{eligible_evictions, EvictCandidate, EvictInput};
pub use obra::ObraStoreV3;
pub use obra_reservation::{ObraLeaseV3, ObraReservationInput, ObraReservations};
pub use probe::{probe_blocks_seeds, probe_state, ProbeState};
pub use queue::{marker_value, QueueV3, WriteReport};
pub use recheck::{recheck_step, RecheckAction, RecheckInput};
pub use season::season_fill_eligible;
pub use seeds::seeds_stop;
pub use suppressed::{suppressed_key, Suppressed, SuppressedRetry, SuppressedV3};

/// Namespace inteiro da metade viva (a `v1` do [`crate::state`] é o alvo).
pub const NAMESPACE_V3: &str = "autofetch:v3";

/// `sha256` hex minúsculo da string — o mesmo digest do `queueKey` do Node.
pub fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Prefixo das filas por busca (`autofetch:v3:q:`).
pub fn queue_prefix() -> String {
    format!("{NAMESPACE_V3}:q:")
}

/// Fila de candidatos da busca: `autofetch:v3:q:<sha256(searchKey)>`.
pub fn queue_key(search_key: &str) -> String {
    format!("{}{}", queue_prefix(), sha256_hex(search_key))
}

/// Prefixo da blacklist de um adapter:conta (`autofetch:v3:dead:<a>:<c>:`).
pub fn dead_prefix(adapter_id: &str, account: &str) -> String {
    format!("{NAMESPACE_V3}:dead:{adapter_id}:{account}:")
}

/// Hash morto na conta: `autofetch:v3:dead:<adapter>:<conta>:<hash>` = `1`.
pub fn dead_key(adapter_id: &str, account: &str, info_hash: &str) -> String {
    format!(
        "{}{}",
        dead_prefix(adapter_id, account),
        info_hash.to_lowercase()
    )
}

/// Prefixo dos markers de um adapter:conta (`autofetch:v3:m:<a>:<c>:`).
pub fn marker_prefix(adapter_id: &str, account: &str) -> String {
    format!("{NAMESPACE_V3}:m:{adapter_id}:{account}:")
}

/// Marker de aceite: `autofetch:v3:m:<adapter>:<conta>:<hash>`.
pub fn marker_key(adapter_id: &str, account: &str, info_hash: &str) -> String {
    format!(
        "{}{}",
        marker_prefix(adapter_id, account),
        info_hash.to_lowercase()
    )
}

/// Prefetch legado (`autofetch:v3:pf:<conta>:<id>:<s>:<e>`). Só formato: não há
/// escritor em produção (o consumo morreu com o caminho antigo), mas a chave é
/// contrato da ponte e do teste TS.
pub fn prefetch_key(account: &str, id: &str, season: i64, episode: i64) -> String {
    format!("{NAMESPACE_V3}:pf:{account}:{id}:{season}:{episode}")
}
