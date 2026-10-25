//! Vocabulário do ciclo do worker (config, freio, drain e decisão).
//!
//! Saiu de `worker.rs` para o arquivo do ciclo caber no teto de 400 linhas sem
//! perder nenhum contrato: o `HarvestWorker` reexporta estes nomes, então quem
//! importa `crate::worker::*` (ou a raiz do crate) não muda.

use std::future::Future;
use std::pin::Pin;

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
/// `&mut dyn HarvestDrainAsync`, como o [`crate::HarvestWorker::tick_async`]
/// recebe. A entrega boxeada é por entrada colhida, nunca por resposta HTTP.
///
/// `queries_left` é o teto rígido da hora corrente; quem drena corta entre
/// consultas e devolve em [`DrainOutcome::queries`] só o que gastou de fato.
pub trait HarvestDrainAsync {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
        queries_left: u32,
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
pub(crate) enum TickPlan {
    Skip(TickOutcome),
    Run {
        entry: HarvestEntry,
        /// Saldo do balde desta hora; `plan` só deixa passar com ≥ 1.
        queries_left: u32,
    },
}

/// Início do ciclo para quem precisa SOLTAR o lock da fila durante a rede
/// (gateway): as guardas rodaram, a cabeça saiu e o slot em voo já está aberto.
/// Fechar é [`crate::HarvestWorker::finish`].
#[derive(Debug)]
pub enum TickStart {
    Skip(TickOutcome),
    Run {
        entry: HarvestEntry,
        identity: String,
        /// Teto rígido da hora: o drain não gasta mais que isto em consultas.
        queries_left: u32,
    },
}
