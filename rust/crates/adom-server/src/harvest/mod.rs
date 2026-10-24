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
mod drain_shape;
mod enqueue;
mod live;
mod routes;
mod serve;
mod settle;
mod status;
mod traffic;

#[cfg(test)]
#[path = "worker_tests.rs"]
mod worker_tests;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_harvest::{
    load_hour, EnqueueOutcome, HarvestQueue, HarvestQueueConfig, HarvestRequest, HarvestStore,
    HarvestWorker, HarvestWorkerConfig,
};
use adom_search::orchestrator::Orchestrator;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

pub use config::HarvestConfig;
pub use status::{HarvestCounters, HarvestStatus};
pub use traffic::StreamTraffic;

/// Rotas administrativas do colhedor, montadas no `store_admin`.
pub(crate) use routes::router as admin_router;

use enqueue::enqueue_with_dedupe;
use live::LiveOverlay;
use serve::serve;

/// Estado compartilhado entre o loop e a API administrativa.
pub(crate) struct Inner {
    /// `.env` do gateway: a base sobre a qual o overlay do painel se aplica.
    env: HarvestConfig,
    /// Config efetiva (`.env` + painel). Leitura curta, nunca durante rede.
    config: Mutex<HarvestConfig>,
    /// O painel mudou a config: o loop reaplica no worker, na fila e no drain
    /// (os três são dele, então quem aplica é ele, no topo do ciclo).
    live_dirty: AtomicBool,
    store: Arc<HarvestStore>,
    store_path: PathBuf,
    /// A fila só é tocada pelo tick (dono) ou pelas rotas (com o lock).
    queue: AsyncMutex<HarvestQueue>,
    /// Snapshot do painel — nunca segura o lock da fila.
    status: Mutex<HarvestStatus>,
    paused: AtomicBool,
    traffic: StreamTraffic,
    /// Acorda o loop para pausa/enqueue/drain imediato.
    notify: Notify,
    /// Quantos ticks o `POST /harvest/drain` pediu (`0` = nenhum).
    drain_budget: AtomicUsize,
    /// Quem espera a resposta do drain pedido pela rota.
    drain_reply: Mutex<Option<oneshot::Sender<usize>>>,
}

