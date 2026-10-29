//! Dublês de FATOS das varreduras: o congelado (`FakeFacts`) e o mutável EM
//! VOO (`SharedFacts`), para o teste da guarda viva mudar o mundo entre o
//! plano e o delete.
//!
//! Filho de `al_sweeps_tests` (reusa as linhas e os hashes de lá).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::super::FactSource;
use super::{hash_of, DAY, NOW};

#[derive(Default)]
pub(crate) struct FakeFacts {
    known_before: Option<HashSet<String>>,
    held: HashSet<String>,
    retained: HashSet<String>,
    owned_at: HashMap<String, i64>,
    marked: HashSet<String>,
    suppressed: HashSet<String>,
    /// Fonte durável (`adprot`/`adhold`) ILEGÍVEL: o planejador deve fechar a
    /// rodada e a guarda viva deve vetar (leitura que falha não prova guarda).
    durable_broken: bool,
    /// Hold ILEGÍVEL na leitura com prova (`held_checked` → `None`).
    holds_unreadable: bool,
}

impl FakeFacts {
    /// Inventário carregado (holds on) com os preexistentes de `hashes`.
    pub(crate) fn loaded(hashes: &[char]) -> Self {
        Self {
            known_before: Some(hashes.iter().map(|ch| hash_of(*ch)).collect()),
            ..Self::default()
        }
    }

    pub(crate) fn owns(mut self, ch: char) -> Self {
        self.owned_at.insert(hash_of(ch), NOW - 30 * DAY);
        self
    }

    /// Fila `sup:` da rodada (fase 1: o revalidate enxerga a represa).
    pub(crate) fn suppresses(mut self, hashes: &[char]) -> Self {
        self.suppressed.extend(hashes.iter().map(|ch| hash_of(*ch)));
        self
    }

    /// Hold volátil vivo (a poda o respeita).
    pub(crate) fn holds(mut self, ch: char) -> Self {
        self.held.insert(hash_of(ch));
        self
    }

    /// `cache.db` ilegível para os fatos duráveis.
    pub(crate) fn durable_broken(mut self) -> Self {
        self.durable_broken = true;
        self
    }

    /// Leitura do hold SEM prova (`None`).
    pub(crate) fn holds_unreadable(mut self) -> Self {
        self.holds_unreadable = true;
        self
    }

    fn flip_durable(&mut self) {
        self.durable_broken = true;
    }
}

impl FactSource for FakeFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        self.known_before.clone()
    }

    fn held(&self, hash: &str) -> bool {
        self.held.contains(hash)
    }

    fn retained(&self, hash: &str) -> bool {
        self.retained.contains(hash)
    }

    fn owned_at(&self, hash: &str) -> Option<i64> {
        self.owned_at.get(hash).copied()
    }

    fn marked(&self) -> HashSet<String> {
        self.marked.clone()
    }

    fn suppressed(&self) -> HashSet<String> {
        self.suppressed.clone()
    }

    fn durable_readable(&self) -> bool {
        !self.durable_broken
    }

    fn held_checked(&self, hash: &str) -> Option<bool> {
        if self.holds_unreadable {
            return None;
        }
        Some(self.held.contains(hash))
    }
}

/// Fatos MUTÁVEIS em voo: o teste muda o mundo enquanto o delete de um id
/// está parado no portão — é a releitura que a guarda viva
/// (`FactSource::live_delete_ok`) deve enxergar ANTES de cada delete.
pub(crate) struct SharedFacts {
    inner: Mutex<FakeFacts>,
}

impl SharedFacts {
    pub(crate) fn new(facts: FakeFacts) -> Self {
        Self {
            inner: Mutex::new(facts),
        }
    }

    /// Hold volátil que CHEGOU depois de o plano fechar.
    pub(crate) fn hold(&self, ch: char) {
        self.inner.lock().unwrap().held.insert(hash_of(ch));
    }

    /// Inventário que SUMIU (peek vira `None`): a guarda viva deve VETAR
    /// (fail-closed), nunca liberar por não conseguir reler.
    pub(crate) fn freeze_inventory(&self) {
        self.inner.lock().unwrap().known_before = None;
    }

    /// Fonte durável (`adprot`/`adhold`) que FICOU ilegível depois de o plano
    /// fechar: a guarda viva relê AGORA e deve VETAR.
    pub(crate) fn freeze_durable(&self) {
        self.inner.lock().unwrap().flip_durable();
    }
}

impl FactSource for SharedFacts {
    fn known_before(&self) -> Option<HashSet<String>> {
        self.inner.lock().unwrap().known_before.clone()
    }

    fn held(&self, hash: &str) -> bool {
        self.inner.lock().unwrap().held.contains(hash)
    }

    fn retained(&self, hash: &str) -> bool {
        self.inner.lock().unwrap().retained.contains(hash)
    }

    fn owned_at(&self, hash: &str) -> Option<i64> {
        self.inner.lock().unwrap().owned_at.get(hash).copied()
    }

    fn marked(&self) -> HashSet<String> {
        self.inner.lock().unwrap().marked.clone()
    }

    fn suppressed(&self) -> HashSet<String> {
        self.inner.lock().unwrap().suppressed.clone()
    }

    fn durable_readable(&self) -> bool {
        !self.inner.lock().unwrap().durable_broken
    }

    fn held_checked(&self, hash: &str) -> Option<bool> {
        let inner = self.inner.lock().unwrap();
        if inner.holds_unreadable {
            return None;
        }
        Some(inner.held.contains(hash))
    }
}
