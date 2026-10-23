//! Ciclo `tick` do colhedor — embrião de `harvester.ts` / `harvest-worker.ts`.
//!
//! # Contrato
//!
//! - **Fora** do caminho `/stream`: só drena a fila em fundo.
//! - Freio de tráfego injetável ([`TrafficSense`]): busy → skip (sem Jackett).
//! - Teto horário: contador simples por balde UTC (`now_ms / 3_600_000`).
//! - Trabalho real via [`HarvestDrain`] (sync stub; sem gateway / Jackett).
//! - O tick abre/fecha o slot em voo ([`crate::inflight`]) em volta do drain;
//!   `takeProbe` sob tráfego e seed IMDb ainda não.

use crate::hour::HourMeter;
use crate::inflight::HarvestIntent;
use crate::queue::HarvestQueue;
use crate::reason::entry_identity;
use crate::types::HarvestEntry;

/// Config injetável do worker (fatia de `harvesterLive.effective()`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HarvestWorkerConfig {
    pub enabled: bool,
    /// `HARVEST_MAX_HOUR` — default TS: 120.
    pub max_per_hour: u32,
}

impl Default for HarvestWorkerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_per_hour: 120,
        }
    }
}

/// Freio de tráfego / busy — espelho stub de `activity.recentUserTraffic`.
///
/// Embrião: busy ⇒ tick inteiro é skip (sem `takeProbe`). A ponte real do
/// activity window fica para a Fase E completa.
pub trait TrafficSense {
    fn is_busy(&self) -> bool;
}

impl TrafficSense for bool {
    fn is_busy(&self) -> bool {
        *self
    }
}

impl<F> TrafficSense for F
where
    F: Fn() -> bool,
{
    fn is_busy(&self) -> bool {
        (self)()
    }
}

/// Stub mutável para testes / injeção.
#[derive(Debug, Clone, Copy, Default)]
pub struct StubTraffic {
    pub busy: bool,
}

impl TrafficSense for StubTraffic {
    fn is_busy(&self) -> bool {
        self.busy
    }
}

/// Resultado do drain de UMA entrada (sem rede).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DrainOutcome {
    pub ok: bool,
    /// Consultas debitadas do teto horário (stub; Jackett real não existe aqui).
    pub queries: u32,
}

impl DrainOutcome {
    pub fn ok_with_queries(queries: u32) -> Self {
        Self { ok: true, queries }
    }

    pub fn failed() -> Self {
        Self {
            ok: false,
            queries: 0,
        }
    }
}

/// Callback do trabalho — sync stub. Async real fica quando houver runtime.
pub trait HarvestDrain {
    fn drain_one(&mut self, entry: &HarvestEntry) -> DrainOutcome;
}

impl<F> HarvestDrain for F
where
    F: FnMut(&HarvestEntry) -> DrainOutcome,
{
    fn drain_one(&mut self, entry: &HarvestEntry) -> DrainOutcome {
        (self)(entry)
    }
}

/// Por que o tick não colheu (ou colheu).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickOutcome {
    SkippedDisabled,
    SkippedPaused,
    SkippedInFlight,
    SkippedBusy,
    SkippedHourlyCap,
    SkippedEmpty,
    /// Cabeça consumida e passada ao drain.
    Drained {
        entry: HarvestEntry,
        outcome: DrainOutcome,
    },
}

impl TickOutcome {
    pub fn did_drain(&self) -> bool {
        matches!(self, Self::Drained { .. })
    }
}

/// Worker do ciclo: freio + teto + `take_head` + drain.
pub struct HarvestWorker {
    config: HarvestWorkerConfig,
    paused: bool,
    in_flight: bool,
    hour: HourMeter,
}

impl HarvestWorker {
    pub fn new(config: HarvestWorkerConfig) -> Self {
        Self {
            config,
            paused: false,
            in_flight: false,
            hour: HourMeter::default(),
        }
    }

    pub fn config(&self) -> HarvestWorkerConfig {
        self.config
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.config.enabled = enabled;
    }

