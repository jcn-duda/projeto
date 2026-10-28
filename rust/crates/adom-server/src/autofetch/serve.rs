//! Laço do worker NATIVO: canal, lote, timer e dreno na MESMA thread.
//!
//! A thread é `current_thread` (uma passagem por vez) e o relógio vem dos LOTES
//! persistidos (`recheck::due`), não de um `sleep` cego: o worker acorda com
//! trabalho — lote novo no canal, pedido de dreno, lote vencido ou intervalo.
//!
//! Uma passagem: (1) consome TUDO o que está no canal (`try_recv`), cada lote
//! vai para [`enqueue::run`] e, com aceite, para [`recheck::schedule`];
//! (2) `Message::Drain` varre os lotes vivos e chama o dreno; (3) timers: lote
//! vencido roda [`recheck::step`] e terminal com fila viva chama
//! [`enqueue_drain::drain_one`] — nunca dreno cego; (4) poda o cofre.
//!
//! O `AutofetchDebrid` entra como `Arc<dyn ...>` pelo chamador (teste ou a
//! fábrica por conta da leva do flip). Sem ele o worker fica `prepared` e nada
//! consome o canal: `enabled` é `AUTOFETCH_WORKER=on` **e** adaptador presente.
//! Nenhuma passagem entra no caminho da resposta: o canal é do laço.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use adom_autofetch::v3::AutofetchDebrid;
use adom_index::NativeKv;
use tokio::sync::{mpsc, Notify};

use super::enqueue::{self, Holds, Job};
use super::enqueue_drain;
use super::recheck;
use super::vault::Vault;
use super::Policy;

/// Adaptador de debrid já vinculado à conta por quem o construiu. O laço nunca
/// vê a chave: quem a guarda é o cofre.
pub(crate) type DebridIo = Arc<dyn AutofetchDebrid<Error = String>>;

/// Capacidade do canal: um lote por busca em voo, sem bloquear quem publica.
pub(crate) const CHANNEL_CAPACITY: usize = 64;

/// Trabalho do canal.
#[derive(Debug)]
pub(crate) enum Message {
    Batch(Job),
    Drain,
}

/// Retrato dos contadores para o painel (`GET /autofetch`).
#[derive(Debug, Default, Clone)]
pub(crate) struct Snapshot {
    pub(crate) inflight: bool,
    pub(crate) processed: u64,
    pub(crate) skips: BTreeMap<String, usize>,
    pub(crate) last_error: Option<String>,
}

/// Regras vivas em RAM: pausa/intervalo que o laço lê a cada volta, mais os
/// contadores. O `POST /autofetch/config` persiste no KV e espelha aqui — o
/// laço nunca toca SQLite para saber se está pausado.
pub(crate) struct Control {
    paused: AtomicBool,
    interval_ms: AtomicU64,
    inflight: AtomicUsize,
    processed: AtomicU64,
    last_error: Mutex<Option<String>>,
    skips: Mutex<BTreeMap<String, usize>>,
    notify: Notify,
}

impl Control {
    pub(crate) fn new(paused: bool, interval_ms: u64) -> Self {
        Self {
            paused: AtomicBool::new(paused),
            interval_ms: AtomicU64::new(interval_ms.max(1)),
            inflight: AtomicUsize::new(0),
            processed: AtomicU64::new(0),
            last_error: Mutex::new(None),
            skips: Mutex::new(BTreeMap::new()),
            notify: Notify::new(),
        }
    }

    pub(crate) fn paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub(crate) fn interval_ms(&self) -> u64 {
        self.interval_ms.load(Ordering::Relaxed).max(1)
    }

    pub(crate) fn set_interval_ms(&self, interval_ms: u64) {
        self.interval_ms
            .store(interval_ms.max(1), Ordering::Relaxed);
    }

    /// Acorda o laço (chegou trabalho ou o painel mexeu na config).
    pub(crate) fn wake(&self) {
        self.notify.notify_one();
    }

    pub(crate) async fn wait(&self) {
        self.notify.notified().await;
    }