impl Inner {
    fn config(&self) -> HarvestConfig {
        self.config
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    /// Aplica o overlay do painel: o que é atômico vale já (pausa, janela de
    /// tráfego); o resto o loop pega no próximo ciclo (`live_dirty`).
    fn apply_live(&self, overlay: &LiveOverlay) -> HarvestConfig {
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
    fn publish(&self, queue: &HarvestQueue, worker: &mut HarvestWorker, now: i64) {
        let mut status = self.status.lock().unwrap_or_else(|err| err.into_inner());
        status.paused = self.paused.load(Ordering::SeqCst);
        status.inflight = worker.in_flight();
        status.depth = queue.depth();
        status.preview = queue.preview(self.config().queue_preview);
        status.queries_this_hour = worker.queries_this_hour(now);
    }

    /// Foto sem worker (rotas de escrita fora do ciclo).
    fn publish_queue(&self, queue: &HarvestQueue) {
        let mut status = self.status.lock().unwrap_or_else(|err| err.into_inner());
        status.paused = self.paused.load(Ordering::SeqCst);
        status.depth = queue.depth();
        status.preview = queue.preview(self.config().queue_preview);
    }

    fn persist_queue(&self, queue: &HarvestQueue, now: i64) {
        if let Err(err) = queue.save_to(&self.store, self.config().entry_ttl, now) {
            eprintln!("[harvest] fila não persistiu: {err}");
        }
    }
}

/// Handle clonável: o worker roda mesmo se todas as cópias caírem (a thread
/// tem o `Arc` dela; este é o lado da API).
#[derive(Clone)]
pub struct HarvestHandle {
    inner: Arc<Inner>,
}

impl HarvestHandle {
    /// Config efetiva (`.env` + painel) neste instante.
    pub fn config(&self) -> HarvestConfig {
        self.inner.config()
    }

    /// `POST /harvest/config`: overrides do painel empurrados pelo Node.
    pub fn apply_live(&self, overrides: &serde_json::Value) -> HarvestConfig {
        self.inner.apply_live(&LiveOverlay::from_value(overrides))
    }

    pub fn store_path(&self) -> &Path {
        &self.inner.store_path
    }

    /// Snapshot do painel (não espera um drain em andamento).
    pub fn status(&self) -> HarvestStatus {
        self.inner
            .status
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    /// Enqueue com o dedupe 12h do Node (só grava `seen` no aceite).
    pub async fn enqueue(&self, req: HarvestRequest) -> EnqueueOutcome {
        let now = adom_sources::now_ms();
        let mut queue = self.inner.queue.lock().await;
        let outcome = enqueue_with_dedupe(&mut queue, &self.inner.store, req, now);
        if outcome.accepted {
            self.inner.persist_queue(&queue, now);
        }
        self.inner.publish_queue(&queue);
        outcome
    }

    /// Pausa/retoma. O loop aplica no próximo ciclo (o notify o acorda já).
    pub fn set_paused(&self, paused: bool) {
        self.inner.paused.store(paused, Ordering::SeqCst);
        self.inner
            .status
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .paused = paused;
        self.inner.notify.notify_one();
    }

    /// Limpa a fila e o L2. O balde horário NÃO é zerado (seria burlar o teto).
    pub async fn clear(&self) -> usize {
        let now = adom_sources::now_ms();
        let mut queue = self.inner.queue.lock().await;
        let cleared = queue.clear();
        self.inner.persist_queue(&queue, now);
        self.inner.publish_queue(&queue);
        cleared
    }

    /// Pede até `max` ticks ao loop e espera a contagem de drains.
    ///
    /// O handler axum não pode rodar `tick_async` (future `!Send`), então o
    /// pedido viaja por budget + oneshot e quem executa é a thread do loop.
    pub async fn drain(&self, max: usize) -> usize {
        let max = max.clamp(1, self.inner.config().drain_max_works);
        let (tx, rx) = oneshot::channel();
        {
            let mut slot = self
                .inner
                .drain_reply
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            if slot.is_some() {
                // Um pedido por vez: o painel não enfileira cliques.
                return 0;
            }
            *slot = Some(tx);
        }
        self.inner.drain_budget.store(max, Ordering::SeqCst);
        self.inner.notify.notify_one();
        match tokio::time::timeout(Duration::from_secs(600), rx).await {
            Ok(Ok(drained)) => drained,
            // Sem resposta (loop travado), o slot não pode ficar ocupado para
            // sempre: o próximo `/harvest/drain` volta a tentar.
            _ => {
                self.inner
                    .drain_reply
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .take();
                0
            }
        }
    }

    /// O painel pergunta só pelo IMDb (sem temporada): qualquer entrada da
    /// obra conta, e `brProbe` é a flag de sonda dirigida.
    pub async fn pending(&self, imdb: &str) -> (bool, bool) {
        let queue = self.inner.queue.lock().await;
        let mut queued = false;
        let mut probe = false;
        for entry in queue.entries() {
            if entry.imdb_id == imdb {
                queued = true;
                probe |= entry.br_probe;
            }
        }
        (queued, probe)
    }
}

/// Monta config/store/fila/worker e sobe a thread do ciclo.
///
/// `None` = colhedor desligado (`HARVEST_ENABLED=false`), store indisponível
/// ou thread não criada. O gateway segue; a API responde `enabled:false`.
pub fn spawn(orch: &Orchestrator, last_stream_ms: Arc<AtomicI64>) -> Option<HarvestHandle> {
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
    if let Err(err) = queue.load_from(&store, now, None) {
        eprintln!("[harvest] fila do L2 ilegível ({err}); começando vazia");
    }
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
        drain_budget: AtomicUsize::new(0),
        drain_reply: Mutex::new(None),
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
            runtime.block_on(serve(loop_inner, worker, orch));
        });
    if let Err(err) = thread {
        eprintln!("[harvest] thread do colhedor não subiu: {err}");
        return None;
    }
    Some(HarvestHandle { inner })
}