    pub fn set_max_per_hour(&mut self, max: u32) {
        self.config.max_per_hour = max;
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn in_flight(&self) -> bool {
        self.in_flight
    }

    /// Consultas no balde da hora de `now_ms` (espelho de `queriesThisHour`).
    pub fn queries_this_hour(&mut self, now_ms: i64) -> u32 {
        self.hour.count(now_ms)
    }

    /// Anota consultas no balde (espelho de `noteQueries` sem persistir L2).
    pub fn note_queries(&mut self, count: u32, now_ms: i64) {
        self.hour.note(count, now_ms);
    }

    /// Semeia o balde com o L2 (`hydrateCurrentHour` do TS).
    pub fn hydrate_hour(&mut self, count: u32, now_ms: i64) {
        self.hour.hydrate(count, now_ms);
    }

    /// Zera o Map — testes simulam processo novo.
    pub fn clear_hour_buckets(&mut self) {
        self.hour.clear();
    }

    /// Um ciclo: freio → teto → `take_head` → [`HarvestDrain::drain_one`].
    /// A entrada consumida fica fora da fila (requeue é do caller); sem Jackett.
    pub fn tick(
        &mut self,
        queue: &mut HarvestQueue,
        traffic: &dyn TrafficSense,
        drain: &mut dyn HarvestDrain,
        now_ms: i64,
    ) -> TickOutcome {
        if !self.config.enabled {
            return TickOutcome::SkippedDisabled;
        }
        if self.paused {
            return TickOutcome::SkippedPaused;
        }
        if self.in_flight {
            return TickOutcome::SkippedInFlight;
        }
        // Freio: busy alto → skip inteiro (embrião; TS ainda tem takeProbe).
        if traffic.is_busy() {
            return TickOutcome::SkippedBusy;
        }
        if queue.is_empty() {
            return TickOutcome::SkippedEmpty;
        }
        if self.queries_this_hour(now_ms) >= self.config.max_per_hour {
            return TickOutcome::SkippedHourlyCap;
        }

        let Some(entry) = queue.take_head() else {
            return TickOutcome::SkippedEmpty;
        };

        self.in_flight = true;
        let identity = entry_identity(&entry);
        let inflight = queue.inflight_mut();
        inflight.begin(&identity, HarvestIntent::from_entry(&entry));
        let outcome = drain.drain_one(&entry);
        self.note_queries(outcome.queries, now_ms);
        queue.inflight_mut().end(&identity);
        self.in_flight = false;

        TickOutcome::Drained { entry, outcome }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hour::HOUR_MS;
    use crate::queue::{HarvestQueue, HarvestQueueConfig};
    use crate::types::HarvestRequest;

    const NOW: i64 = 1_700_000_000_000; // balde fixo

    fn queue_with(ids: &[&str]) -> HarvestQueue {
        let mut q = HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW);
        for id in ids {
            q.enqueue(HarvestRequest::movie(*id, "miss"));
        }
        q
    }

    fn worker_capped(max: u32) -> HarvestWorker {
        HarvestWorker::new(HarvestWorkerConfig {
            enabled: true,
            max_per_hour: max,
        })
    }

    #[test]
    fn tick_take_head_chama_drain() {
        let mut worker = worker_capped(120);
        let mut queue = queue_with(&["tt0111161", "tt0068646"]);
        let mut seen: Vec<String> = Vec::new();
        let mut drain = |e: &HarvestEntry| {
            seen.push(e.imdb_id.clone());
            DrainOutcome::ok_with_queries(2)
        };

        let out = worker.tick(&mut queue, &false, &mut drain, NOW);
        assert!(out.did_drain());
        match out {
            TickOutcome::Drained { entry, outcome } => {
                assert_eq!(entry.imdb_id, "tt0111161");
                assert!(outcome.ok);
                assert_eq!(outcome.queries, 2);
            }
            other => panic!("esperado Drained, got {other:?}"),
        }
        assert_eq!(seen, vec!["tt0111161"]);
        assert_eq!(queue.depth(), 1);
        assert_eq!(worker.queries_this_hour(NOW), 2);
        assert!(!worker.in_flight());
    }

    #[test]
    fn freio_busy_skip_sem_consumir_fila() {
        let mut worker = worker_capped(120);
        let mut queue = queue_with(&["tt0111161"]);
        let mut calls = 0u32;
        let mut drain = |_e: &HarvestEntry| {
            calls += 1;
            DrainOutcome::ok_with_queries(1)
        };

        let out = worker.tick(&mut queue, &StubTraffic { busy: true }, &mut drain, NOW);
        assert_eq!(out, TickOutcome::SkippedBusy);
        assert_eq!(calls, 0);
        assert_eq!(queue.depth(), 1);
        assert_eq!(worker.queries_this_hour(NOW), 0);
    }

    #[test]
    fn teto_horario_bloqueia_apos_limite() {
        let mut worker = worker_capped(2);
        let mut queue = queue_with(&["tt0000001", "tt0000002"]);
        let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(2);

        let first = worker.tick(&mut queue, &false, &mut drain, NOW);
        assert!(first.did_drain());
        assert_eq!(worker.queries_this_hour(NOW), 2);

        // Guard ANTES do take_head: count >= max ⇒ skip sem consumir.
        let blocked = worker.tick(&mut queue, &false, &mut drain, NOW);
        assert_eq!(blocked, TickOutcome::SkippedHourlyCap);
        assert_eq!(queue.depth(), 1);
        assert_eq!(queue.preview(1)[0].imdb_id, "tt0000002");
    }

    #[test]
    fn teto_reseta_na_virada_de_hora() {
        let mut worker = worker_capped(2);
        worker.note_queries(2, NOW);
        assert_eq!(worker.queries_this_hour(NOW), 2);

        let next_hour = NOW + HOUR_MS;
        assert_eq!(worker.queries_this_hour(next_hour), 0);

        let mut queue = queue_with(&["tt0111161"]);
        let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);
        let out = worker.tick(&mut queue, &false, &mut drain, next_hour);
        assert!(out.did_drain());
        assert_eq!(worker.queries_this_hour(next_hour), 1);
    }

