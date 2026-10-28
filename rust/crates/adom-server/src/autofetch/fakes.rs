//! Stubs do worker nativo: adaptador de debrid sem rede e lote pronto.
//!
//! Compartilhados por `vault_tests`, `enqueue_tests`, `recheck_tests` e
//! `serve_tests` — a mesma resposta do "serviço" em todos, para o teste medir o
//! ciclo e não o dublê.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use adom_autofetch::v3::{
    AccountEvidence, AutofetchDebrid, CacheEvidence, DebridFuture, EnqueueEvidence, QueueCandidate,
    TorrentEvidence,
};
use serde_json::{Map, Value};

use super::enqueue::Job;
use super::ports::{DebridFactory, DebridIo};

/// Evidência de status de um hash.
pub(crate) fn evidence(hash: &str, state: &str) -> TorrentEvidence {
    TorrentEvidence {
        state: state.to_string(),
        stalled: false,
        transfer_id: Some(format!("id-{hash}")),
        via_id: false,
        progress: None,
    }
}

/// Serviço de mentira com respostas escolhidas pelo teste.
#[derive(Default)]
pub(crate) struct FakeDebrid {
    /// `known == false` é cache desconhecido (não é lista de misses).
    pub(crate) known: bool,
    pub(crate) cached: Vec<String>,
    pub(crate) accept: bool,
    pub(crate) fail_check: bool,
    pub(crate) fail_status: bool,
    pub(crate) states: BTreeMap<String, TorrentEvidence>,
    pub(crate) removed: Mutex<Vec<String>>,
    pub(crate) accepted: Mutex<Vec<String>>,
}

impl FakeDebrid {
    /// Serviço saudável: cache conhecido e enqueue aceito.
    pub(crate) fn accepting() -> Self {
        Self {
            known: true,
            accept: true,
            ..Self::default()
        }
    }

    /// Cache desconhecido: nada a decidir.
    pub(crate) fn unknown_cache() -> Self {
        Self::default()
    }

    pub(crate) fn cached(mut self, hash: &str) -> Self {
        self.cached.push(hash.to_string());
        self
    }

    pub(crate) fn state(mut self, hash: &str, state: &str) -> Self {
        self.states.insert(hash.to_string(), evidence(hash, state));
        self
    }

    pub(crate) fn removed(&self) -> Vec<String> {
        self.removed.lock().unwrap().clone()
    }

    pub(crate) fn accepted(&self) -> Vec<String> {
        self.accepted.lock().unwrap().clone()
    }
}

impl AutofetchDebrid for FakeDebrid {
    type Error = String;

    fn enqueue<'a>(
        &'a self,
        candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, String> {
        Box::pin(async move {
            self.accepted
                .lock()
                .unwrap()
                .push(candidate.info_hash.clone());
            Ok(EnqueueEvidence {
                accepted: self.accept,
                transfer_id: self.accept.then(|| format!("id-{}", candidate.info_hash)),
            })
        })
    }

    fn status<'a>(
        &'a self,
        _hashes: &'a [String],
        _transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, String> {
        Box::pin(async move {
            if self.fail_status {
                return Err("status indisponível".to_string());
            }
            Ok(self.states.clone())
        })
    }

    fn check<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, String> {
        Box::pin(async move {
            if self.fail_check {
                return Err("checagem indisponível".to_string());
            }
            Ok(CacheEvidence {
                known: self.known,
                cached: self.cached.clone(),
            })
        })
    }

    fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, String> {
        Box::pin(async move {
            self.removed.lock().unwrap().push(transfer_id.to_string());
            Ok(true)
        })
    }

    fn evict<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, Vec<String>, String> {
        Box::pin(async move { Ok(Vec::new()) })
    }

    fn account(&self) -> DebridFuture<'_, AccountEvidence, String> {
        Box::pin(async move {
            Ok(AccountEvidence {
                used: None,
                max: None,
            })
        })
    }
}

/// Lote `autofetch_batch` com itens `(hash, dublado_br)`.
pub(crate) fn batch_payload(search_key: &str, items: &[(&str, bool)]) -> Map<String, Value> {
    let items: Vec<Value> = items
        .iter()
        .map(|(hash, br)| {
            serde_json::json!({
                "infoHash": hash,
                "title": "Titulo de Teste",
                "name": "Titulo de Teste 1080p",
                "_quality": "1080p",
                "_seeders": 40,
                "_br": br,
                "_dubbed": true
            })
        })
        .collect();
    serde_json::from_value(serde_json::json!({
        "searchKey": search_key,
        "imdbId": "tt1234567",
        "season": 1,
        "episode": 2,
        "items": items
    }))
    .unwrap()
}

/// Trabalho do canal com o escopo da conta.
pub(crate) fn job(scope: &str, payload: Map<String, Value>) -> Job {
    Job {
        scope: scope.to_string(),
        payload,
    }
}

/// Escopo de teste (`adapter:sha256`).
pub(crate) const SCOPE: &str = "alldebrid:conta-de-teste";

/// Fábrica de teste: UM adaptador para o escopo dado, `None` para o resto — é a
/// resolução por conta que o laço faz a cada passo.
pub(crate) fn factory_for(scope: &str, debrid: DebridIo) -> DebridFactory {
    let scope = scope.to_string();
    Arc::new(move |asked: &str| (asked == scope).then(|| Arc::clone(&debrid)))
}

/// Fábrica que não resolve escopo nenhum.
pub(crate) fn no_factory() -> DebridFactory {
    Arc::new(|_: &str| None)
}
