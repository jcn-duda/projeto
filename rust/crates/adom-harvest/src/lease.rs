//! Slot em voo DURÁVEL da fila `harvest:v1:q` (T1-B1).
//!
//! O coalescing de [`crate::inflight`] é a intenção volátil da obra que está
//! sendo colhida AGORA (funde enqueue, decide preempção). Este módulo é outra
//! coisa: o **claim** da obra em L2, para que um restart no meio do drain não
//! a perca.
//!
//! # Por que existe
//!
//! `take_head` tira a entrada da fila em MEMÓRIA; o drain roda sem o lock. Se
//! um enqueue do Node chega nesse meio-tempo ele persiste a fila — sem a obra
//! em voo — e um restart depois disso perde a entrada para sempre. Com o lease
//! no mesmo documento da fila, TODO `save` carrega o slot: a obra só sai do L2
//! quando o drain FECHA ([`DurableSlot::finished`]).
//!
//! # Regras
//!
//! - Um slot só (o tick é serial por contrato).
//! - Lease é de PROCESSO: no boot o dono anterior morreu, então o slot é
//!   devolvido à fila na hora, sem esperar o TTL.
//! - Toda devolução conta como morte de claim (`attempts`); na
//!   [`MAX_CLAIM_ATTEMPTS`]-ésima a obra vai para `terminal` em vez de voltar —
//!   obra que derruba o processo não pode virar laço infinito.
//! - Falha de drain NÃO passa por aqui: quem conta tentativa de colheita é o
//!   `Settler` do gateway.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::queue::HarvestQueue;
use crate::store::StoredQueue;
use crate::types::HarvestEntry;

/// TTL default do lease (`HARVEST_LEASE_TTL` futuro). O TTL é teto de
/// diagnóstico: no boot o slot é reclamado independentemente dele.
pub const LEASE_TTL_MS: i64 = 60_000;

/// Mortes de claim aceitas antes de a obra virar terminal.
pub const MAX_CLAIM_ATTEMPTS: u32 = 3;

/// Quanto tempo um terminal fica no documento (diagnóstico do painel).
pub const TERMINAL_TTL_SECONDS: u64 = 7 * 24 * 3600;

/// Posse do drain sobre a obra. `run_id` é diagnóstico (qual ciclo pegou).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub run_id: String,
    pub leased_at_ms: i64,
    pub lease_until_ms: i64,
}

impl Lease {
    pub fn new(run_id: impl Into<String>, now_ms: i64, ttl_ms: i64) -> Self {
        Self {
            run_id: run_id.into(),
            leased_at_ms: now_ms,
            lease_until_ms: now_ms.saturating_add(ttl_ms),
        }
    }

    pub fn expired(&self, now_ms: i64) -> bool {
        now_ms >= self.lease_until_ms
    }
}

/// Obra reivindicada: a entrada completa (o drain ainda precisa dela) + a posse.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InflightEntry {
    pub entry_id: String,
    pub entry: HarvestEntry,
    pub lease: Lease,
}

impl InflightEntry {
    pub fn expired(&self, now_ms: i64) -> bool {
        self.lease.expired(now_ms)
    }
}

/// Obra que morreu [`MAX_CLAIM_ATTEMPTS`] vezes em voo (poison).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEntry {
    pub entry_id: String,
    pub entry: HarvestEntry,
    pub reason: String,
    pub at_ms: i64,
}

/// Slot em voo + contadores. Mora dentro da [`crate::HarvestQueue`] porque é
/// ela a dona única do documento persistido.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DurableSlot {
    pub(crate) lease: Option<InflightEntry>,
    /// Mortes de claim por `entry_id` (não confundir com a tentativa de colheita
    /// do `Settler`).
    pub(crate) attempts: HashMap<String, u32>,
    pub(crate) terminal: Vec<TerminalEntry>,
}

impl DurableSlot {
    /// Abre o slot. Não cabe segundo claim: quem chama já devolveu o anterior.
    pub fn claim(&mut self, entry: HarvestEntry, now_ms: i64, run_id: impl Into<String>) {
        let entry_id = crate::reason::entry_identity(&entry);
        self.lease = Some(InflightEntry {
            entry_id,
            entry,
            lease: Lease::new(run_id, now_ms, LEASE_TTL_MS),
        });
    }

    pub fn inflight(&self) -> Option<&InflightEntry> {
        self.lease.as_ref()
    }

    pub fn terminal(&self) -> &[TerminalEntry] {
        &self.terminal
    }

