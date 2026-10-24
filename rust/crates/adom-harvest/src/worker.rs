//! Ciclo `tick` do colhedor — espelho de `harvester.ts` / `harvest-worker.ts`.
//!
//! # Contrato
//!
//! - **Fora** do caminho `/stream`: só drena a fila em fundo.
//! - Freio de tráfego injetável ([`TrafficSense`]): busy → só `take_probe`.
//! - Teto horário: contador simples por balde UTC (`now_ms / 3_600_000`).
//! - Trabalho real via [`HarvestDrain`] (sync) ou [`HarvestDrainAsync`]
//!   (gateway/Jackett nativo, que pode esperar rede).
//! - O tick abre/fecha o slot em voo ([`crate::inflight`]) em volta do drain.
//! - A decisão do ciclo mora em `plan`, UMA vez: as duas portas não podem
//!   divergir na ordem das guardas nem no consumo da cabeça.

use std::future::Future;
use std::pin::Pin;

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

/// Callback do trabalho — sync (stub local, testes, drain sem I/O).
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

/// Callback do trabalho — async (gateway/Jackett nativo).
///
/// O future é **boxed** de propósito: é o que mantém o trait chamável por
/// `&mut dyn HarvestDrainAsync`, como o [`HarvestWorker::tick_async`] recebe.
/// A entrega boxeada é por entrada colhida, nunca por resposta HTTP.
pub trait HarvestDrainAsync {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>>;
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

/// Decisão do ciclo, antes de qualquer trabalho: ou o skip, ou a cabeça já
/// retirada da fila.
#[derive(Debug)]
enum TickPlan {
    Skip(TickOutcome),
    Run(HarvestEntry),
}

/// Início do ciclo para quem precisa SOLTAR o lock da fila durante a rede
/// (gateway): as guardas rodaram, a cabeça saiu e o slot em voo já está aberto.
/// Fechar é [`HarvestWorker::finish`].
#[derive(Debug)]
pub enum TickStart {
    Skip(TickOutcome),
    Run {
        entry: HarvestEntry,
        identity: String,
    },
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

    /// Decisão única do ciclo: guardas na ordem histórica e, no fim, a cabeça.
    ///
    /// O `take_next` está aqui (e não em cada porta) para que sync e async não
    /// divirjam justamente no ponto em que a fila é consumida: um skip decidido
    /// acima nunca tira nada; um `Run` já tirou.
    fn plan(
        &mut self,
        queue: &mut HarvestQueue,
        traffic: &dyn TrafficSense,
        now_ms: i64,
    ) -> TickPlan {
        if !self.config.enabled {
            return TickPlan::Skip(TickOutcome::SkippedDisabled);
        }
        if self.paused {
            return TickPlan::Skip(TickOutcome::SkippedPaused);
        }
        if self.in_flight {
            return TickPlan::Skip(TickOutcome::SkippedInFlight);
        }
        // Sob tráfego só a sonda dirigida sai (fora de turno); sem sonda na
        // fila o freio vence e o tick não consome nada.
        let busy = traffic.is_busy();
        if busy && !queue.has_probe() {
            return TickPlan::Skip(TickOutcome::SkippedBusy);
        }
        if queue.is_empty() {
            return TickPlan::Skip(TickOutcome::SkippedEmpty);
        }
        if self.queries_this_hour(now_ms) >= self.config.max_per_hour {
            return TickPlan::Skip(TickOutcome::SkippedHourlyCap);
        }
        match queue.take_next(busy) {
            Some(entry) => TickPlan::Run(entry),
            None => TickPlan::Skip(TickOutcome::SkippedEmpty),
        }
    }

    /// Abre o slot da obra em voo e devolve a identidade que o fecha.
    fn open_slot(&mut self, queue: &mut HarvestQueue, entry: &HarvestEntry) -> String {
        self.in_flight = true;
        let identity = entry_identity(entry);
        queue
            .inflight_mut()
            .begin(&identity, HarvestIntent::from_entry(entry));
        identity
    }

    /// Debita as consultas no balde e fecha o slot (obra diferente não casa).
    fn close_slot(
        &mut self,
        queue: &mut HarvestQueue,
        identity: &str,
        outcome: DrainOutcome,
        now_ms: i64,
    ) {
        self.note_queries(outcome.queries, now_ms);
        queue.inflight_mut().end(identity);
        self.in_flight = false;
    }

    /// Primeira metade do ciclo: guardas, `take_head` e slot em voo.
    ///
    /// O chamador pode soltar o lock da fila entre `begin` e `finish` — é o que
    /// o gateway faz para o `enqueue`/`pending` não esperarem a rede. O slot em
    /// voo já está aberto, então um pedido da mesma obra coalesce.
    pub fn begin(
        &mut self,
        queue: &mut HarvestQueue,
        traffic: &dyn TrafficSense,
        now_ms: i64,
    ) -> TickStart {
        let entry = match self.plan(queue, traffic, now_ms) {
            TickPlan::Skip(skip) => return TickStart::Skip(skip),
            TickPlan::Run(entry) => entry,
        };
        let identity = self.open_slot(queue, &entry);
        TickStart::Run { entry, identity }
    }

    /// Segunda metade do ciclo: debita as consultas e fecha o slot.
    pub fn finish(
        &mut self,
        queue: &mut HarvestQueue,
        identity: &str,
        outcome: DrainOutcome,
        now_ms: i64,
    ) {
        self.close_slot(queue, identity, outcome, now_ms);
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
        let (entry, identity) = match self.begin(queue, traffic, now_ms) {
            TickStart::Skip(skip) => return skip,
            TickStart::Run { entry, identity } => (entry, identity),
        };

        let outcome = drain.drain_one(&entry);
        self.finish(queue, &identity, outcome, now_ms);

        TickOutcome::Drained { entry, outcome }
    }

    /// Um ciclo **assíncrono**: mesma decisão do [`tick`](Self::tick), com drain
    /// que pode esperar rede (Jackett nativo no gateway).
    ///
    /// O slot em voo fica aberto durante o `await` — é ele que faz o coalescing
    /// de um enqueue da mesma obra que chega enquanto o drain corre. Cancelar o
    /// future no meio deixa o slot aberto (o tick é serial por contrato): quem
    /// chama deve deixar o ciclo terminar, não abortá-lo.
    ///
    /// O future **não** é `Send`: `&dyn TrafficSense` e `&mut dyn
    /// HarvestDrainAsync` só seriam se os traits trouxessem `Sync`/`Send`. O
    /// gateway conduz o ciclo numa thread própria (runtime `current_thread`);
    /// `tokio::spawn` direto exigiria `HarvestDrainAsync: Send` **e**
    /// `&(dyn TrafficSense + Sync)` nas assinaturas.
    pub async fn tick_async(
        &mut self,
        queue: &mut HarvestQueue,
        traffic: &dyn TrafficSense,
        drain: &mut dyn HarvestDrainAsync,
        now_ms: i64,
    ) -> TickOutcome {
        let (entry, identity) = match self.begin(queue, traffic, now_ms) {
            TickStart::Skip(skip) => return skip,
            TickStart::Run { entry, identity } => (entry, identity),
        };

        let outcome = drain.drain_one(&entry).await;
        self.finish(queue, &identity, outcome, now_ms);

        TickOutcome::Drained { entry, outcome }
    }
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
