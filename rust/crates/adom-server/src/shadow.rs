//! Sombra de `/stream` (`ROUTES_RUST=stream-shadow`).
//!
//! O Node continua respondendo; este módulo só observa. Sem orquestrador que
//! remonte a lista, a comparação real (§9 do contrato) ainda não existe — os
//! contadores `stream.shadow.divergence*` ficam em zero de propósito. Incrementar
//! divergência “à toa” envenenaria o critério de corte.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::StatusCode;

/// Nomes do contrato `docs/rust-stream-contract.md` §9.2.
pub const COMPARED: &str = "stream.shadow.compared";
pub const DIVERGENCE: &str = "stream.shadow.divergence";
pub const DIVERGENCE_ITEMS: &str = "stream.shadow.divergence.items";
pub const TIMEOUT: &str = "stream.shadow.timeout";
pub const ERROR: &str = "stream.shadow.error";

const KEYS: &[&str] = &[COMPARED, DIVERGENCE, DIVERGENCE_ITEMS, TIMEOUT, ERROR];

/// Contadores da sombra. Sempre expõe as chaves do §9 (zeradas até haver
/// remontador). `Clone` barato via `Arc` para o `tokio::spawn`.
#[derive(Clone, Default)]
pub struct ShadowMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl ShadowMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        // Garante snapshot com as chaves do contrato mesmo sem nenhuma observação.
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

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

/// `true` para `/stream/<type>/<id>.json` e `/<config>/stream/<type>/<id>.json`.
/// Espelha a forma aceita por `adom_search::parse_stream_path` sem puxar aquele
/// crate (F0 do gateway não depende do orquestrador).
pub fn is_stream_path(path: &str) -> bool {
    if path.contains('?') || path.contains('#') || !path.starts_with('/') {
        return false;
    }
    let mut raw: Vec<&str> = Vec::new();
    for segment in path[1..].split('/') {
        if segment.is_empty() {
            return false;
        }
        raw.push(segment);
    }
    if raw.iter().any(|s| s.contains('%')) {
        return false;
    }
    let rest = match raw.as_slice() {
        ["stream", _, _] => &raw[..],
        ["stream", ..] => return false,
        [config, "stream", _, _] if is_config_segment(config) => &raw[1..],
        _ => return false,
    };
    let kind = rest[1];
    let Some(id) = rest[2].strip_suffix(".json") else {
        return false;
    };
    !kind.is_empty() && !id.is_empty()
}

fn is_config_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 8192
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Observação fire-and-forget do corpo que o Node devolveu.
///
/// Stub honesto: captura o body (e o status) para o gancho futuro, mas **não**
/// incrementa `divergence` / `compared` / `items`. Sem remontador Rust não há
/// segundo corpo comparável — acusar divergência seria falso positivo.
pub fn observe_node_response(_status: StatusCode, _body: Bytes, _metrics: ShadowMetrics) {
    // Paridade real chega quando o orquestrador existir (F1). Até lá os
    // contadores §9 permanecem zerados via `snapshot()`.
}
