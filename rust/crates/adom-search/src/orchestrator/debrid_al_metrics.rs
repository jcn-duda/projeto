//! Contadores `debrid.al.*` da checagem AllDebrid nativa e da sombra
//! (nativo × Node). Namespace próprio para o `/metrics` do gateway — não se
//! mistura com `debrid.check.*` do Node nem com `stream.shadow.*`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

/// A checagem nativa rodou (modo `on`).
pub const NATIVE_CHECKS: &str = "debrid.al.native.checks";
/// A nativa respondeu `known:false` (lote perdido/prazo): o ⚡ fica só onde há
/// hit confirmado.
pub const NATIVE_KNOWN_FALSE: &str = "debrid.al.native.known_false";
/// A nativa respondeu `auth`/`quota` (a lista volta P2P).
pub const NATIVE_UNUSABLE: &str = "debrid.al.native.unusable";
/// O modo `on` caiu no fallback Node porque nenhum upload foi enviado.
pub const NATIVE_FALLBACK: &str = "debrid.al.native.fallback";
/// Feed de holds (`DEBRID_AL_HOLDS`): fatos aceitos e cobrindo o lote.
pub const HOLDS_OK: &str = "debrid.al.holds.ok";
/// Feed indisponível/erro (sem resposta, HTTP, corpo estranho): nativa
/// read-only nesta busca.
pub const HOLDS_MISSING: &str = "debrid.al.holds.missing";
/// Feed respondeu, mas a cobertura do lote não fechou (ou o flag veio falso):
/// nativa read-only (`holds_incomplete` no plano, quando houver).
pub const HOLDS_INCOMPLETE: &str = "debrid.al.holds.incomplete";
/// A conta do feed difere da conta da checagem: fatos descartados.
pub const HOLDS_ACCOUNT_MISMATCH: &str = "debrid.al.holds.account_mismatch";

pub const COMPARED: &str = "debrid.al.shadow.compared";
pub const DIVERGENCE: &str = "debrid.al.shadow.divergence";
pub const ITEMS_MISSING: &str = "debrid.al.shadow.items_missing";
pub const ITEMS_EXTRA: &str = "debrid.al.shadow.items_extra";
pub const TIMEOUT: &str = "debrid.al.shadow.timeout";
pub const ERROR: &str = "debrid.al.shadow.error";
/// Não houve par (Node `known:false`/unusable, ou nativa sem veredito).
pub const SKIPPED: &str = "debrid.al.shadow.skipped";
/// Fora da amostra (`DEBRID_AL_SHADOW_PERCENT`).
pub const SKIPPED_SAMPLE: &str = "debrid.al.shadow.skipped_sample";

const KEYS: &[&str] = &[
    NATIVE_CHECKS,
    NATIVE_KNOWN_FALSE,
    NATIVE_UNUSABLE,
    NATIVE_FALLBACK,
    HOLDS_OK,
    HOLDS_MISSING,
    HOLDS_INCOMPLETE,
    HOLDS_ACCOUNT_MISMATCH,
    COMPARED,
    DIVERGENCE,
    ITEMS_MISSING,
    ITEMS_EXTRA,
    TIMEOUT,
    ERROR,
    SKIPPED,
    SKIPPED_SAMPLE,
];

/// Contadores baratos (`Arc<Mutex<..>>`), como as outras sombras.
#[derive(Clone, Default)]
pub struct DebridAlMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl DebridAlMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        let _ = metrics.snapshot();
        metrics
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        for key in KEYS {
            guard.entry((*key).to_string()).or_insert(0);
        }
        guard.clone()
    }

    pub fn inc(&self, key: &str, by: u64) {
        if by == 0 {
            return;
        }
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry = (*entry).saturating_add(by);
    }
}

static GLOBAL: OnceLock<DebridAlMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static DebridAlMetrics {
    GLOBAL.get_or_init(DebridAlMetrics::new)
}

/// Snapshot das métricas `debrid.al.*` para o `/metrics` do gateway.
pub fn debrid_al_metrics_snapshot() -> BTreeMap<String, u64> {
    let mut out = global_metrics().snapshot();
    // Limpeza nativa (`DEBRID_AL_CLEANUP`) mora no adom-debrid; os contadores
    // `debrid.al.cleanup.*` entram no MESMO namespace.
    for (key, value) in adom_debrid::alldebrid_cleanup::metrics_snapshot() {
        out.insert(key, value);
    }
    out
}