    #[test]
    fn desligado_pausado_vazio_e_inflight() {
        let mut worker = worker_capped(120);
        let mut queue = queue_with(&["tt0111161"]);
        let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);

        worker.set_enabled(false);
        assert_eq!(
            worker.tick(&mut queue, &false, &mut drain, NOW),
            TickOutcome::SkippedDisabled
        );
        worker.set_enabled(true);

        worker.set_paused(true);
        assert_eq!(
            worker.tick(&mut queue, &false, &mut drain, NOW),
            TickOutcome::SkippedPaused
        );
        worker.set_paused(false);

        let mut empty = HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW);
        assert_eq!(
            worker.tick(&mut empty, &false, &mut drain, NOW),
            TickOutcome::SkippedEmpty
        );

        // Flag privada: o submodule de teste acessa para cobrir o skip.
        worker.in_flight = true;
        assert_eq!(
            worker.tick(&mut queue, &false, &mut drain, NOW),
            TickOutcome::SkippedInFlight
        );
        assert_eq!(queue.depth(), 1);
    }

    #[test]
    fn hydrate_hour_sobe_o_balde_da_hora_corrente() {
        let mut worker = worker_capped(2);
        worker.hydrate_hour(2, NOW);
        assert_eq!(worker.queries_this_hour(NOW), 2);
        // Disco atrás do contador não regride (o worker já debitou mais).
        worker.hydrate_hour(1, NOW);
        assert_eq!(worker.queries_this_hour(NOW), 2);

        // Virada de hora: o balde zera antes de semear; só a hora corrente entra.
        let next_hour = NOW + HOUR_MS;
        worker.hydrate_hour(1, next_hour);
        assert_eq!(worker.queries_this_hour(next_hour), 1);
        assert_eq!(worker.queries_this_hour(NOW), 0);
    }

    #[test]
    fn tick_encerra_o_slot_da_obra_colhida() {
        let mut queue = queue_with(&["tt0111161"]);
        let head = queue.preview(1)[0].clone();
        let identity = entry_identity(&head);
        let inflight = queue.inflight_mut();
        inflight.begin(&identity, HarvestIntent::from_entry(&head));

        let mut worker = worker_capped(120);
        let mut drain = |_e: &HarvestEntry| DrainOutcome::ok_with_queries(1);
        assert!(worker.tick(&mut queue, &false, &mut drain, NOW).did_drain());
        // O `end` do tick casa a identidade da entrada colhida.
        assert!(!queue.inflight().is_inflight(&identity));
    }
}
