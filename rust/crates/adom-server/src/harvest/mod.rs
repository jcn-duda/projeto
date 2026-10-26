//! Colhedor nativo (`adom-harvest`) DENTRO do gateway — Fase 5.
//!
//! # O que sobe
//!
//! Quando o corte nativo tem orquestrador, [`spawn`] monta:
//!
//! - `HarvestConfig::from_env()` (mesmos nomes/defaults de `harvest.ts`);
//! - `HarvestStore::open` no MESMO `cache.db` do Node
//!   (`harvest:v1:q`, `harvest:v1:hour`, `harvest:v1:seen:*`);
//! - `HarvestQueue` hidratada do L2 e do balde horário;
//! - `HarvestWorker` + [`NetworkDrain`](drain::NetworkDrain) (metadados
//!   nativos + Jackett + régua + índice nativo);
//! - as rotas administrativas (`routes`), montadas no `store_admin`.
//!
//! # Concorrência (por que uma thread própria)
//!
//! `HarvestWorker::tick_async` **não** é `Send`: o future segura
//! `&dyn TrafficSense` e `&mut dyn HarvestDrainAsync`, e nenhum dos dois traits
//! exige `Sync`/`Send`. Um `tokio::spawn` no runtime multi-thread do gateway
//! exigiria mudar essas assinaturas. O caminho mais simples que COMPILA é uma
//! thread nomeada `adom-harvest` com um runtime `current_thread`; o loop roda
//! em `Runtime::block_on(serve(...))` e nunca toca o runtime do axum.
//!
//! # O lock da fila
//!
//! O lock fica com o loop só durante a ESCOLHA e o FECHAMENTO do ciclo
//! ([`HarvestWorker::begin`]/[`HarvestWorker::finish`]). A rede do drain roda
//! FORA dele: `enqueue`/`pending`/`clear` da ponte Node (timeout de 2 s) não
//! esperam uma obra inteira, e o coalescing in-flight volta a ser alcançável
//! porque o slot já está aberto quando o lock é liberado. `GET /harvest` lê o
//! snapshot de [`HarvestStatus`].

mod config;
mod drain;
mod drain_outbox;
mod drain_record;
mod drain_shape;
mod drain_sources;
mod enqueue;
mod evidence;
mod handle;
mod live;
mod routes;
mod serve;
mod settle;
mod status;
mod traffic;

#[cfg(test)]
#[path = "worker_tests.rs"]
mod worker_tests;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use adom_harvest::{
    load_hour, replay_pending, HarvestQueue, HarvestQueueConfig, HarvestStore, HarvestWorker,
    HarvestWorkerConfig, ReplayReport,
};
use adom_search::orchestrator::{Orchestrator, SharedIndex};
use adom_store::StreamsStore;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

pub use config::HarvestConfig;
pub use handle::HarvestHandle;
pub use status::{HarvestCounters, HarvestStatus};
pub use traffic::StreamTraffic;

/// Rotas administrativas do colhedor, montadas no `store_admin`.
pub(crate) use routes::router as admin_router;

use evidence::{queue_identities, EvidenceSnapshot};
use live::LiveOverlay;
use serve::serve;

/// Estado compartilhado entre o loop e a API administrativa.
pub(crate) struct Inner {
    /// `.env` do gateway: a base sobre a qual o overlay do painel se aplica.
    pub(crate) env: HarvestConfig,
    /// Config efetiva (`.env` + painel). Leitura curta, nunca durante rede.
    pub(crate) config: Mutex<HarvestConfig>,
    /// O painel mudou a config: o loop reaplica no worker, na fila e no drain
    /// (os três são dele, então quem aplica é ele, no topo do ciclo).
    pub(crate) live_dirty: AtomicBool,
    pub(crate) store: Arc<HarvestStore>,
    pub(crate) store_path: PathBuf,
    /// A fila só é tocada pelo tick (dono) ou pelas rotas (com o lock).
    pub(crate) queue: AsyncMutex<HarvestQueue>,
    /// Snapshot do painel — nunca segura o lock da fila.
    pub(crate) status: Mutex<HarvestStatus>,
    pub(crate) paused: AtomicBool,
    pub(crate) traffic: StreamTraffic,
    /// Acorda o loop para pausa/enqueue/drain imediato.
    pub(crate) notify: Notify,
    /// Preempção intradrain: obra de rank maior chegou e o drain em voo é
    /// dropado. Separado do [`Self::notify`] de propósito — acordar o loop não
    /// pode interromper a obra que já está na rede.
    pub(crate) preempt: Notify,
    /// Rank do motivo da obra EM VOO (`None` = nenhum drain aberto), escrito
    /// pelo loop com o lock da fila. O enqueue compara com ele para decidir a
    /// preempção; o coalescing pode elevar o rank do slot e a comparação fica
    /// conservadora (rank da entrada que abriu o slot).
    pub(crate) inflight_rank: Mutex<Option<u8>>,
    /// Quantos ticks o `POST /harvest/drain` pediu (`0` = nenhum).
    pub(crate) drain_budget: AtomicUsize,
    /// Quem espera a resposta do drain pedido pela rota.
    pub(crate) drain_reply: Mutex<Option<oneshot::Sender<usize>>>,
    /// Índice nativo do orquestrador (ausente = foto neutra).
    pub(crate) index: Option<SharedIndex>,
    /// Última foto de evidência. Nunca segura este mutex à espera da fila.
    pub(crate) evidence: Mutex<EvidenceSnapshot>,
}

