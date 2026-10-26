//! Fila em memória de `harvest:v1:q`.
//!
//! Mutação (enqueue / take_head / head / tail) vive aqui; L2 é
//! [`crate::store::HarvestStore`] via [`HarvestQueue::load_from`] /
//! [`HarvestQueue::save_to`] (espelho de `load`/`persist` + `cache.set` no TS).
//! Priorização BR: [`HarvestQueue::prioritize`] / [`crate::prioritize`].
//! Coalescing in-flight em [`crate::inflight`]; dedupe 12h em [`crate::seen`].

use adom_core::prefix;

use crate::inflight::{HarvestInflight, HarvestIntent};
use crate::lease::DurableSlot;
use crate::prioritize::{prioritize, BrEvidence};
use crate::queue_config::{system_now_ms, ClockMs, NeutralEvidence};
use crate::reason::{entry_identity, is_valid_imdb_id};
use crate::store::HarvestStore;
use crate::types::{EnqueueOutcome, EnqueueReason, HarvestEntry, HarvestRequest};

pub use crate::queue_config::HarvestQueueConfig;

/// Namespace nas cotas / `cache-keys` (`harvest` → `v1`).
pub const HARVEST_NAMESPACE: &str = "harvest";

/// Sufixo da chave única da fila (`…q` → `harvest:v1:q`).
pub const QUEUE_SUFFIX: &str = "q";

/// Chave canônica da fila (igual a `` `${prefix('harvest')}q` `` no TS).
pub fn queue_key() -> String {
    format!("{}{QUEUE_SUFFIX}", prefix(HARVEST_NAMESPACE))
}

/// Constante documentada — equivale a `queue_key()` com o prefixo vivo.
pub const QUEUE_KEY: &str = "harvest:v1:q";

/// Dono único do array da fila (mesmo corte TS: ciclo só toca pelas primitivas).
///
/// O `slot` (claim durável, [`crate::lease`]) mora aqui porque o documento
/// persistido é UM só: qualquer `save` leva a obra em voo junto.
pub struct HarvestQueue {
    pub(crate) entries: Vec<HarvestEntry>,
    config: HarvestQueueConfig,
    now_ms: ClockMs,
    inflight: HarvestInflight,
    pub(crate) slot: DurableSlot,
}