    /// O drain FECHOU (com sucesso ou falha): o slot sai e o contador de mortes
    /// de claim zera. Idempotente.
    pub fn finished(&mut self, entry_id: &str) {
        if self
            .lease
            .as_ref()
            .is_some_and(|slot| slot.entry_id == entry_id)
        {
            self.lease = None;
            self.attempts.remove(entry_id);
        }
    }

    /// Devolve à fila o slot cujo dono morreu (boot/restart/cancelamento).
    ///
    /// `Some(entry)` = a obra volta (quem chama a põe no FIM, sem furar a
    /// ordem); `None` = não havia slot, ou ela morreu
    /// [`MAX_CLAIM_ATTEMPTS`] vezes e foi para `terminal`.
    pub fn reclaim(&mut self, now_ms: i64) -> Option<HarvestEntry> {
        self.prune_terminal(now_ms);
        let slot = self.lease.take()?;
        let count = {
            let deaths = self.attempts.entry(slot.entry_id.clone()).or_insert(0);
            *deaths = deaths.saturating_add(1);
            *deaths
        };
        if count < MAX_CLAIM_ATTEMPTS {
            return Some(slot.entry);
        }
        self.attempts.remove(&slot.entry_id);
        eprintln!(
            "[harvest] {}: claim morreu {count} vez(es) em voo; obra vai para terminal",
            slot.entry_id
        );
        self.terminal.push(TerminalEntry {
            entry_id: slot.entry_id,
            entry: slot.entry,
            reason: "lease_expired".to_string(),
            at_ms: now_ms,
        });
        None
    }

    /// Descarta o slot SEM devolver a obra (o operador zerou a fila).
    pub fn reset(&mut self) {
        self.lease = None;
        self.attempts.clear();
        self.terminal.clear();
    }

    fn prune_terminal(&mut self, now_ms: i64) {
        let ttl_ms = (TERMINAL_TTL_SECONDS as i64).saturating_mul(1000);
        self.terminal
            .retain(|terminal| now_ms.saturating_sub(terminal.at_ms) < ttl_ms);
    }
}

/// `run_id` do slot: processo + sequência. Só diagnóstico (o painel mostra qual
/// ciclo pegou a obra); nenhuma regra compara este valor.
fn next_run_id() -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

/// O slot é campo da fila porque é ela a dona única do documento persistido:
/// TODO `save` leva o claim junto, inclusive o `enqueue` do Node.
impl HarvestQueue {
    /// Abre o claim da obra que o tick acabou de tirar da fila.
    ///
    /// Slot anterior sem `finish` (future cancelado no meio) volta à fila
    /// ANTES: dois slots nunca coexistem, e a morte conta tentativa.
    pub fn claim_durable(&mut self, entry: &HarvestEntry, now_ms: i64) {
        self.reclaim_dead_lease(now_ms);
        self.slot.claim(entry.clone(), now_ms, next_run_id());
    }

    /// O drain FECHOU (sucesso ou falha): a obra sai do slot. Idempotente —
    /// `clear` no meio do drain também deixa o slot vazio.
    pub fn finish_durable(&mut self, entry_id: &str) {
        self.slot.finished(entry_id);
    }

    /// Obra em voo neste instante (`None` = nenhum claim aberto).
    pub fn lease(&self) -> Option<&InflightEntry> {
        self.slot.inflight()
    }

    /// Obras que morreram em voo [`MAX_CLAIM_ATTEMPTS`] vezes (poison).
    pub fn terminal(&self) -> &[TerminalEntry] {
        self.slot.terminal()
    }

    /// Boot/restart: o dono do slot é o processo ANTERIOR, que morreu — a obra
    /// volta pelo FIM da fila sem esperar o TTL. Devolve quantas voltaram.
    pub fn reclaim_dead_lease(&mut self, now_ms: i64) -> usize {
        match self.slot.reclaim(now_ms) {
            Some(entry) => {
                self.tail(entry);
                1
            }
            None => 0,
        }
    }

    /// O documento de `harvest:v1:q`: fila + slot + terminais.
    pub(crate) fn stored_snapshot(&self) -> StoredQueue {
        StoredQueue {
            entries: self.entries.clone(),
            inflight: self.slot.lease.clone(),
            attempts: self.slot.attempts.clone(),
            terminal: self.slot.terminal.clone(),
        }
    }

    /// Semeia a partir do L2 e devolve à fila o slot do processo que caiu.
    pub(crate) fn apply_stored(&mut self, stored: StoredQueue, now_ms: i64) {
        self.entries = stored.entries;
        self.slot.lease = stored.inflight;
        self.slot.attempts = stored.attempts;
        self.slot.terminal = stored.terminal;
        self.reclaim_dead_lease(now_ms);
    }
}

#[cfg(test)]
#[path = "lease_tests.rs"]
mod tests;
