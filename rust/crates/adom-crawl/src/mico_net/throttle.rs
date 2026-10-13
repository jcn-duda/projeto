//! Throttle do Mico Leão Dublado: serialização de chamadas HTTP com gap mínimo
//! e respeito a `Retry-After` de respostas 429.
//!
//! Porte do módulo TS `src/providers/crawl-sites/mico-shared.ts:99-142`.

use std::sync::Mutex as StdMutex;
use std::time::Instant;

use tokio::sync::Mutex as TokioMutex;
use tokio::time::{sleep, Duration};

/// Estado mutável do throttle, protegido por `std::sync::Mutex` (seções críticas
/// curtas — apenas leitura/escrita de `Instant`).
struct ThrottleState {
    /// Instante da última chamada registrada (para calcular o gap).
    last_call_at: Option<Instant>,
    /// Instante a partir do qual a próxima chamada é permitida (Retry-After).
    not_before: Option<Instant>,
}

/// Throttle serializado para chamadas ao Mico.
///
/// Garante:
/// - Intervalo mínimo entre chamadas (`min_gap_ms`).
/// - Respeito ao `Retry-After` de respostas 429 (`not_before`).
/// - Serialização via `chain` (duas chamadas concorrentes → segunda espera a primeira).
pub struct MicoThrottle {
    /// Intervalo mínimo entre chamadas, em milissegundos.
    min_gap_ms: u64,
    /// Estado mutável (last_call_at, not_before).
    state: StdMutex<ThrottleState>,
    /// Mutex que serializa as chamadas (uma por vez na cadeia).
    chain: TokioMutex<()>,
}

impl MicoThrottle {
    /// Cria um novo throttle com o intervalo mínimo especificado.
    pub fn new(min_gap_ms: u64) -> Self {
        Self {
            min_gap_ms,
            state: StdMutex::new(ThrottleState {
                last_call_at: None,
                not_before: None,
            }),
            chain: TokioMutex::new(()),
        }
    }

    /// Espera o intervalo mínimo e/ou o `Retry-After` antes de permitir a chamada.
    ///
    /// Fluxo:
    /// 1. Adquire o lock da cadeia (serializa chamadas concorrentes).
    /// 2. Calcula o tempo de espera com base no gap e no Retry-After.
    /// 3. Sleep pelo maior dos dois valores.
    /// 4. Retorna — o caller faz o fetch e depois chama `record_call()`.
    pub async fn wait(&self) {
        // Serializa: só uma chamada por vez na cadeia.
        let _guard = self.chain.lock().await;

        let now = Instant::now();

        // Calcula quanto esperar pelo gap mínimo desde a última chamada.
        let wait_gap = {
            let state = self.state.lock().unwrap();
            state
                .last_call_at
                .map(|last| {
                    let elapsed = now.duration_since(last).as_millis() as u64;
                    self.min_gap_ms.saturating_sub(elapsed)
                })
                .unwrap_or(0)
        };

        // Calcula quanto esperar pelo Retry-After (429).
        let wait_retry = {
            let state = self.state.lock().unwrap();
            state
                .not_before
                .map(|nb| {
                    if nb > now {
                        nb.duration_since(now).as_millis() as u64
                    } else {
                        0
                    }
                })
                .unwrap_or(0)
        };

        let delay_ms = wait_gap.max(wait_retry);
        if delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
        }

        // O lock da cadeia é liberado aqui (drop do _guard).
        // O caller faz o fetch e chama record_call() depois.
    }

    /// Registra que uma chamada foi concluída agora (atualiza `last_call_at`).
    ///
    /// Deve ser chamado pelo client após o fetch bem-sucedido, para que o
    /// gap mínimo seja medido a partir deste instante na próxima chamada.
    pub fn record_call(&self) {
        let mut state = self.state.lock().unwrap();
        state.last_call_at = Some(Instant::now());
    }

    /// Honra o `Retry-After` de um 429: adia a próxima chamada.
    ///
    /// `retry_after_ms` é o valor em milissegundos do header `Retry-After`.
    /// O `not_before` é o maior valor entre o atual e `now + retry_after_ms`,
    /// para não encurtar um adiamento anterior.
    pub fn honor_retry_after(&self, retry_after_ms: u64) {
        let now = Instant::now();
        let deadline = now + Duration::from_millis(retry_after_ms);
        let mut state = self.state.lock().unwrap();
        // Só atualiza se o novo deadline for mais tarde que o atual.
        let should_update = state
            .not_before
            .map(|nb| deadline > nb)
            .unwrap_or(true);
        if should_update {
            state.not_before = Some(deadline);
        }
    }

    /// Reseta o estado do throttle (apenas para testes).
    #[doc(hidden)]
    pub fn _reset_for_test(&self) {
        let mut state = self.state.lock().unwrap();
        state.last_call_at = None;
        state.not_before = None;
    }
}
