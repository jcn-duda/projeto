//! Hold volátil (autofetch em voo) e posse desta instância (`submitted`).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::error::now_ms;

/// Map `conta:hash → expira_ms`. Chamar de novo renova o prazo, como o
/// `hold` do Node. Expirado ou processo reiniciado, o hash volta a ser
/// candidato à limpeza normal.
#[derive(Default)]
pub struct Holds {
    inner: Mutex<HashMap<String, i64>>,
}

impl Holds {
    pub fn new() -> Self {
        Self::default()
    }

    fn key(account: &str, hash: &str) -> String {
        format!("{account}:{}", hash.trim().to_lowercase())
    }

    pub fn hold(&self, account: &str, hash: &str, ttl: Duration) {
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            return;
        }
        let ttl_ms = (ttl.as_millis() as i64).max(1);
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.insert(Self::key(account, &hash), now_ms() as i64 + ttl_ms);
    }

    pub fn release(&self, account: &str, hash: &str) {
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.remove(&Self::key(account, hash));
    }

    pub fn is_held(&self, account: &str, hash: &str) -> bool {
        let key = Self::key(account, hash);
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        let Some(expires_at) = guard.get(&key).copied() else {
            return false;
        };
        if expires_at <= now_ms() as i64 {
            guard.remove(&key);
            return false;
        }
        true
    }

    pub fn sweep(&self) {
        let now = now_ms() as i64;
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.retain(|_, expires_at| *expires_at > now);
    }

    pub fn len(&self) -> usize {
        self.sweep();
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn clear(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clear();
    }
}

static HOLDS: OnceLock<Holds> = OnceLock::new();

pub fn holds() -> &'static Holds {
    HOLDS.get_or_init(Holds::new)
}

/// Protege o hash por `ttl`. O autofetch nativo (fatia futura) chama isto antes
/// da checagem, como o Node faz em `protected.hold`.
pub fn hold(account: &str, hash: &str, ttl: Duration) {
    holds().hold(account, hash, ttl);
}

pub fn release(account: &str, hash: &str) {
    holds().release(account, hash);
}

pub fn is_held(account: &str, hash: &str) -> bool {
    holds().is_held(account, hash)
}

/// Hashes que ESTA instância subiu com prova (não estavam no snapshot). O
/// inventário seguinte não pode tratá-los como acervo do usuário — é a mesma
/// regra do `rememberSubmitted` do Node. Só memória: o registro durável é
/// `adsub`, escrito pelo Node (lido em `DurablePeek`).
#[derive(Default)]
pub struct Submitted {
    inner: Mutex<HashMap<String, HashSet<String>>>,
}

impl Submitted {
    fn remember(&self, account: &str, hash: &str) -> bool {
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            return false;
        }
        let mut guard = self.inner.lock().unwrap_or_else(|err| err.into_inner());
        guard.entry(account.to_string()).or_default().insert(hash)
    }

    pub(super) fn hashes(&self, account: &str) -> HashSet<String> {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(account)
            .cloned()
            .unwrap_or_default()
    }

    fn clear(&self) {
        self.inner
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clear();
    }
}

static SUBMITTED: OnceLock<Submitted> = OnceLock::new();

pub(super) fn submitted() -> &'static Submitted {
    SUBMITTED.get_or_init(Submitted::default)
}

/// Marca o hash como subido por nós. O chamador só deve chamar quando o
/// snapshot corrente prova que ele NÃO estava na conta (ver `check`).
pub fn remember_submitted(account: &str, hash: &str) {
    submitted().remember(account, hash);
}

pub fn submitted_hashes(account: &str) -> HashSet<String> {
    submitted().hashes(account)
}

/// Simula o restart nos testes.
pub fn reset_submitted() {
    submitted().clear();
}