    fn enter(&self) {
        self.inflight.fetch_add(1, Ordering::Relaxed);
    }

    fn leave(&self) {
        self.inflight.fetch_sub(1, Ordering::Relaxed);
    }
    pub(crate) fn inflight(&self) -> bool {
        self.inflight.load(Ordering::Relaxed) > 0
    }

    fn record(&self, pass: &Pass) {
        self.processed
            .fetch_add(pass.jobs as u64, Ordering::Relaxed);
        let mut skips = self.skips.lock().unwrap_or_else(PoisonError::into_inner);
        for (label, count) in &pass.skips {
            *skips.entry(label.clone()).or_default() += count;
        }
        if let Some(first) = pass.errors.first() {
            *self
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(first.clone());
        }
    }

    pub(crate) fn snapshot(&self) -> Snapshot {
        Snapshot {
            inflight: self.inflight(),
            processed: self.processed.load(Ordering::Relaxed),
            skips: self
                .skips
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
            last_error: self
                .last_error
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone(),
        }
    }
}

/// O que UMA passagem fez: log e contadores (o painel lê `Control::snapshot`).
#[derive(Debug, Default, Clone)]
pub(crate) struct Pass {
    pub(crate) jobs: usize,
    pub(crate) enqueued: usize,
    pub(crate) scheduled: usize,
    pub(crate) drained: usize,
    pub(crate) rechecked: usize,
    pub(crate) forgotten_keys: usize,
    pub(crate) skips: BTreeMap<String, usize>,
    pub(crate) errors: Vec<String>,
}

impl Pass {
    fn skip(&mut self, label: &str, count: usize) {
        *self.skips.entry(label.to_string()).or_default() += count;
    }
}

/// Uma passagem com os donos do ciclo: KV, réguas, holds (memória), cofre,
/// adaptador e contadores. O `Holds` vive aqui: preso durante a passagem, solto
/// no fim por cada módulo que o adquiriu.
pub(crate) struct Engine<'a, D: AutofetchDebrid<Error = String> + ?Sized> {
    kv: &'a NativeKv,
    policy: Policy,
    holds: Holds,
    vault: Option<&'a Vault>,
    debrid: &'a D,
    control: &'a Control,
}

impl<'a, D: AutofetchDebrid<Error = String> + ?Sized> Engine<'a, D> {
    pub(crate) fn new(
        kv: &'a NativeKv,
        policy: Policy,
        vault: Option<&'a Vault>,
        debrid: &'a D,
        control: &'a Control,
    ) -> Self {
        Self {
            kv,
            policy,
            holds: Holds::default(),
            vault,
            debrid,
            control,
        }
    }

    /// Uma passagem completa: canal, dreno pedido, timers dos lotes e poda do
    /// cofre. Devolve o que fez e atualiza os contadores.
    pub(crate) async fn run_once(&self, rx: &mut mpsc::Receiver<Message>, now_ms: i64) -> Pass {
        let paused = self.control.paused();
        self.control.enter();
        let mut pass = Pass::default();
        loop {
            match rx.try_recv() {
                Ok(Message::Batch(job)) => self.batch(&job, paused, now_ms, &mut pass).await,
                Ok(Message::Drain) => self.drain_all(paused, now_ms, &mut pass).await,
                // Canal vazio (ou fechado): a passagem de timers ainda vale.
                Err(_) => break,
            }
        }
        self.timers(paused, now_ms, &mut pass).await;
        if let Some(vault) = self.vault {
            pass.forgotten_keys = vault.sweep(now_ms);
        }
        self.control.leave();
        self.control.record(&pass);
        pass
    }

