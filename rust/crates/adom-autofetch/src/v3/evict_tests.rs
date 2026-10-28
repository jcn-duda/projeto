use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::Mutex;
use std::task::{Context, Poll, Waker};

use super::{
    eligible_evictions, execute, EvictAction, EvictCandidate, EvictInput, EvictReport, EvictSkip,
    EvictStop,
};
use crate::v3::debrid::{
    AccountEvidence, AutofetchDebrid, CacheEvidence, DebridFuture, EnqueueEvidence, TorrentEvidence,
};
use crate::v3::QueueCandidate;

fn candidate(hash: &str) -> EvictCandidate {
    EvictCandidate {
        hash: hash.into(),
        pool: "any".into(),
        overflow: false,
        marker_matches_work: true,
        owned: true,
        held: false,
        protected: false,
        accepted_at: 10,
    }
}

#[test]
fn precisa_de_prova_br_e_pula_overflow_hold_sem_posse_e_marker_de_outra_obra() {
    let mut rows = vec![
        candidate("A"),
        candidate("B"),
        candidate("C"),
        candidate("D"),
        candidate("E"),
    ];
    rows[1].overflow = true;
    rows[2].held = true;
    rows[3].owned = false;
    rows[4].marker_matches_work = false;
    let input = EvictInput {
        current_ready_is_br: false,
        work_has_prior_br_ready: false,
        now: 100,
        min_age_ms: 20,
        candidates: rows.clone(),
    };
    assert!(eligible_evictions(&input).is_empty());
    let input = EvictInput {
        current_ready_is_br: true,
        work_has_prior_br_ready: false,
        now: 100,
        min_age_ms: 20,
        candidates: rows,
    };
    assert_eq!(eligible_evictions(&input), vec!["a"]);
}

#[test]
fn idade_minima_e_aplicada_e_hash_deduplicado() {
    let input = EvictInput {
        current_ready_is_br: true,
        work_has_prior_br_ready: false,
        now: 20,
        min_age_ms: 15,
        candidates: vec![candidate("x"), candidate("X")],
    };
    assert!(eligible_evictions(&input).is_empty());
}

/// Duplo do debrid: fila roteirizada de respostas de `remove` + o que foi
/// pedido. Sem rede: o trait é o único contrato exercitado.
struct StubIo {
    results: Mutex<VecDeque<Result<bool, String>>>,
    calls: Mutex<Vec<String>>,
}

impl StubIo {
    fn new(results: Vec<Result<bool, String>>) -> Self {
        Self {
            results: Mutex::new(results.into()),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("trava").clone()
    }
}

impl AutofetchDebrid for StubIo {
    type Error = String;

    fn enqueue<'a>(
        &'a self,
        _candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, String> {
        Box::pin(async { Err("evict não enfileira".to_string()) })
    }

    fn status<'a>(
        &'a self,
        _hashes: &'a [String],
        _transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, String> {
        Box::pin(async { Ok(BTreeMap::new()) })
    }

    fn check<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, String> {
        Box::pin(async {
            Ok(CacheEvidence {
                known: false,
                cached: Vec::new(),
            })
        })
    }

    fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, String> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("trava")
                .push(transfer_id.to_string());
            self.results
                .lock()
                .expect("trava")
                .pop_front()
                .unwrap_or(Ok(true))
        })
    }

    fn evict<'a>(&'a self, _hashes: &'a [String]) -> DebridFuture<'a, Vec<String>, String> {
        Box::pin(async { Err("unsupported: evict".to_string()) })
    }

    fn account(&self) -> DebridFuture<'_, AccountEvidence, String> {
        Box::pin(async {
            Ok(AccountEvidence {
                used: None,
                max: None,
            })
        })
    }
}

fn remove(hash: &str, transfer_id: &str) -> EvictAction {
    EvictAction::Remove {
        hash: hash.into(),
        transfer_id: transfer_id.into(),
        name: "Fallback.2024.1080p.mkv".into(),
    }
}

fn skip(hash: &str) -> EvictAction {
    EvictAction::Skip {
        hash: hash.into(),
        reason: EvictSkip::NoTransferId,
    }
}

/// O crate não tem runtime (nem tokio): as futures do duplo resolvem na
/// PRIMEIRA poll, então este laço não pode girar em falso.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
    }
}

#[test]
fn executor_remove_item_a_item_e_conta_os_pulos() {
    let io = StubIo::new(vec![Ok(true), Ok(true)]);
    let report: EvictReport = block_on(execute(
        &io,
        &[remove("a", "1"), skip("b"), remove("c", "2")],
    ));
    assert_eq!(report.counts(), (2, 0, 1));
    assert_eq!(report.removed_hashes(), vec!["a", "c"]);
    assert_eq!(io.calls(), vec!["1", "2"]);
    assert_eq!(report.stop, None);
}

#[test]
fn erro_para_a_passagem_e_o_resto_nao_e_tentado() {
    let io = StubIo::new(vec![
        Ok(true),
        Err("rate_limit: too many api requests".to_string()),
    ]);
    let report = block_on(execute(
        &io,
        &[remove("a", "1"), remove("b", "2"), remove("c", "3")],
    ));
    // 1 saiu, 1 falhou, 1 nem foi tentado.
    assert_eq!(report.counts(), (1, 1, 1));
    assert_eq!(
        report.stop,
        Some(EvictStop::RateLimit),
        "taxonomia no prefixo do erro"
    );
    assert_eq!(report.skipped[0].reason, EvictSkip::NotAttempted);
    assert_eq!(io.calls(), vec!["1", "2"], "o terceiro delete não sai");
}

#[test]
fn recusa_sem_erro_conta_falha_e_nao_para() {
    let io = StubIo::new(vec![Ok(false), Ok(true)]);
    let report = block_on(execute(&io, &[remove("a", "1"), remove("b", "2")]));
    // Sem `Err` não há incerteza: o segundo item ainda é tentado.
    assert_eq!(report.counts(), (1, 1, 0));
    assert_eq!(report.failed[0].reason, "declined");
    assert_eq!(report.stop, None);
}

#[test]
fn taxonomia_da_parada_vem_do_prefixo() {
    assert_eq!(
        EvictStop::classify("quarantined: escrita incerta"),
        EvictStop::Quarantined
    );
    assert_eq!(EvictStop::classify("cooldown: 30s"), EvictStop::Cooldown);
    assert_eq!(
        EvictStop::classify("rate_limit: slow down"),
        EvictStop::RateLimit
    );
    let other = EvictStop::classify("unsupported: evict");
    assert_eq!(other.as_str(), "unsupported");
    assert!(!other.is_throttle(), "recusa não é freio");
    assert!(EvictStop::Cooldown.is_throttle());
}
