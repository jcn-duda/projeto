//! Limpeza segura da AllDebrid — porte de `src/debrid/protected.ts` e da
//! decisão de `src/debrid/alldebrid-check.ts`, atrás de `DEBRID_AL_CLEANUP`
//! (default do CÓDIGO **OFF**; o default do CORTE desde o F4.6 é **ON**, junto
//! com `DEBRID_AL_HOLDS=on`).
//!
//! A checagem da AllDebrid é um `/magnet/upload` real: sem limpeza cada busca
//! deixa dezenas de magnets na conta até estourar o teto e derrubar o ⚡. O
//! perigo anda junto: o autofetch sobe DE PROPÓSITO um torrent que ainda não
//! está pronto, então o `dropUncached` apagaria o download no meio.
//!
//! Duas camadas de proteção, como no Node:
//!
//! - **volátil** — [`Holds`] em memória com TTL (hold do autofetch em voo) e o
//!   fato `held` entregue pelo chamador;
//! - **durável** — `adprot:v1:alldebrid:<conta>:<hash>` no `cache.db` (retenção
//!   BR do autofetch). Lido em modo read-only por [`DurablePeek`]; o `adsub:v1`
//!   do mesmo banco marca o que o addon subiu (e pode sair) e o `adrm:v1` marca
//!   o que a limpeza apagou DE PROPÓSITO — aqui é filtro de UPLOAD, nunca veto
//!   de delete: ele só tira o hash do `/magnet/upload` da checagem. Na
//!   evicção (`autofetch_ports_evict.rs`) a marca vale como o contrário de
//!   posse: hash removido de propósito nunca é provado como nosso.
//!
//! `knownBefore` é o snapshot da conta ANTES do upload: o que já era do usuário
//! não sai. O Rust carrega o próprio snapshot por `/magnet/status` (TTL
//! `ALLDEBRID_PREEXISTING_TTL_MS`) e subtrai a posse (`adsub` durável +
//! `submitted` desta instância). Sem snapshot, ninguém sai (fail-safe).
//!
//! **Contrato que o Rust NÃO tem:** o hold volátil do autofetch mora no processo
//! do Node. Por isso a limpeza só nasce com `holds_complete` (o chamador prova
//! que `held` cobre todos os hashes do lote). Sem esse fato — e hoje o caminho
//! nativo não o recebe — a nativa fica READ-ONLY mesmo com a flag ON: o plano é
//! devolvido em `CacheReport.cleanup` para diagnóstico, mas nasce suprimido e
//! não é executado.
//!
//! Fora desta fatia (seguem Node): varredura de mortos/não-dublados, evicção
//! por busca, reconcile, revalidate suprimida, `davail` e o `fsz`.

#[path = "cleanup_flags.rs"]
mod flags;
pub use flags::{
    env_truthy, kill_switch_on, reupload_block_enabled, CleanupMode, CACHE_DB_ENV, CLEANUP_ENV,
    KILL_ENV, PREEXISTING_TTL_ENV, REUPLOAD_BLOCK_ENV, REUPLOAD_TTL_ENV,
};
#[cfg(test)]
pub(crate) use flags::{reupload_block_enabled_from, reupload_flag_from, reupload_ttl_ms_from};

#[path = "cleanup_holds.rs"]
mod holds;
pub use holds::{
    hold, holds, is_held, release, remember_submitted, reset_submitted, submitted_hashes, Holds,
    Submitted,
};

#[path = "cleanup_durable.rs"]
mod durable;
#[cfg(test)]
pub(crate) use durable::warn_missing_cache_db_once;
pub use durable::{account_scope, adhold_key, adprot_key, adrm_key, adsub_key, DurablePeek};

#[path = "cleanup_inventory.rs"]
mod inventory;
pub use inventory::{inventory, known_before, refresh_known_before, Inventory};

#[path = "cleanup_plan.rs"]
mod plan;
pub use plan::{
    classify_drop, CleanTarget, CleanupGate, CleanupPlan, CleanupSuppressed, DropVerdict,
};

#[path = "cleanup_metrics.rs"]
mod metrics;
pub use metrics::{
    bump, metrics_snapshot, METRIC_FAILED, METRIC_KNOWN_BEFORE, METRIC_PLANNED, METRIC_PROTECTED,
    METRIC_REMOVED, METRIC_STOPPED, METRIC_SUPPRESSED,
};

#[cfg(test)]
#[path = "alldebrid_cleanup_tests.rs"]
mod cleanup_tests;
