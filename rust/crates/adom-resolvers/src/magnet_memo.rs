//! Memória do magnet por botão. O Jackett resolve TODOS os botões de cada
//! busca, e sem memória cada busca da mesma obra refaz todas as cadeias de
//! protetor — no Vaca são ~6 pedidos por botão e 9 botões juntos tomam HTTP
//! 429 do site (medido em 2026-11-04). O botão (URL do protetor) é estável
//! entre buscas — o `h` que o Jackett grava na busca acha o mesmo botão depois
//! —, então só a 1ª busca de uma obra paga a cadeia. Só o SUCESSO é guardado:
//! falha (429, timeout) tem que poder tentar de novo na busca seguinte.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Teto de entradas: a mais velha sai primeiro.
const MAX_ENTRIES: usize = 4_000;

/// `RESOLVER_MAGNET_TTL_MS` (default 12 h; 0 desliga a memória).
fn ttl_from_env() -> Duration {
    let ms = std::env::var("RESOLVER_MAGNET_TTL_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(12 * 60 * 60 * 1000);
    Duration::from_millis(ms)
}

static TTL: LazyLock<Duration> = LazyLock::new(ttl_from_env);
static MEMO: LazyLock<Memo> = LazyLock::new(|| Memo::new(MAX_ENTRIES));

pub(crate) struct Memo {
    cap: usize,
    map: Mutex<HashMap<String, (String, Instant)>>,
}

impl Memo {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            map: Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, key: &str, ttl: Duration) -> Option<String> {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        match map.get(key) {
            Some((magnet, at)) if at.elapsed() < ttl => Some(magnet.clone()),
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    fn put(&self, key: String, magnet: String) {
        let mut map = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if map.len() >= self.cap && !map.contains_key(&key) {
            let oldest = map
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                map.remove(&k);
            }
        }
        map.insert(key, (magnet, Instant::now()));
    }

    /// Núcleo testável de [`remembered`].
    pub(crate) async fn through<F, Fut>(
        &self,
        ttl: Duration,
        site: &str,
        url: &str,
        run: F,
    ) -> Result<String, String>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<String, String>>,
    {
        // Magnet cru não tem cadeia a poupar; TTL zero é o desligamento.
        if ttl.is_zero() || url.trim_start().to_ascii_lowercase().starts_with("magnet:") {
            return run().await;
        }
        let key = format!("{site}\u{1f}{url}");
        if let Some(hit) = self.get(&key, ttl) {
            return Ok(hit);
        }
        let out = run().await;
        if let Ok(magnet) = &out {
            self.put(key, magnet.clone());
        }
        out
    }
}

/// Magnet do botão `url` do site: da memória, ou da cadeia (e guarda o sucesso).
pub async fn remembered<F, Fut>(site: &str, url: &str, run: F) -> Result<String, String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    MEMO.through(*TTL, site, url, run).await
}

#[cfg(test)]
#[path = "magnet_memo_tests.rs"]
mod tests;
