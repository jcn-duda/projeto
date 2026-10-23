//! Fila em memória de `harvest:v1:q`.
//!
//! Mutação (enqueue / take_head / head / tail) vive aqui; L2 é
//! [`crate::store::HarvestStore`] via [`HarvestQueue::load_from`] /
//! [`HarvestQueue::save_to`] (espelho de `load`/`persist` + `cache.set` no TS).
//! Priorização BR: [`HarvestQueue::prioritize`] / [`crate::prioritize`].
//! Coalescing in-flight em [`crate::inflight`]; dedupe 12h em [`crate::seen`].

use adom_core::prefix;

use crate::inflight::{HarvestInflight, HarvestIntent};
use crate::prioritize::{prioritize, BrEvidence, PrioritizeConfig};
use crate::reason::{entry_identity, is_promotion, is_valid_imdb_id};
use crate::store::HarvestStore;
use crate::types::{EnqueueOutcome, EnqueueReason, HarvestEntry, HarvestRequest};

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

/// Config mínima do stub (espelha fatias de `harvesterLive.effective()`).
#[derive(Debug, Clone)]
pub struct HarvestQueueConfig {
    pub enabled: bool,
    /// Teto `HARVEST_QUEUE_MAX` (default TS: 200).
    pub queue_max: usize,
    /// `HARVEST_BR_FIRST` — prioriza evidência BR no tier regular.
    pub br_first: bool,
    /// `HARVEST_BR_MAX_WAIT_MS` — anti-fome no tier regular (`0` = off).
    pub br_max_wait_ms: i64,
}

impl Default for HarvestQueueConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            queue_max: 200,
            br_first: true,
            br_max_wait_ms: 6 * 3600 * 1000,
        }
    }
}

impl HarvestQueueConfig {
    /// Fatia usada por [`crate::prioritize`].
    pub fn prioritize_config(&self) -> PrioritizeConfig {
        PrioritizeConfig {
            br_first: self.br_first,
            br_max_wait_ms: self.br_max_wait_ms,
        }
    }
}

/// Relógio injetável — testes não dependem de `SystemTime`.
pub type ClockMs = fn() -> i64;

fn system_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Dono único do array da fila (mesmo corte TS: ciclo só toca pelas primitivas).
pub struct HarvestQueue {
    entries: Vec<HarvestEntry>,
    config: HarvestQueueConfig,
    now_ms: ClockMs,
    inflight: HarvestInflight,
}

impl HarvestQueue {
    pub fn new(config: HarvestQueueConfig) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms: system_now_ms,
            inflight: HarvestInflight::new(),
        }
    }

    pub fn with_clock(config: HarvestQueueConfig, now_ms: ClockMs) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms,
            inflight: HarvestInflight::new(),
        }
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.config.enabled = enabled;
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
    pub fn replace(&mut self, mut entries: Vec<HarvestEntry>) {
        if entries.len() > self.config.queue_max {
            entries.truncate(self.config.queue_max);
        }
        self.entries = entries;
    }

    /// `load()` do TS: lê L2 e coloca na memória.
    ///
    /// Se `evidence` for fornecida, aplica [`prioritize`] (espelho do
    /// `prioritizeQueue` pós-load). Sem evidência, mantém a ordem do L2 —
    /// índice real ainda não é plugado.
    pub fn load_from(
        &mut self,
        store: &HarvestStore,
        now_ms: i64,
        evidence: Option<&dyn BrEvidence>,
    ) -> Result<(), String> {
        self.replace(store.load(now_ms)?);
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

    /// `persist()` do TS: grava fatia até `queue_max` (ou apaga se vazia).
    pub fn save_to(
        &self,
        store: &HarvestStore,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        let kept = if self.entries.len() > self.config.queue_max {
            &self.entries[..self.config.queue_max]
        } else {
            &self.entries
        };
        store.save(kept, ttl_seconds, now_ms)
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

    /// Enfileira. Fogo-e-esquece no contrato público; o retorno existe para a
    /// sonda saber se o pedido virou trabalho.
    pub fn enqueue(&mut self, req: HarvestRequest) -> EnqueueOutcome {
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
        };
        if full.reason == "br-gap" {
            full.priority_at = Some(now);
        }

        let identity = entry_identity(&full);
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|e| entry_identity(e) == identity)
        {
            let probe_upgrade = full.br_probe && !existing.br_probe;
            if probe_upgrade {
                existing.br_probe = true;
                existing.full_base = true;
            }
            if !is_promotion(&existing.reason, &full.reason) {
                if !probe_upgrade {
                    return EnqueueOutcome::accepted(EnqueueReason::Duplicate);
                }
                return EnqueueOutcome::accepted(EnqueueReason::Queued);
            }
            existing.reason = full.reason.clone();
            if full.reason == "br-gap" {
                existing.priority_at = Some(now);
            }
            return EnqueueOutcome::accepted(EnqueueReason::Promoted);
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

        // Sem priorização BR: obra nova empurra a mais velha (semântica
        // `harvestBrFirst=false` do TS).
        while self.entries.len() >= self.config.queue_max {
            self.entries.remove(0);
        }
        self.entries.push(full);
        EnqueueOutcome::accepted(EnqueueReason::Queued)
    }

    /// Volta à frente (teto / preempção). Não duplica identidade.
    pub fn head(&mut self, entry: HarvestEntry) {
        let identity = entry_identity(&entry);
        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| entry_identity(e) == identity)
        {
            let mut queued = self.entries.remove(idx);
            if entry.br_probe && !queued.br_probe {
                queued.br_probe = true;
                queued.full_base = true;
            }
            if is_promotion(&queued.reason, &entry.reason) {
                queued.reason = entry.reason.clone();
                if entry.reason == "br-gap" {
                    if let Some(at) = entry.priority_at {
                        queued.priority_at = Some(at);
                    }
                }
            }
            self.entries.insert(0, queued);
        } else {
            self.entries.insert(0, entry);
        }
    }

    /// Devolve ao fim (falha transitória). Não duplica identidade.
    pub fn tail(&mut self, entry: HarvestEntry) {
        let identity = entry_identity(&entry);
        if let Some(idx) = self
            .entries
            .iter()
            .position(|e| entry_identity(e) == identity)
        {
            let queued = &mut self.entries[idx];
            if entry.br_probe && !queued.br_probe {
                queued.br_probe = true;
                queued.full_base = true;
            }
            if is_promotion(&queued.reason, &entry.reason) {
                queued.reason = entry.reason.clone();
                if entry.reason == "br-gap" {
                    if let Some(at) = entry.priority_at {
                        queued.priority_at = Some(at);
                    }
                }
            }
        } else {
            self.entries.push(entry);
        }
    }
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
