//! Apoio dos testes do catálogo: porta falsa, fatos falsos e builders de linha.
//! Compartilhado por `account_catalog_ops_tests` e `account_catalog_clean_tests`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use adom_catalog::dedup::DeleteResponse;
use adom_catalog::rows::{CatalogStore, Row};
use adom_catalog::scan::{FileEvidence, Magnet, WorkRef};
use serde_json::Value;

use super::facts::CatalogFacts;
use super::ops::{Deps, Knobs};
use super::port::{AccountCatalogPort, CatalogFile, PortFuture};

pub(super) const ACCOUNT: &str = "conta-teste";
pub(super) const ADAPTER: &str = "alldebrid";
pub(super) const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/// Porta falsa: a listagem é configurável, e só os ids em `ack` saem da conta.
pub(super) struct FakePort {
    pub(super) magnets: Result<Vec<Magnet>, String>,
    pub(super) files: HashMap<String, Vec<CatalogFile>>,
    pub(super) files_err: HashSet<String>,
    pub(super) ack: HashSet<String>,
    pub(super) known: Option<HashSet<String>>,
    pub(super) deleted: Mutex<Vec<String>>,
}

impl FakePort {
    pub(super) fn new(magnets: Result<Vec<Magnet>, String>, ack: &[&str]) -> Self {
        Self {
            magnets,
            files: HashMap::new(),
            files_err: HashSet::new(),
            ack: ack.iter().map(|id| id.to_string()).collect(),
            known: Some(HashSet::new()),
            deleted: Mutex::new(Vec::new()),
        }
    }
}

impl AccountCatalogPort for FakePort {
    fn list(&self) -> PortFuture<'_, Vec<Magnet>> {
        let reply = self.magnets.clone();
        Box::pin(async move { reply })
    }

    fn files(&self, service_id: String) -> PortFuture<'_, Vec<CatalogFile>> {
        let reply = if self.files_err.contains(&service_id) {
            Err("falha simulada".to_string())
        } else {
            Ok(self.files.get(&service_id).cloned().unwrap_or_default())
        };
        Box::pin(async move { reply })
    }

    fn delete(&self, ids: Vec<String>) -> PortFuture<'_, DeleteResponse> {
        let removed: Vec<String> = ids
            .iter()
            .filter(|id| self.ack.contains(*id))
            .cloned()
            .collect();
        self.deleted.lock().unwrap().extend(ids);
        let reply = DeleteResponse {
            ok: removed.len() as i64,
            falhas: Vec::new(),
            removed_ids: Some(removed),
        };
        Box::pin(async move { Ok(reply) })
    }

    fn known_before(&self) -> PortFuture<'_, Option<HashSet<String>>> {
        let reply = self.known.clone();
        Box::pin(async move { Ok(reply) })
    }
}

/// Fatos falsos: proteção por conjunto, e os efeitos gravados para inspeção.
#[derive(Default)]
pub(super) struct FakeFacts {
    pub(super) protected: HashSet<String>,
    pub(super) hooks: Mutex<Vec<(String, Option<String>)>>,
    pub(super) recorded: Mutex<Vec<String>>,
}

impl CatalogFacts for FakeFacts {
    fn protected(&self, hash: &str) -> bool {
        self.protected.contains(hash)
    }
    fn release_status(&self, _hash: &str) -> String {
        "unknown".to_string()
    }
    fn file_evidence(&self, _hash: &str) -> Option<FileEvidence> {
        None
    }
    fn reverse_index(&self) -> Result<HashMap<String, WorkRef>, String> {
        Ok(HashMap::new())
    }
    fn audio_lists(&self) -> (Vec<String>, Vec<String>) {
        (vec!["dublado".to_string()], vec!["rarbg".to_string()])
    }
    fn on_deleted(&self, hash: &str, filename: Option<&str>) {
        self.hooks
            .lock()
            .unwrap()
            .push((hash.to_string(), filename.map(str::to_string)));
    }
    fn record_evidence(&self, hash: &str, _files: &[CatalogFile]) {
        self.recorded.lock().unwrap().push(hash.to_string());
    }
}

pub(super) fn knobs() -> Knobs {
    Knobs {
        cleanup_min_age_ms: 0,
        cleanup_max: 100,
        audit_max: 20,
        audit_concurrency: 2,
    }
}

pub(super) fn deps(store: Arc<CatalogStore>, port: FakePort, facts: Arc<FakeFacts>) -> Arc<Deps> {
    Arc::new(Deps {
        store,
        account: ACCOUNT.to_string(),
        adapter: ADAPTER.to_string(),
        port: Arc::new(port),
        facts,
        knobs: knobs(),
    })
}

pub(super) fn row(
    service: &str,
    hash: &str,
    filename: &str,
    size: i64,
    ready: bool,
    uploaded: i64,
) -> Row {
    Row {
        adapter: ADAPTER.to_string(),
        account: ACCOUNT.to_string(),
        service_id: service.to_string(),
        hash: hash.to_string(),
        filename: filename.to_string(),
        size,
        ready: i64::from(ready),
        uploaded_at: uploaded,
        first_seen_at: 1,
        last_seen_at: 1,
        cached: "unknown".to_string(),
        cached_at: 1,
        ..Row::default()
    }
}

pub(super) fn magnet(service: &str, hash: &str, filename: &str, size: i64) -> Magnet {
    Magnet {
        id: Some(service.to_string()),
        hash: hash.to_string(),
        filename: filename.to_string(),
        size,
        status: String::new(),
        ready: true,
        upload_date: 1000,
    }
}

pub(super) fn store_with(rows: Vec<Row>) -> Arc<CatalogStore> {
    let store = CatalogStore::open_memory().unwrap();
    for item in &rows {
        store.put_row(item).unwrap();
    }
    Arc::new(store)
}

pub(super) fn alive(store: &CatalogStore, service: &str) -> bool {
    store
        .get_row(ADAPTER, ACCOUNT, service)
        .unwrap()
        .is_some_and(|r| r.deleted_at == 0)
}

pub(super) fn num(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or(-1)
}
