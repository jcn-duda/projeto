//! Contadores `rust.debrid.*` da API interna. O `/metrics.json` do Node só
//! mistura estes números quando algum serviço está em `DEBRID_RUST_SERVICES`.

use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct Metrics {
    counts: Mutex<BTreeMap<String, u64>>,
}

impl Metrics {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inc(&self, key: &str) {
        self.add(key, 1);
    }

    pub fn add(&self, key: &str, n: u64) {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        *guard.entry(key.to_string()).or_insert(0) += n;
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        self.counts
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }
}