    /// Um lote do canal: enfileirar e, com aceite, armar o recheck.
    async fn batch(&self, job: &Job, paused: bool, now_ms: i64, pass: &mut Pass) {
        pass.jobs += 1;
        let report = match enqueue::run(
            self.kv,
            self.policy,
            &self.holds,
            paused,
            self.debrid,
            job,
            now_ms,
        )
        .await
        {
            Ok(report) => report,
            Err(err) => {
                pass.errors.push(err);
                return;
            }
        };
        for (label, count) in &report.skips {
            pass.skip(label, *count);
        }
        if let Some(label) = report.refused {
            pass.skip(label, 1);
        }
        pass.enqueued += report.enqueued.len();
        if report.enqueued.is_empty() {
            return;
        }
        let Some((adapter, account)) = job.scope.split_once(':') else {
            return;
        };
        match recheck::schedule(
            self.kv,
            self.policy,
            &report.search_key,
            adapter,
            account,
            &report.enqueued,
            now_ms,
        ) {
            Ok(_) => pass.scheduled += 1,
            Err(err) => pass.errors.push(err),
        }
    }

    /// Timers: só lote vencido roda; terminal com fila viva pede o próximo.
    async fn timers(&self, paused: bool, now_ms: i64, pass: &mut Pass) {
        let lots = match recheck::due(self.kv, self.policy, now_ms) {
            Ok(lots) => lots,
            Err(err) => {
                pass.errors.push(err);
                return;
            }
        };
        for lot in lots {
            let alldebrid = lot.adapter_id == "alldebrid";
            let report = match recheck::step(
                self.kv,
                self.policy,
                self.debrid,
                alldebrid,
                &lot.search_key,
                now_ms,
            )
            .await
            {
                Ok(report) => report,
                Err(err) => {
                    pass.errors
                        .push(format!("recheck de {}: {err}", lot.adapter_id));
                    continue;
                }
            };
            pass.rechecked += usize::from(report.ran);
            if report.terminal {
                pass.drained += self.drain_lot(&lot, paused, now_ms, pass).await;
            }
        }
    }

    /// Pedido da rota admin: varre os lotes vivos e drena cada fila.
    async fn drain_all(&self, paused: bool, now_ms: i64, pass: &mut Pass) {
        let lots = match recheck::lots(self.kv, now_ms) {
            Ok(lots) => lots,
            Err(err) => {
                pass.errors.push(err);
                return;
            }
        };
        for lot in lots {
            pass.drained += self.drain_lot(&lot, paused, now_ms, pass).await;
        }
    }

    async fn drain_lot(
        &self,
        lot: &recheck::Lot,
        paused: bool,
        now_ms: i64,
        pass: &mut Pass,
    ) -> usize {
        if lot.search_key.is_empty() || lot.adapter_id.is_empty() || lot.account.is_empty() {
            return 0;
        }
        let scope = format!("{}:{}", lot.adapter_id, lot.account);
        match enqueue_drain::drain_one(
            self.kv,
            self.policy,
            &self.holds,
            paused,
            self.debrid,
            &scope,
            &lot.search_key,
            now_ms,
        )
        .await
        {
            Ok(report) => usize::from(report.started.is_some()),
            Err(err) => {
                pass.errors.push(err);
                0
            }
        }
    }
}

/// Sobe a thread do laço (`current_thread`) e devolve o controle ao chamador.
pub(crate) fn spawn(
    kv: Arc<NativeKv>,
    policy: Policy,
    vault: Option<Arc<Vault>>,
    debrid: DebridIo,
    mut rx: mpsc::Receiver<Message>,
    control: Arc<Control>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("adom-autofetch".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("[autofetch] runtime do laço não iniciou: {err}");
                    return;
                }
            };
            runtime.block_on(async move {
                let engine = Engine::new(&kv, policy, vault.as_deref(), &*debrid, &control);
                loop {
                    let wait = control.interval_ms();
                    tokio::select! {
                        _ = control.wait() => {},
                        _ = tokio::time::sleep(Duration::from_millis(wait)) => {},
                    }
                    let pass = engine.run_once(&mut rx, adom_sources::now_ms()).await;
                    if !pass.errors.is_empty() {
                        eprintln!(
                            "[autofetch] passagem com {} falha(s): {}",
                            pass.errors.len(),
                            pass.errors.join("; ")
                        );
                    }
                }
            });
        })
        .map(|_| ())
        .map_err(|err| err.to_string())
}

#[cfg(test)]
#[path = "serve_tests.rs"]
mod tests;
