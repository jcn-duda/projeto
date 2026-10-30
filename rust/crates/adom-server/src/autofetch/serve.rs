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
//! # Adaptador por CONTA
//!
//! O worker serve MUITAS contas: quem resolve `adapter:conta` → adaptador é a
//! [`DebridFactory`], chamada a CADA passo (a chave é lida do cofre no momento
//! do uso; o laço nunca guarda chave nem adaptador entre lotes). Passo sem chave
//! viva é PULADO com o motivo `no-credential` — nunca erro fatal: um escopo sem
//! cofre não pode derrubar o lote dos outros.
//!
//! Nenhuma passagem entra no caminho da resposta: o canal é do laço.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use adom_index::NativeKv;
use tokio::sync::mpsc;

use super::enqueue::{Holds, Job};
use super::enqueue_drain;
use super::recheck;
use super::vault::Vault;
use super::worker::live;
use super::Policy;
use crate::harvest::HarvestHandle;

pub(crate) use super::control::{Control, Snapshot};
pub(crate) use super::ports::DebridFactory;

/// Capacidade do canal: um lote por busca em voo, sem bloquear quem publica.
pub(crate) const CHANNEL_CAPACITY: usize = 64;

/// Trabalho do canal.
#[derive(Debug)]
pub(crate) enum Message {
    Batch(Job),
    Drain,
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
    /// Sondas com `pending` gravado nesta passagem.
    pub(crate) probed: usize,
    /// Buscas de temporada registradas nesta passagem.
    pub(crate) seasons: usize,
    /// Packs prontos que PREENCHERAM a temporada (índice consumido).
    pub(crate) filled: usize,
    /// Buscas da temporada invalidadas no cache de streams.
    pub(crate) invalidated: usize,
    /// Evicção F6: hashes de fallback REMOVIDOS da conta nesta passagem.
    pub(crate) evicted: usize,
    /// `adrm` gravados (anti-reenchimento dos hashes removidos).
    pub(crate) evict_marked: usize,
    pub(crate) skips: BTreeMap<String, usize>,
    pub(crate) errors: Vec<String>,
}

impl Pass {
    fn skip(&mut self, label: &str, count: usize) {
        *self.skips.entry(label.to_string()).or_default() += count;
    }
}

/// Uma passagem com os donos do ciclo: KV, réguas, holds (memória), cofre,
/// fábrica de adaptadores e contadores. O `Holds` vive aqui: preso durante a
/// passagem, solto no fim por cada módulo que o adquiriu.
pub(crate) struct Engine<'a> {
    kv: &'a NativeKv,
    policy: Policy,
    /// Boletim `cfg:v1:autofetch` desta PASSAGEM: pausa e os toggles de passo.
    /// O `policy` acima já sai com os overrides de tempo aplicados; o overlay
    /// fica aqui para o que não é `Policy` (pausa, sonda, season fill).
    live: live::LiveOverlay,
    /// Falha ao reler o boletim. A base continua valendo e o motivo vira erro da
    /// passagem — configuração ilegível não derruba o ciclo.
    live_error: Option<String>,
    holds: Holds,
    vault: Option<&'a Vault>,
    debrid: &'a DebridFactory,
    control: &'a Control,
    /// Colhedor nativo: `None` até o boot registrá-lo (ou sem colhedor no
    /// processo). Só a sonda dirigida depende dele.
    harvest: Option<&'a HarvestHandle>,
}

impl<'a> Engine<'a> {
    pub(crate) fn new(
        kv: &'a NativeKv,
        policy: Policy,
        vault: Option<&'a Vault>,
        debrid: &'a DebridFactory,
        control: &'a Control,
        harvest: Option<&'a HarvestHandle>,
    ) -> Self {
        Self {
            kv,
            policy,
            live: live::LiveOverlay::default(),
            live_error: None,
            holds: Holds::default(),
            vault,
            debrid,
            control,
            harvest,
        }
    }

    /// Boletim ao vivo desta passagem (ver [`engine_for_pass`]). Sem esta fiação
    /// o `Engine` roda só com o `.env` do processo.
    fn with_live(mut self, live: live::LiveOverlay, error: Option<String>) -> Self {
        self.live = live;
        self.live_error = error;
        self
    }

