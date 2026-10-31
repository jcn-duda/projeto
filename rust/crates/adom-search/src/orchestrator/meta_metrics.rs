//! Contadores do caminho de metadados NATIVOS × fallback Node (Fase 2).
//!
//! `meta.*` mede, por chamada de `FallbackMetaSource::resolve`, quem respondeu:
//! o primário nativo (completo, incompleto ou erro) e, quando o Node é
//! chamado, se ele devolveu título real, vazio ou erro. `meta.resolve.total`
//! é o denominador da taxa.
//!
//! `meta.native.incomplete` existe porque `meta_from_lookup` preenche `name`
//! com o próprio IMDb quando os títulos faltaram: o gate de "nome vazio" do
//! fallback NÃO dispara nesse caso, e a taxa de fallback pareceria zero mesmo
//! sem título utilizável. Aqui só se MEDE — mudar o gate fica para depois da
//! medição em produção.
//!
//! Exposto em `/metrics` do gateway por [`meta_metrics_snapshot`].

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Toda chamada a `FallbackMetaSource::resolve` (denominador da taxa).
pub const RESOLVE_TOTAL: &str = "meta.resolve.total";
/// Primário devolveu título real (nome não vazio e diferente do IMDb).
pub const NATIVE_OK: &str = "meta.native.ok";
/// Primário Ok, mas `name` vazio OU igual ao IMDb: os títulos faltaram. O
/// comportamento segue o de hoje (o gate é por nome vazio).
pub const NATIVE_INCOMPLETE: &str = "meta.native.incomplete";
/// Primário devolveu Err — o Node é chamado, como hoje.
pub const NATIVE_ERROR: &str = "meta.native.error";
/// Node Ok com título real e essa resposta foi devolvida.
pub const FALLBACK_USED: &str = "meta.fallback.used";
/// Node Ok sem título real (devolveu o parcial do nativo).
pub const FALLBACK_EMPTY: &str = "meta.fallback.empty";
/// Node Err (devolveu o parcial do nativo, ou propagou o erro como hoje).
pub const FALLBACK_ERROR: &str = "meta.fallback.error";

const KEYS: &[&str] = &[
    RESOLVE_TOTAL,
    NATIVE_OK,
    NATIVE_INCOMPLETE,
    NATIVE_ERROR,
    FALLBACK_USED,
    FALLBACK_EMPTY,
    FALLBACK_ERROR,
];

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
    /// flush do deploy anterior do KV nativo). Chave fora das 7 vivas é
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