impl Inner {
    pub(crate) fn config(&self) -> HarvestConfig {
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    /// Aplica o overlay do painel: o que é atômico vale já (pausa, janela de
    /// tráfego); o resto o loop pega no próximo ciclo (`live_dirty`).
    pub(crate) fn apply_live(&self, overlay: &LiveOverlay) -> HarvestConfig {
        let config = overlay.apply(&self.env);
        *self.config.lock().unwrap_or_else(|err| err.into_inner()) = config.clone();
        self.traffic.set_idle_window(config.idle_window_ms);
        self.paused.store(overlay.paused, Ordering::SeqCst);
        self.status
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .paused = overlay.paused;
        self.live_dirty.store(true, Ordering::SeqCst);
        self.notify.notify_one();
        config
    }

    /// Foto da fila (+ worker, quando o loop está no comando).
    pub(crate) fn publish(&self, queue: &HarvestQueue, worker: &mut HarvestWorker, now: i64) {
        let mut status = self.status.lock().unwrap_or_else(|err| err.into_inner());
        status.paused = self.paused.load(Ordering::SeqCst);
        status.inflight = worker.in_flight();
        status.depth = queue.depth();
        status.preview = queue.preview(self.config().queue_preview);
        status.queries_this_hour = worker.queries_this_hour(now);
    }

    /// Foto sem worker (rotas de escrita fora do ciclo).
    pub(crate) fn publish_queue(&self, queue: &HarvestQueue) {
        let mut status = self.status.lock().unwrap_or_else(|err| err.into_inner());
        status.paused = self.paused.load(Ordering::SeqCst);
        status.depth = queue.depth();
        status.preview = queue.preview(self.config().queue_preview);
    }

    pub(crate) fn persist_queue(&self, queue: &HarvestQueue, now: i64) {
        if let Err(err) = queue.save_to(&self.store, self.config().entry_ttl, now) {
            eprintln!("[harvest] fila não persistiu: {err}");
        }
    }

    /// Abre/fecha o rank da obra em voo. Chamado SEMPRE com o lock da fila —
    /// é ele que serializa com o enqueue que decide a preempção.
    pub(crate) fn set_inflight_rank(&self, rank: Option<u8>) {
        *self
            .inflight_rank
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = rank;
    }

    /// Rank do motivo da obra em voo; `None` = nenhum drain aberto.
    pub(crate) fn current_inflight_rank(&self) -> Option<u8> {
        *self
            .inflight_rank
            .lock()
            .unwrap_or_else(|err| err.into_inner())
    }
}

/// Monta config/store/fila/worker e sobe a thread do ciclo.
///
/// `None` = colhedor desligado (`HARVEST_ENABLED=false`), store indisponível
/// ou thread não criada. O gateway segue; a API responde `enabled:false`.
pub fn spawn(
    orch: &Orchestrator,
    last_stream_ms: Arc<AtomicI64>,
    streams: Option<Arc<StreamsStore>>,
) -> Option<HarvestHandle> {
    let config = HarvestConfig::from_env();
    if !config.enabled {
        eprintln!("[harvest] desligado (HARVEST_ENABLED=false)");
        return None;
    }
    let store_path = adom_store::default_cache_db_path();
    let store = match HarvestStore::open(&store_path) {
        Ok(store) => Arc::new(store),
        Err(err) => {
            eprintln!(
                "[harvest] store indisponível ({}): {err}; colhedor desligado",
                store_path.display()
            );
            return None;
        }
    };

    let now = adom_sources::now_ms();
    // O `.env` decide se a thread existe; o painel só ajusta o colhedor de pé
    // (inclusive desligar), e o overlay do disco vale desde o boot.
    let env = config;
    let overlay = LiveOverlay::load(&store, now).unwrap_or_default();
    let config = overlay.apply(&env);
    let mut queue = HarvestQueue::with_clock(
        HarvestQueueConfig {
            enabled: config.enabled,
            queue_max: config.queue_max,
            br_first: config.br_first,
            br_max_wait_ms: config.br_max_wait_ms,
        },
        adom_sources::now_ms,
    );
    // Replay ANTES do `load_from`: é o documento CRU (com o slot do processo
    // anterior) que diz qual run interrompido tem obra para retomar. Aqui só se
    // fecha o journal e se aponta a obra; quem a devolve à fila é o `load_from`.
    let replay = match replay_pending(&store, now) {
        Ok(report) => report,
        Err(err) => {
            eprintln!("[harvest] replay não rodou: {err}");
            ReplayReport::default()
        }
    };
    if replay.pending > 0 {
        eprintln!(
            "[harvest] replay: {} run(s) aberto(s), {} obra(s) retomada(s), {} órfão(s)",
            replay.pending,
            replay.replayed(),
            replay.orphans
        );
    }
    if let Err(err) = queue.load_from(&store, now, None) {
        eprintln!("[harvest] fila do L2 ilegível ({err}); começando vazia");
    }
    // A obra do run interrompido já voltou pelo `load_from`; marcar `resumed`
    // é o que o painel e a preempção leem para dizer que ela é retomada.
    for slot in &replay.resumed {
        if !queue.mark_resumed(&slot.entry_id) {
            eprintln!(
                "[harvest] replay: {} fechou no journal mas não está na fila",
                slot.entry_id
            );
        }
    }
    // O slot do processo anterior é morto por definição: `load_from` já o
    // devolveu à fila. Gravar agora impede que uma queda antes do primeiro
    // ciclo conte a MESMA morte duas vezes.
    if let Err(err) = queue.save_to(&store, config.entry_ttl, now) {
        eprintln!("[harvest] fila não reancorou após o boot: {err}");
    }
    if store.degraded() {
        eprintln!(
            "[harvest] L2 DEGRADADO ({}): {}",
            store_path.display(),
            store.degraded_error().unwrap_or("arquivo quarentenado")
        );
    }
    let index = orch.index_source().cloned();
    let snap = EvidenceSnapshot::from_index(index.as_deref(), &queue_identities(&queue), now);
    queue.prioritize(&snap, now);
    let mut worker = HarvestWorker::new(HarvestWorkerConfig {
        enabled: config.enabled,
        max_per_hour: config.max_per_hour,
    });
    if let Ok(Some(hour)) = load_hour(&store, now) {
        worker.hydrate_hour(hour.count, now);
    }

    let status = HarvestStatus {
        paused: overlay.paused,
        inflight: false,
        depth: queue.depth(),
        preview: queue.preview(config.queue_preview),
        last: Vec::new(),
        queries_this_hour: worker.queries_this_hour(now),
        counters: HarvestCounters::default(),
        pending_runs: replay.pending_after(),
        replayed_runs: replay.replayed(),
        // Veredito do `open` do L2: arquivo podre vira `degraded` no painel.
        ..HarvestStatus::with_store(&store)
    };
    let inner = Arc::new(Inner {
        traffic: StreamTraffic::new(last_stream_ms, config.idle_window_ms),
        env,
        config: Mutex::new(config.clone()),
        live_dirty: AtomicBool::new(false),
        store,
        store_path: store_path.clone(),
        queue: AsyncMutex::new(queue),
        status: Mutex::new(status),
        paused: AtomicBool::new(overlay.paused),
        notify: Notify::new(),
        preempt: Notify::new(),
        inflight_rank: Mutex::new(None),
        drain_budget: AtomicUsize::new(0),
        drain_reply: Mutex::new(None),
        index,
        evidence: Mutex::new(snap),
    });

    eprintln!(
        "[harvest] colhedor nativo: fila em {}, intervalo {}, teto {}/h",
        store_path.display(),
        config.interval_ms,
        config.max_per_hour
    );

    let orch = orch.clone();
    let loop_inner = inner.clone();
    let thread = std::thread::Builder::new()
        .name("adom-harvest".to_string())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("[harvest] runtime da thread não montou: {err}");
                    return;
                }
            };
            runtime.block_on(serve(loop_inner, worker, orch, streams));
        });
    if let Err(err) = thread {
        eprintln!("[harvest] thread do colhedor não subiu: {err}");
        return None;
    }
    Some(HarvestHandle { inner })
}