    /// Uma passagem completa: canal, dreno pedido, timers dos lotes e poda do
    /// cofre. Devolve o que fez e atualiza os contadores.
    pub(crate) async fn run_once(&self, rx: &mut mpsc::Receiver<Message>, now_ms: i64) -> Pass {
        // Pausa da passagem: a admin do gateway OU o painel. O `||` é a regra
        // do boot (`load_effective`) levada ao ciclo — pausa do painel não
        // espera restart, e retomar continua sendo da admin.
        let paused = self.control.paused() || self.live.paused;
        self.control.enter();
        let mut pass = Pass::default();
        if let Some(err) = self.live_error.clone() {
            pass.errors.push(err);
        }
        loop {
            match rx.try_recv() {
                Ok(Message::Batch(job)) => self.batch(&job, paused, now_ms, &mut pass).await,
                Ok(Message::Drain) => self.drain_all(paused, now_ms, &mut pass).await,
                // Canal vazio (ou fechado): a passagem de timers ainda vale.
                Err(_) => break,
            }
        }
        self.timers(paused, now_ms, &mut pass).await;
        self.drain_suppressed(now_ms, &mut pass).await;
        if let Some(vault) = self.vault {
            pass.forgotten_keys = vault.sweep(now_ms);
        }
        self.control.leave();
        self.control.record(pass.jobs, &pass.skips, &pass.errors);
        pass
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
        // Evicção F6 (destrutiva): kill-switch e orçamento PRÓPRIOS, um por
        // PASSAGEM — o teto é da rodada, não de cada obra nem de cada lote.
        let evict = evict_job::EvictConfig::from_env();
        let mut evict_left = evict.gates.max_per_run;
        for lot in lots {
            let scope = format!("{}:{}", lot.adapter_id, lot.account);
            let Some(debrid) = (self.debrid)(&scope) else {
                pass.skip("no-credential", 1);
                continue;
            };
            let alldebrid = lot.adapter_id == "alldebrid";
            let report = match recheck::step(
                self.kv,
                self.policy,
                &*debrid,
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
            // Lado do PACK: o release que ficou pronto invalida as buscas da
            // temporada dele. Falha aqui não derruba a passagem nem o lote.
            let fill = self.fill_ready(&lot, paused, &report.ready, &debrid, now_ms);
            pass.filled += fill.filled;
            pass.invalidated += fill.invalidated;
            for (label, count) in &fill.skips {
                pass.skip(label, *count);
            }
            pass.errors.extend(
                fill.errors
                    .into_iter()
                    .map(|err| format!("season-fill: {err}")),
            );
            // Lado da EVICÇÃO: o fallback da mesma obra cai depois do ready BR.
            // Mesma credencial do lote, e fora do caminho da resposta.
            if !report.ready.is_empty() {
                let mut call = jobs::EvictCall {
                    lot: &lot,
                    ready: &report.ready,
                    paused,
                    left: &mut evict_left,
                };
                let evict_pass = self.evict_ready(&mut call, &debrid, &evict, now_ms).await;
                pass.evicted += evict_pass.removed;
                pass.evict_marked += evict_pass.marked;
                for (label, count) in &evict_pass.skips {
                    pass.skip(label, *count);
                }
                pass.errors.extend(
                    evict_pass
                        .errors
                        .into_iter()
                        .map(|err| format!("evict: {err}")),
                );
            }
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
        let Some(debrid) = (self.debrid)(&scope) else {
            pass.skip("no-credential", 1);
            return 0;
        };
        match enqueue_drain::drain_one(
            self.kv,
            self.policy,
            &self.holds,
            paused,
            &*debrid,
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

/// `Engine` de UMA passagem: relê `cfg:v1:autofetch` e aplica sobre a `Policy`
/// base (**live > base**).
///
/// O laço chama isto a cada volta — nada de config herdada do boot: o painel
/// vale na passagem seguinte ao clique. A falha de leitura mantém a base e vira
/// erro da passagem, nunca um `return` que pararia o worker.
fn engine_for_pass<'a>(
    kv: &'a NativeKv,
    base: &Policy,
    vault: Option<&'a Vault>,
    debrid: &'a DebridFactory,
    control: &'a Control,
    harvest: Option<&'a HarvestHandle>,
    now_ms: i64,
) -> Engine<'a> {
    let (policy, live, error) = live::LiveOverlay::pass(kv, base, now_ms);
    Engine::new(kv, policy, vault, debrid, control, harvest).with_live(live, error)
}

/// Sobe a thread do laço (`current_thread`) e devolve o controle ao chamador.
pub(crate) fn spawn(
    kv: Arc<NativeKv>,
    policy: Policy,
    vault: Option<Arc<Vault>>,
    debrid: DebridFactory,
    mut rx: mpsc::Receiver<Message>,
    control: Arc<Control>,
    harvest: Arc<OnceLock<HarvestHandle>>,
) -> Result<(), String> {
    std::thread::Builder::new()
        .name("adom-autofetch".into())
        .spawn(move || {
            // IO ligado: os portos de debrid fazem HTTP (`reqwest`) DENTRO deste
            // runtime; só com `enable_time` a primeira conexão TCP entrava em
            // pânico ("IO is disabled") e toda checagem do lote falhava.
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => {
                    eprintln!("[autofetch] runtime do laço não iniciou: {err}");
                    return;
                }
            };
            runtime.block_on(async move {
                loop {
                    let wait = control.interval_ms();
                    tokio::select! {
                        _ = control.wait() => {},
                        _ = tokio::time::sleep(Duration::from_millis(wait)) => {},
                    }
                    // O colhedor nasce DEPOIS do laço (`proxy::run`): o slot é
                    // lido a cada passagem, nunca fixado no boot. A config ao
                    // vivo segue a mesma régua (`engine_for_pass`).
                    let now_ms = adom_sources::now_ms();
                    let engine = engine_for_pass(
                        &kv,
                        &policy,
                        vault.as_deref(),
                        &debrid,
                        &control,
                        harvest.get(),
                        now_ms,
                    );
                    let pass = engine.run_once(&mut rx, now_ms).await;
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

#[path = "serve_jobs.rs"]
mod jobs;

#[path = "evict_job.rs"]
mod evict_job;

#[cfg(test)]
#[path = "serve_tests.rs"]
mod tests;

// Boletim ao vivo de cada passagem (P1/P2/P3): arquivo próprio pela catraca.
#[cfg(test)]
#[path = "serve_live_tests.rs"]
mod live_tests;