impl HarvestQueue {
    pub fn new(config: HarvestQueueConfig) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms: system_now_ms,
            inflight: HarvestInflight::new(),
            slot: DurableSlot::default(),
        }
    }

    pub fn with_clock(config: HarvestQueueConfig, now_ms: ClockMs) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms,
            inflight: HarvestInflight::new(),
            slot: DurableSlot::default(),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.config.enabled = enabled;
    }

    /// Troca a config inteira (a do painel chega com o processo de pé). O teto
    /// novo só barra enqueue futuro: a fila que já passou dele não é cortada.
    pub fn set_config(&mut self, config: HarvestQueueConfig) {
        self.config = config;
    }

    /// Toggle lido pelo chamador (sonda: sem fila ligada não há trabalho).
    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn depth(&self) -> usize {
        self.entries.len()
    }

    pub fn clear(&mut self) -> usize {
        let n = self.entries.len();
        self.entries.clear();
        // Zerar fila é decisão do operador: o slot não volta (nem vira terminal).
        self.slot.reset();
        n
    }

    /// Snapshot do array (para `save` / diagnóstico).
    pub fn entries(&self) -> &[HarvestEntry] {
        &self.entries
    }

    pub fn inflight(&self) -> &HarvestInflight {
        &self.inflight
    }

    pub fn inflight_mut(&mut self) -> &mut HarvestInflight {
        &mut self.inflight
    }

    /// Substitui o array em memória (após `HarvestStore::load`).
    ///
    /// Não trunca: um retorno aceito acima do teto sobrevive ao save/load.
    /// Ingresso novo e distinto continua aplicando o teto em [`enqueue`].
    pub fn replace(&mut self, entries: Vec<HarvestEntry>) {
        self.entries = entries;
    }

    /// `load()` do TS: lê L2 e coloca na memória.
    ///
    /// Se `evidence` for fornecida, aplica [`prioritize`] (espelho do
    /// `prioritizeQueue` pós-load). Sem evidência, mantém a ordem do L2 —
    /// o gateway materializa a foto e reordena fora deste método.
    pub fn load_from(
        &mut self,
        store: &HarvestStore,
        now_ms: i64,
        evidence: Option<&dyn BrEvidence>,
    ) -> Result<(), String> {
        // O slot do documento é do processo ANTERIOR: `apply_stored` já o
        // devolve à fila (a obra não pode morrer com o restart).
        self.apply_stored(store.load_queue(now_ms)?, now_ms);
        if let Some(ev) = evidence {
            self.prioritize(ev, now_ms);
        }
        Ok(())
    }

    /// Reordena a fila in-place com evidência BR injetável.
    pub fn prioritize(&mut self, evidence: &dyn BrEvidence, now_ms: i64) {
        let cfg = self.config.prioritize_config();
        self.entries = prioritize(&self.entries, &cfg, evidence, now_ms);
    }

    /// `persist()` do TS: grava o snapshot inteiro (fila + slot) ou apaga se
    /// ambos vazios.
    pub fn save_to(
        &self,
        store: &HarvestStore,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        store.save_queue(&self.stored_snapshot(), ttl_seconds, now_ms)
    }

    /// Amostra (cópia) — stub FIFO; priorização BR fica na Fase E real.
    pub fn preview(&self, limit: usize) -> Vec<HarvestEntry> {
        self.entries.iter().take(limit).cloned().collect()
    }

    pub fn find_queued(
        &self,
        imdb_id: &str,
        season: Option<i32>,
        episode: Option<i32>,
    ) -> Option<&HarvestEntry> {
        let id = crate::reason::obra_identity(imdb_id, season, episode);
        self.entries.iter().find(|e| entry_identity(e) == id)
    }

    pub fn has_probe(&self) -> bool {
        self.entries.iter().any(|e| e.br_probe)
    }

    /// Consome a cabeça (FIFO do stub).
    pub fn take_head(&mut self) -> Option<HarvestEntry> {
        if self.entries.is_empty() {
            None
        } else {
            Some(self.entries.remove(0))
        }
    }

    /// Primeira entrada com `br_probe`, removida (fora de turno sob tráfego).
    pub fn take_probe(&mut self) -> Option<HarvestEntry> {
        let idx = self.entries.iter().position(|e| e.br_probe)?;
        Some(self.entries.remove(idx))
    }

    /// Seleção do tick: sob tráfego só a sonda dirigida sai.
    pub fn take_next(&mut self, busy: bool) -> Option<HarvestEntry> {
        if busy {
            self.take_probe()
        } else {
            self.take_head()
        }
    }

    /// Marca como retomada a obra que voltou de um run interrompido (replay de
    /// boot). `false` = obra não está na fila (já drenada ou evictada).
    pub fn mark_resumed(&mut self, entry_id: &str) -> bool {
        let Some(entry) = self
            .entries
            .iter_mut()
            .find(|entry| entry_identity(entry) == entry_id)
        else {
            return false;
        };
        entry.resumed = true;
        true
    }

    /// Enfileira. Fogo-e-esquece no contrato público; o retorno existe para a
    /// sonda saber se o pedido virou trabalho.
    pub fn enqueue(&mut self, req: HarvestRequest) -> EnqueueOutcome {
        self.enqueue_with_evidence(req, None)
    }

    /// Ingresso com a última foto de evidência: prioriza depois da fusão e
    /// antes da evicção. Identidade nova sem evidência na foto fica neutra.
    pub fn enqueue_with_evidence(
        &mut self,
        req: HarvestRequest,
        evidence: Option<&dyn BrEvidence>,
    ) -> EnqueueOutcome {
        if !self.config.enabled {
            return EnqueueOutcome::rejected(EnqueueReason::Disabled);
        }
        if !is_valid_imdb_id(&req.imdb_id) {
            return EnqueueOutcome::rejected(EnqueueReason::Invalid);
        }

        let now = (self.now_ms)();
        let mut full = HarvestEntry {
            imdb_id: req.imdb_id,
            media_type: req.media_type,
            season: req.season,
            episode: req.episode,
            reason: req.reason,
            enqueued_at: now,
            priority_at: None,
            resumed: false,
            br_probe: req.br_probe,
            full_base: false,
            full_intent: None,
        };
        if full.reason == "br-gap" {
            full.priority_at = Some(now);
        }
        full.normalize_intent();

        let identity = entry_identity(&full);
        if let Some(idx) = self
            .entries
            .iter()
            .position(|entry| entry_identity(entry) == identity)
        {
            let out = {
                let existing = &mut self.entries[idx];
                let before_reason = existing.reason.clone();
                let before_probe = existing.br_probe;
                let before_full = existing.full_intent.clone();
                existing.merge_intent(&full);
                if existing.reason != before_reason {
                    EnqueueOutcome::accepted(EnqueueReason::Promoted)
                } else if existing.br_probe != before_probe || existing.full_intent != before_full {
                    EnqueueOutcome::accepted(EnqueueReason::Queued)
                } else {
                    EnqueueOutcome::accepted(EnqueueReason::Duplicate)
                }
            };
            self.apply_priority(evidence, now);
            return out;
        }

        // Coalescing em voo: MESMA obra colhida agora — funde a intenção na
        // execução corrente em vez de criar segunda entrada. Ordem do TS: depois
        // de duplicata/promoção e antes do dedupe (pedido forte não é engolido).
        if self
            .inflight
            .coalesce(&identity, &HarvestIntent::from_entry(&full))
        {
            return EnqueueOutcome::accepted(EnqueueReason::Coalesced);
        }

        self.entries.push(full);
        self.apply_priority(evidence, now);
        self.evict_to_cap();
        if self
            .entries
            .iter()
            .any(|entry| entry_identity(entry) == identity)
        {
            EnqueueOutcome::accepted(EnqueueReason::Queued)
        } else {
            EnqueueOutcome::rejected(EnqueueReason::Capacity)
        }
    }

    fn apply_priority(&mut self, evidence: Option<&dyn BrEvidence>, now: i64) {
        match evidence {
            Some(ev) => self.prioritize(ev, now),
            None => self.prioritize(&NeutralEvidence, now),
        }
    }

    /// Com BR-first remove a cauda já priorizada; sem ele, o menor
    /// `enqueued_at`. Teto reduzido pode exigir mais de um descarte.
    fn evict_to_cap(&mut self) {
        let cap = self.config.queue_max;
        if cap == 0 {
            return;
        }
        while !self.entries.is_empty() && self.entries.len() > cap {
            let idx = if self.config.br_first {
                self.entries.len() - 1
            } else {
                self.entries
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, entry)| entry.enqueued_at)
                    .map(|(i, _)| i)
                    .unwrap_or(0)
            };
            let gone = self.entries.remove(idx);
            eprintln!(
                "[harvest] evicção por capacidade: {} motivo={}",
                entry_identity(&gone),
                gone.reason
            );
        }
    }

    /// Volta à frente (teto / preempção). Não duplica identidade.
    pub fn head(&mut self, mut entry: HarvestEntry) {
        entry.normalize_intent();
        let identity = entry_identity(&entry);
        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| entry_identity(e) == identity)
        {
            let mut queued = self.entries.remove(idx);
            queued.merge_intent(&entry);
            self.entries.insert(0, queued);
        } else {
            self.entries.insert(0, entry);
        }
    }

    /// Devolve ao fim (falha transitória). Não duplica identidade.
    pub fn tail(&mut self, mut entry: HarvestEntry) {
        entry.normalize_intent();
        let identity = entry_identity(&entry);
        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| entry_identity(e) == identity)
        {
            self.entries[idx].merge_intent(&entry);
        } else {
            self.entries.push(entry);
        }
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "queue_intent_tests.rs"]
mod intent_tests;
