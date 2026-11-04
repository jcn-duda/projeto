//! Freio da cadeia do botão do Vaca (`processar` → `t.co` → `relay` →
//! `enc1` → artigo → `enc2`). O Jackett resolve TODOS os botões de uma busca
//! ao mesmo tempo (série: um por episódio) e cada cadeia são ~6 pedidos ao
//! mesmo host: 9 botões em rajada levam o site a responder HTTP 429 a quase
//! todos (medido em 2026-11-04, Foundation: 4/9 e depois 9/9 com 429; um botão
//! sozinho, segundos depois, passa). O 502 que sai daqui o Jackett ainda
//! repete, o que só aumenta a rajada. Por isso: poucas cadeias por vez no
//! processo e, no 429, uma espera curta e UMA nova tentativa — sem laço.

use std::future::Future;
use std::sync::LazyLock;
use std::time::Duration;

use tokio::sync::Semaphore;

/// `VACA_CHAIN_CONCURRENCY` (default 2, mínimo 1): cadeias simultâneas.
fn concurrency_from_env() -> usize {
    std::env::var("VACA_CHAIN_CONCURRENCY")
        .ok()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(2)
        .max(1)
}

/// `VACA_CHAIN_RETRY_MS` (default 2000): espera antes de repetir após 429;
/// 0 desliga a nova tentativa.
fn retry_delay_from_env() -> Duration {
    let ms = std::env::var("VACA_CHAIN_RETRY_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(2_000);
    Duration::from_millis(ms)
}

static CHAIN_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(concurrency_from_env()));
static RETRY_DELAY: LazyLock<Duration> = LazyLock::new(retry_delay_from_env);

/// O erro do protetor para status HTTP é `HTTP <n>` (`ProtectorError`).
fn is_rate_limited(err: &str) -> bool {
    err.trim() == "HTTP 429"
}

/// Roda a cadeia sob o freio do processo.
pub async fn throttled<F, Fut>(run: F) -> Result<String, String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    run_limited(&CHAIN_SEMAPHORE, *RETRY_DELAY, run).await
}

/// Núcleo testável: a vaga fica presa durante a espera e a nova tentativa —
/// soltá-la deixaria outra cadeia entrar justo quando o site pediu calma.
pub(crate) async fn run_limited<F, Fut>(
    semaphore: &Semaphore,
    retry_delay: Duration,
    run: F,
) -> Result<String, String>
where
    F: Fn() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let _permit = semaphore
        .acquire()
        .await
        .map_err(|_| "vaca_chain_closed".to_string())?;
    match run().await {
        Err(e) if is_rate_limited(&e) && !retry_delay.is_zero() => {
            tokio::time::sleep(retry_delay).await;
            run().await
        }
        other => other,
    }
}

#[cfg(test)]
#[path = "vaca_chain_tests.rs"]
mod tests;
