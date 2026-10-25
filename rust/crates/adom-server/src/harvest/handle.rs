//! Métodos administrativos de [`HarvestHandle`]. Extraídos de `mod.rs` para
//! caber no teto de 400 linhas; rotas e assinaturas públicas não mudam.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use adom_harvest::{EnqueueOutcome, EnqueueReason, HarvestRequest};
use tokio::sync::oneshot;

use super::enqueue::enqueue_with_dedupe;
use super::live::LiveOverlay;
use super::{HarvestConfig, HarvestStatus, Inner};

/// Handle clonável: o worker roda mesmo se todas as cópias caírem (a thread
/// tem o `Arc` dela; este é o lado da API).
#[derive(Clone)]
pub struct HarvestHandle {
    pub(crate) inner: Arc<Inner>,
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
    ///
    /// Aplica a última foto ANTES de evictar — sem consultar o índice aqui.
    pub async fn enqueue(&self, req: HarvestRequest) -> EnqueueOutcome {
        let now = adom_sources::now_ms();
        let snap = self.inner.snapshot();
        let mut queue = self.inner.queue.lock().await;
        let outcome = enqueue_with_dedupe(&mut queue, &self.inner.store, req, now, Some(&snap));
        // Capacity evicta a cauda e recusa o novo: sem persistir, o L2
        // devolve as removidas no próximo load.
        if outcome.accepted || outcome.reason == EnqueueReason::Capacity {
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
        if let Some(intent) = queue.inflight().pending_for_imdb(imdb) {
            queued = true;
            probe |= intent.br_probe;
        }
        (queued, probe)
    }
}

#[cfg(test)]
#[path = "handle_tests.rs"]
mod tests;
