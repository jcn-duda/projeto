//! Fila em memória de `harvest:v1:q`.
//!
//! Stub da Fase E: enqueue / dequeue / promoção por identidade. Sem L2, sem
//! evidência BR, sem coalescing in-flight, sem dedupe 12h. Ordem = FIFO com
//! promoção de motivo (a priorização BR completa fica na Fase E real).

use adom_core::prefix;

use crate::reason::{entry_identity, is_promotion, is_valid_imdb_id};
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
}

impl Default for HarvestQueueConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            queue_max: 200,
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
}

impl HarvestQueue {
    pub fn new(config: HarvestQueueConfig) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms: system_now_ms,
        }
    }

    pub fn with_clock(config: HarvestQueueConfig, now_ms: ClockMs) -> Self {
        Self {
            entries: Vec::new(),
            config,
            now_ms,
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

    /// Amostra (cópia) — stub FIFO; priorização BR fica na Fase E real.
    pub fn preview(&self, limit: usize) -> Vec<HarvestEntry> {
        self.entries.iter().take(limit).cloned().collect()
    }

    pub fn find_queued(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> Option<&HarvestEntry> {
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
        if let Some(existing) = self.entries.iter_mut().find(|e| entry_identity(e) == identity) {
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
        if let Some(idx) = self.entries.iter().position(|e| entry_identity(e) == identity) {
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
        if let Some(idx) = self.entries.iter().position(|e| entry_identity(e) == identity) {
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
mod tests {
    use super::*;
    use crate::types::HarvestMediaType;

    fn clock_fixed() -> i64 {
        1_700_000_000_000
    }

    fn q(max: usize) -> HarvestQueue {
        HarvestQueue::with_clock(
            HarvestQueueConfig {
                enabled: true,
                queue_max: max,
            },
            clock_fixed,
        )
    }

    #[test]
    fn chave_canonica_bate_com_ts() {
        assert_eq!(queue_key(), QUEUE_KEY);
        assert_eq!(QUEUE_KEY, "harvest:v1:q");
    }

    #[test]
    fn enqueue_e_take_head_fifo() {
        let mut queue = q(10);
        assert!(queue
            .enqueue(HarvestRequest::movie("tt0111161", "miss"))
            .accepted);
        assert!(queue
            .enqueue(HarvestRequest::movie("tt0068646", "miss"))
            .accepted);
        assert_eq!(queue.depth(), 2);
        let head = queue.take_head().expect("cabeça");
        assert_eq!(head.imdb_id, "tt0111161");
        assert_eq!(queue.depth(), 1);
    }

    #[test]
    fn rejeita_desligado_e_imdb_invalido() {
        let mut queue = q(10);
        queue.set_enabled(false);
        let off = queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
        assert!(!off.accepted);
        assert_eq!(off.reason, EnqueueReason::Disabled);

        queue.set_enabled(true);
        let bad = queue.enqueue(HarvestRequest::movie("nope", "miss"));
        assert!(!bad.accepted);
        assert_eq!(bad.reason, EnqueueReason::Invalid);
    }

    #[test]
    fn promocao_nao_duplica_nem_reseta_enqueued_at() {
        let mut queue = q(10);
        queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
        let first_at = queue.preview(1)[0].enqueued_at;

        let out = queue.enqueue(HarvestRequest::movie("tt0111161", "br-gap"));
        assert_eq!(out.reason, EnqueueReason::Promoted);
        assert_eq!(queue.depth(), 1);
        let e = &queue.preview(1)[0];
        assert_eq!(e.reason, "br-gap");
        assert_eq!(e.enqueued_at, first_at);
        assert_eq!(e.priority_at, Some(clock_fixed()));
    }

    #[test]
    fn duplicata_simples() {
        let mut queue = q(10);
        queue.enqueue(HarvestRequest::movie("tt0111161", "miss"));
        let out = queue.enqueue(HarvestRequest::movie("tt0111161", "popular"));
        assert!(out.accepted);
        assert_eq!(out.reason, EnqueueReason::Duplicate);
        assert_eq!(queue.depth(), 1);
    }

    #[test]
    fn teto_descarta_mais_velha() {
        let mut queue = q(2);
        queue.enqueue(HarvestRequest::movie("tt0000001", "miss"));
        queue.enqueue(HarvestRequest::movie("tt0000002", "miss"));
        queue.enqueue(HarvestRequest::movie("tt0000003", "miss"));
        assert_eq!(queue.depth(), 2);
        assert_eq!(queue.preview(2)[0].imdb_id, "tt0000002");
    }

    #[test]
    fn take_probe_fora_de_turno() {
        let mut queue = q(10);
        queue.enqueue(HarvestRequest::movie("tt0000001", "next-episode"));
        let mut probe = HarvestRequest::movie("tt0000002", "br-gap");
        probe.br_probe = true;
        queue.enqueue(probe);
        assert!(queue.has_probe());
        let got = queue.take_probe().expect("probe");
        assert_eq!(got.imdb_id, "tt0000002");
        assert!(got.br_probe);
        assert_eq!(queue.depth(), 1);
        assert_eq!(queue.preview(1)[0].imdb_id, "tt0000001");
    }

    #[test]
    fn head_e_tail_nao_duplicam() {
        let mut queue = q(10);
        queue.enqueue(HarvestRequest::series("tt0903747", 1, Some(1), "miss"));
        let entry = HarvestEntry {
            imdb_id: "tt0903747".into(),
            media_type: HarvestMediaType::Series,
            season: Some(1),
            episode: Some(1),
            reason: "next-episode".into(),
            enqueued_at: clock_fixed(),
            priority_at: None,
            resumed: false,
            br_probe: false,
            full_base: false,
        };
        queue.head(entry.clone());
        assert_eq!(queue.depth(), 1);
        assert_eq!(queue.preview(1)[0].reason, "next-episode");

        queue.tail(entry);
        assert_eq!(queue.depth(), 1);
    }

    #[test]
    fn fora_do_caminho_stream_documentado() {
        // Invariante de desenho: este módulo não importa nada de busca/stream.
        // O teste só trava a chave e o namespace — o gateway NÃO deve chamar
        // HarvestQueue no hot path.
        assert_eq!(HARVEST_NAMESPACE, "harvest");
        assert!(!QUEUE_KEY.contains("stream"));
    }
}
