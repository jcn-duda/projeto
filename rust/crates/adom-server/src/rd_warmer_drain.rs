//! Drenagem, tick ocioso e persistência do warmer.
//!
//! Separado do `rd_warmer.rs` pela catraca de 400 linhas: a estrutura e a régua
//! do `enqueue` ficam lá; aqui mora o laço que conversa com a sonda.
//!
//! # Freio de tráfego
//!
//! `stream_traffic` é o MESMO `AtomicI64` escrito pelo `dispatch` do `/stream`
//! nativo e lido pelo colhedor. Enquanto a janela de
//! `DEBRID_RD_WARM_IDLE_WINDOW_MS` não passa, o tick não toca a conta. O
//! `enqueue` também agenda uma passagem, mas ela cai no mesmo freio: publicar
//! um efeito logo depois de uma busca NÃO dispara HTTP.
//!
//! # Quota
//!
//! O teto é por hora civil e mora em `rdq:v1:hour` (a mesma chave do Node).
//! `take_batch` desconta do teto ANTES da rede; o que o gate não sondou volta
//! para a frente e o desconto é devolvido (`restore_unattempted`). Hash que o
//! magnetdb prova `bad` sai sem gastar quota (`discard_untried`).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use adom_harvest::TrafficSense;

use super::sink::FlightGuard;
use super::{WarmItem, WarmReport, WarmSignal, Warmer, HOUR_MS};

impl Warmer {
    /// Reidrata fila e balde horário do KV no boot. Item do Node (sem `scope`)
    /// adota o escopo do operador resolvido agora.
    pub(super) fn hydrate(&self) {
        let now = adom_sources::now_ms();
        let default_scope = self.inner.key.default_scope(now).unwrap_or_default();
        let items = self
            .inner
            .queue
            .load(now, self.inner.config.queue_max, &default_scope);
        let (hour, count) = self.inner.queue.load_hour(now);
        let mut state = self.lock();
        state.queue = items.into();
        state.hour = hour;
        state.per_hour = count;
    }

    /// Drenagem completa (teste e `publish`): consome a fila em lotes de
    /// `DEBRID_RD_WARM_BATCH`, parando no teto/cooldown. O tick usa um lote só
    /// (`drain_if_idle`) para não segurar a janela ociosa por muito tempo.
    #[allow(dead_code)]
    pub(crate) async fn drain(&self) -> usize {
        self.drain_batch(usize::MAX).await
    }

    /// Dreno do operador (`POST /rd-warm/drain`). `max == 0` = lote padrão.
    /// Respeita pausa e tráfego, como o `drain(max)` do Node.
    pub(crate) async fn drain_admin(&self, max: usize) -> usize {
        if self.is_paused() {
            return 0;
        }
        if let Some(traffic) = self.inner.traffic.as_ref() {
            if traffic.is_busy() {
                return 0;
            }
        }
        let limit = if max == 0 {
            self.inner.config.batch
        } else {
            max
        };
        self.drain_batch(limit).await
    }

    /// Tick do timer: só trabalha com o app ocioso.
    pub(crate) async fn drain_if_idle(&self) -> usize {
        if self.is_paused() {
            return 0;
        }
        if let Some(traffic) = self.inner.traffic.as_ref() {
            if traffic.is_busy() {
                return 0;
            }
        }
        self.drain_batch(self.inner.config.batch).await
    }

    /// Drena até `max` hashes. Um drain por vez (`in_flight`), como o Node.
    pub(crate) async fn drain_batch(&self, max: usize) -> usize {
        {
            let mut state = self.lock();
            if state.in_flight || state.queue.is_empty() || self.is_paused() {
                return 0;
            }
            state.in_flight = true;
        }
        let _flight = FlightGuard {
            inner: self.inner.clone(),
        };
        let limit = max.max(1);
        let mut processed = 0usize;
        while processed < limit {
            let now = adom_sources::now_ms();
            self.inner.last_tick_at.store(now, Ordering::Relaxed);
            let mut batch = self.take_batch(now, limit - processed);
            if batch.is_empty() {
                break;
            }
            let scope = batch[0].scope.clone();
            let Some(api_key) = self.inner.key.rd_key(&scope, now) else {
                // A credencial pode expirar entre enqueue e drain. Mantém o
                // trabalho ligado à conta; nunca tenta outra chave/conta.
                self.restore_unattempted(batch);
                break;
            };
            // Hash que o play provou quebrado não gasta requisição nem quota.
            let before = batch.len();
            batch.retain(|item| !self.inner.magnet.is_bad(&api_key, &item.hash, now));
            if batch.len() < before {
                self.discard_untried(before - batch.len());
            }
            if batch.is_empty() {
                continue;
            }
            let hashes: Vec<String> = batch.iter().map(|item| item.hash.clone()).collect();
            let report = self.inner.port.warm(&api_key, &hashes).await;
            let attempted = report.attempted.min(batch.len());
            if attempted == 0 {
                // Porta sem tentativa (não deveria): devolve e não gira o laço.
                self.restore_unattempted(batch);
                break;
            }
            processed += attempted;
            self.apply(&report, now, &api_key);
            if report.stopped {
                // O que o gate não sondou volta para a frente: trabalho não se
                // perde por cooldown.
                let mut batch = batch;
                let back = batch.split_off(attempted);
                self.push_front(back);
                break;
            }
            if attempted < batch.len() {
                let mut batch = batch;
                let back = batch.split_off(attempted);
                self.push_front(back);
            }
        }
        self.persist_hour();
        processed
    }

