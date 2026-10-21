//! Contadores `debrid.al.*` da checagem AllDebrid nativa. Namespace próprio
//! para o `/metrics` do gateway — não se mistura com `debrid.check.*` do Node.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

/// A checagem nativa rodou.
pub const NATIVE_CHECKS: &str = "debrid.al.native.checks";
/// A nativa respondeu `known:false` (lote perdido/prazo): o ⚡ fica só onde há
/// hit confirmado.
pub const NATIVE_KNOWN_FALSE: &str = "debrid.al.native.known_false";
/// A nativa respondeu `auth`/`quota` (a lista volta P2P).
pub const NATIVE_UNUSABLE: &str = "debrid.al.native.unusable";
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

const KEYS: &[&str] = &[
    NATIVE_CHECKS,
    NATIVE_KNOWN_FALSE,
    NATIVE_UNUSABLE,
    HOLDS_OK,
    HOLDS_MISSING,
    HOLDS_INCOMPLETE,
    HOLDS_ACCOUNT_MISMATCH,
];

/// Contadores baratos (`Arc<Mutex<..>>`), como as demais métricas.
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

/// Contabiliza uma checagem nativa do caminho vivo.
pub fn note_native(check: &adom_debrid::verdict::ServiceCheck) {
    let metrics = global_metrics();
    metrics.inc(NATIVE_CHECKS, 1);
    if check.outcome.unusable.is_some() {
        metrics.inc(NATIVE_UNUSABLE, 1);
    }
    if !check.outcome.known {
        metrics.inc(NATIVE_KNOWN_FALSE, 1);
    }
}

/// Feed de holds aceito e cobrindo o lote (`DEBRID_AL_HOLDS`).
pub fn note_holds_ok() {
    global_metrics().inc(HOLDS_OK, 1);
}

/// Feed indisponível: a nativa segue read-only nesta busca.
pub fn note_holds_missing() {
    global_metrics().inc(HOLDS_MISSING, 1);
}

/// Feed respondeu, mas a cobertura do lote não fechou: read-only.
pub fn note_holds_incomplete() {
    global_metrics().inc(HOLDS_INCOMPLETE, 1);
}

/// Fatos de outra conta: descartados (nunca limpar com prova alheia).
pub fn note_holds_account_mismatch() {
    global_metrics().inc(HOLDS_ACCOUNT_MISMATCH, 1);
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
