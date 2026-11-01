//! Contadores do caminho de metadados NATIVOS.
//!
//! Quem incrementa: o `NativeMetaSource::resolve`, via `record_native_outcome`
//! (migração antecipada do passo 2 do corte de 2026-10-31) — eram do
//! `FallbackMetaSource`, que saiu junto com a rota Node; se ficassem lá, o
//! `/metrics` ficaria cego. Por resolução nativa: completa, incompleta ou erro.
//! `meta.resolve.total` é o denominador da taxa.
//!
//! `meta.native.incomplete` existe porque `meta_from_lookup` preenche `name` com
//! o próprio IMDb quando os títulos faltaram — com o fallback fora, é o único
//! sinal de metadado degradado que sobra no `/metrics`.
//!
//! Os `meta.fallback.*` foram APOSENTADOS no passo 2: sem wrapper não há o que
//! medir, e o `restore` descarta chave fora de `KEYS` (contador aposentado não
//! reaparece depois do deploy).
//!
//! Exposto em `/metrics` do gateway por [`meta_metrics_snapshot`].

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Toda resolução do `NativeMetaSource` (denominador da taxa) — com ou sem
/// fallback montado.
pub const RESOLVE_TOTAL: &str = "meta.resolve.total";
/// O nativo devolveu título real (nome não vazio e diferente do IMDb).
pub const NATIVE_OK: &str = "meta.native.ok";
/// O nativo voltou Ok, mas `name` vazio OU igual ao IMDb: os títulos
/// faltaram. O comportamento segue o de hoje (o gate é por nome vazio).
pub const NATIVE_INCOMPLETE: &str = "meta.native.incomplete";
/// O nativo devolveu Err (tipo desconhecido, id sem IMDb, falha do lookup).
pub const NATIVE_ERROR: &str = "meta.native.error";

const KEYS: &[&str] = &[RESOLVE_TOTAL, NATIVE_OK, NATIVE_INCOMPLETE, NATIVE_ERROR];

/// Contadores dos metadados. `Clone` barato (`Arc<Mutex<..>>`): em produção a
/// instância é a global; os testes usam uma local e não disputam estado.
#[derive(Clone, Default)]
pub struct MetaMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl MetaMetrics {
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

    /// Restaura contadores persistidos nesta instância (o boot do gateway lê o
    /// flush do deploy anterior do KV nativo). Chave fora das vivas é
    /// descartada: o `/metrics` não expõe contador aposentado.
    pub fn restore(&self, counts: BTreeMap<String, u64>) {
        for (key, by) in counts {
            if KEYS.contains(&key.as_str()) {
                self.inc(&key, by);
            }
        }
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

static GLOBAL: OnceLock<MetaMetrics> = OnceLock::new();

pub(super) fn global_metrics() -> &'static MetaMetrics {
    GLOBAL.get_or_init(MetaMetrics::new)
}

/// Snapshot das métricas `meta.*` para a rota `/metrics` do gateway.
pub fn meta_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}

/// Restaura o flush do deploy anterior na global (boot do gateway, via
/// `meta_metrics_flush`). A leitura falha fica no chamador — aqui só entra o
/// que é válido.
pub fn meta_metrics_restore(counts: BTreeMap<String, u64>) {
    global_metrics().restore(counts);
}

#[cfg(test)]
#[path = "meta_metrics_tests.rs"]
mod tests;
