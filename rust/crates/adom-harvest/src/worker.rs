//! Ciclo `tick` do colhedor — espelho de `harvester.ts` / `harvest-worker.ts`.
//!
//! # Contrato
//!
//! - **Fora** do caminho `/stream`: só drena a fila em fundo.
//! - Freio de tráfego injetável ([`TrafficSense`]): busy → só `take_probe`.
//! - Teto horário: contador simples por balde UTC (`now_ms / 3_600_000`).
//! - Teto **rígido entre consultas**: o ciclo entrega `queries_left`
//!   (`max_per_hour − queries_this_hour`) a quem drena, que corta alvo a alvo
//!   em vez de gastar o que já não cabe no balde. O débito continua no
//!   `finish`, só com as consultas realmente gastas.
//! - Trabalho real via [`HarvestDrain`] (sync) ou [`HarvestDrainAsync`]
//!   (gateway/Jackett nativo, que pode esperar rede).
//! - O tick abre/fecha o slot em voo ([`crate::inflight`]) em volta do drain.
//! - A decisão do ciclo mora em `plan`, UMA vez: as duas portas não podem
//!   divergir na ordem das guardas nem no consumo da cabeça.

use crate::hour::HourMeter;
use crate::inflight::HarvestIntent;
use crate::queue::HarvestQueue;
use crate::reason::entry_identity;
use crate::types::HarvestEntry;
use crate::worker_types::TickPlan;

/// Vocabulário do ciclo (config, freio, drain e decisão). Mora em
/// [`crate::worker_types`] desde que este arquivo bateu o teto de linhas; o
/// caminho público continua o mesmo.
pub use crate::worker_types::{
    DrainOutcome, HarvestDrain, HarvestDrainAsync, HarvestWorkerConfig, StubTraffic, TickOutcome,
    TickStart, TrafficSense,
};

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
        let used = self.queries_this_hour(now_ms);
        if used >= self.config.max_per_hour {
            return TickPlan::Skip(TickOutcome::SkippedHourlyCap);
        }
        // A conta é feita UMA vez, aqui: quem drena recebe o saldo da hora e
        // corta antes de cada consulta, então o balde nunca é estourado por
        // uma entrada com muitos alvos.
        let queries_left = self.config.max_per_hour.saturating_sub(used);
        match queue.take_next(busy) {
            Some(entry) => TickPlan::Run {
                entry,
                queries_left,
            },
            None => TickPlan::Skip(TickOutcome::SkippedEmpty),
        }
    }

    /// Abre o slot da obra em voo (volátil + durável) e devolve a identidade
    /// que os dois fecham.
    fn open_slot(&mut self, queue: &mut HarvestQueue, entry: &HarvestEntry, now_ms: i64) -> String {
        self.in_flight = true;
        let identity = entry_identity(entry);
        queue
            .inflight_mut()
            .begin(&identity, HarvestIntent::from_entry(entry));
        // O claim é o que sobrevive ao restart: a entrada já saiu da memória e
        // o próximo `save` (inclusive o do enqueue) a leva no documento.
        queue.claim_durable(entry, now_ms);
        identity
    }

    /// Debita as consultas no balde e fecha os dois slots (obra diferente não
    /// casa).
    fn close_slot(
        &mut self,
        queue: &mut HarvestQueue,
        identity: &str,
        outcome: DrainOutcome,
        now_ms: i64,
    ) {
        self.note_queries(outcome.queries, now_ms);
        queue.inflight_mut().end(identity);
        queue.finish_durable(identity);
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
        let (entry, queries_left) = match self.plan(queue, traffic, now_ms) {
            TickPlan::Skip(skip) => return TickStart::Skip(skip),
            TickPlan::Run {
                entry,
                queries_left,
            } => (entry, queries_left),
        };
        let identity = self.open_slot(queue, &entry, now_ms);
        TickStart::Run {
            entry,
            identity,
            queries_left,
        }
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
            // O drain sync é stub/teste sem rede: o teto rígido é do async.
            TickStart::Run {
                entry, identity, ..
            } => (entry, identity),
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
        let (entry, identity, queries_left) = match self.begin(queue, traffic, now_ms) {
            TickStart::Skip(skip) => return skip,
            TickStart::Run {
                entry,
                identity,
                queries_left,
            } => (entry, identity, queries_left),
        };

        let outcome = drain.drain_one(&entry, queries_left).await;
        self.finish(queue, &identity, outcome, now_ms);

        TickOutcome::Drained { entry, outcome }
    }
}

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