    /// Tira até `limit` hashes respeitando o teto da hora civil.
    fn take_batch(&self, now: i64, limit: usize) -> Vec<WarmItem> {
        let mut state = self.lock();
        let hour = now.div_euclid(HOUR_MS);
        if state.hour != hour {
            state.hour = hour;
            state.per_hour = 0;
        }
        let room = (self.inner.config.max_per_hour - state.per_hour).max(0) as usize;
        if room == 0 {
            if !state.queue.is_empty() {
                state.counters.stopped += 1;
                eprintln!(
                    "[warmer] teto de {} sonda(s)/hora atingido; fila parada",
                    self.inner.config.max_per_hour
                );
            }
            return Vec::new();
        }
        let Some(scope) = state.queue.front().map(|item| item.scope.clone()) else {
            return Vec::new();
        };
        // Uma chamada de rede sempre usa uma credencial só. Itens de outras
        // contas ficam na fila para o próximo drain.
        let same_scope = state
            .queue
            .iter()
            .take_while(|item| item.scope == scope)
            .count();
        let take = self.inner.config.batch.min(limit).min(room).min(same_scope);
        if take == 0 {
            return Vec::new();
        }
        let batch: Vec<WarmItem> = state.queue.drain(..take).collect();
        state.per_hour += batch.len() as i64;
        state.counters.probes += batch.len() as u64;
        drop(state);
        self.persist_queue();
        self.persist_hour();
        batch
    }

    fn push_front(&self, back: Vec<WarmItem>) {
        if back.is_empty() {
            return;
        }
        {
            let mut state = self.lock();
            for item in back.into_iter().rev() {
                state.queue.push_front(item);
            }
        }
        self.persist_queue();
    }

    /// A ausência transitória de chave não conta como sonda nem consome teto.
    fn restore_unattempted(&self, batch: Vec<WarmItem>) {
        if batch.is_empty() {
            return;
        }
        let count = batch.len() as i64;
        {
            let mut state = self.lock();
            for item in batch.into_iter().rev() {
                state.queue.push_front(item);
            }
            state.per_hour = (state.per_hour - count).max(0);
            state.counters.probes = state.counters.probes.saturating_sub(count as u64);
        }
        self.persist_queue();
        self.persist_hour();
    }

    /// Hash `bad`: sai da fila sem gastar quota (o `take_batch` já o debitou).
    fn discard_untried(&self, count: usize) {
        if count == 0 {
            return;
        }
        {
            let mut state = self.lock();
            state.per_hour = (state.per_hour - count as i64).max(0);
            state.counters.probes = state.counters.probes.saturating_sub(count as u64);
        }
        self.persist_hour();
    }

    fn apply(&self, report: &WarmReport, now: i64, api_key: &str) {
        {
            let mut state = self.lock();
            for (_, signal) in &report.signals {
                match signal {
                    WarmSignal::Hit => state.counters.hits += 1,
                    WarmSignal::Miss => state.counters.misses += 1,
                    WarmSignal::Blocked => state.counters.blocked += 1,
                }
            }
            if report.stopped {
                state.counters.stopped += 1;
            }
        }
        for (hash, signal) in &report.signals {
            self.inner.ledger.note(hash, *signal, now);
            if *signal == WarmSignal::Hit {
                self.inner.magnet.mark_alive(api_key, hash, now);
            }
        }
    }

    /// Fire-and-forget do `publish`: cai no freio de tráfego.
    pub(super) fn schedule(&self) {
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let warmer = Self {
            inner: self.inner.clone(),
        };
        tokio::spawn(async move {
            warmer.drain_if_idle().await;
        });
    }

    /// Timer do tick ocioso. Sem runtime (teste/CLI) não sobe nada.
    pub(crate) fn start_ticker(self: &Arc<Self>) {
        if self.inner.ticker_started.swap(true, Ordering::SeqCst) {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            self.inner.ticker_started.store(false, Ordering::SeqCst);
            return;
        }
        let warmer = Arc::clone(self);
        tokio::spawn(async move {
            let interval = Duration::from_millis(warmer.inner.config.interval_ms.max(1_000));
            loop {
                tokio::time::sleep(interval).await;
                warmer.drain_if_idle().await;
            }
        });
    }

    pub(super) fn persist_queue(&self) {
        let items: Vec<WarmItem> = {
            let state = self.lock();
            state.queue.iter().cloned().collect()
        };
        self.inner.queue.save(&items, adom_sources::now_ms());
    }

    pub(super) fn persist_hour(&self) {
        let (hour, count) = {
            let state = self.lock();
            (state.hour, state.per_hour)
        };
        self.inner
            .queue
            .save_hour(hour, count, adom_sources::now_ms());
    }
}
