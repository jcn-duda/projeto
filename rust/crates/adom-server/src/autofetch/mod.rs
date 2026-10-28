//! Worker NATIVO do Chupim no gateway — ciclo completo, DESLIGADO por padrão.
//!
//! Esta leva entrega o ciclo inteiro do worker (cofre, enfileiramento, recheck e
//! laço) com uma trava explícita: sem `AUTOFETCH_WORKER=on` **nada** consome o
//! canal, `phase` continua `"prepared"` e nenhuma fila é escrita. O flip do
//! flag é a leva seguinte — aqui o ciclo só precisa funcionar nos testes.
//!
//! # Peças e donos
//!
//! - [`vault`] — cofre em MEMÓRIA da chave por `adapter:conta`, alimentado pelo
//!   `encoded` da busca (TTL de ~6h, LRU, nunca em KV/disco/log/`Debug`);
//! - [`enqueue`] — lote `autofetch_batch` → cascata + portões + fila
//!   (`autofetch:v3:q:`), ESCRITOR ÚNICO da fila;
//! - [`recheck`] — lote em `autofetch:v3:lot:` (hashes, streaks, adapter,
//!   `createdAt`), passo de recheck, terminal → `dead:` + dreno do próximo,
//!   settle LRU e expiração com prova de posse;
//! - [`serve`] — laço da thread (`current_thread`) sobre canal `mpsc` + timers
//!   lidos dos lotes; o adaptador de debrid entra como `Arc<dyn ...>`;
//! - [`worker`] — config/painel (`autofetch-worker:v1:config`) e o handler.
//!
//! # Credencial de usuário
//!
//! A chave do debrid (`dk`) **nunca** entra no KV nem em log. O contrato é o de
//! `docs/autofetch-worker-credential-gate.md`, opção (2): a fila
//! (`autofetch:v3:q:`), o marker (`autofetch:v3:m:`) e a blacklist
//! (`autofetch:v3:dead:`) não guardam credencial por desenho, e o que o gateway
//! persiste aqui é só `autofetch-worker:v1:config` (`paused` + `intervalMs`). A
//! chave vive no [`vault`] e morre com o processo (restart perde os lotes, como
//! no Node).
//!
//! Rotas (montadas na admin do store, `127.0.0.1:8711`, loopback + token):
//! `GET /autofetch`, `POST /autofetch/config|pause|drain|suppressed-drain`.

mod enqueue;
mod enqueue_drain;
mod enqueue_items;
mod recheck;
mod recheck_expire;
mod routes;
mod serve;
mod vault;
mod worker;

pub(crate) use routes::router as admin_router;
pub(crate) use vault::{shared as shared_vault, Vault};
pub(crate) use worker::{spawn, AutofetchHandle};

/// Prefixo da fila por busca (`autofetch:v3:q:<sha256(searchKey)>`), o mesmo do
/// `queueKey` do Node.
pub(crate) const QUEUE_PREFIX: &str = "autofetch:v3:q:";
/// Prefixo do lote de recheck persistido (`autofetch:v3:lot:<sha256>`).
pub(crate) const LOT_PREFIX: &str = "autofetch:v3:lot:";

/// Chave do lote de recheck. O sufixo é o digest da busca (mesma régua da fila)
/// para o lote nunca carregar texto livre do usuário.
pub(crate) fn lot_key(search_key: &str) -> String {
    format!("{LOT_PREFIX}{}", adom_autofetch::v3::sha256_hex(search_key))
}

/// `AUTOFETCH_WORKER=on` — o ÚNICO jeito de o ciclo consumir o canal. Vazio,
/// `off` ou qualquer outro valor mantém o worker em `prepared`.
pub(crate) fn worker_enabled() -> bool {
    std::env::var("AUTOFETCH_WORKER").map(|value| value == "on") == Ok(true)
}

/// Réguas do ciclo. Os defaults são os MESMOS do Node
/// (`src/config/debrid.ts`), para o flip não mudar comportamento às cegas.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Policy {
    /// `autoFetchMax` — torrents por busca.
    pub(crate) max_attempts: i64,
    /// Profundidade da fila v3 (o `depth` do `writeQueue`).
    pub(crate) queue_depth: usize,
    /// `autoFetchQueueTtl` — TTL da fila persistida.
    pub(crate) queue_ttl_seconds: i64,
    /// `autoFetchTtl` — TTL do lote de recheck e do marker.
    pub(crate) lot_ttl_seconds: i64,
    pub(crate) marker_ttl_seconds: i64,
    /// Janela da blacklist de mortas.
    pub(crate) dead_ttl_seconds: i64,
    /// `autoFetchRecheckMs` — intervalo entre passagens de um lote.
    pub(crate) recheck_interval_ms: i64,
    /// `autoFetchRecheckMax` — passagens antes de entrar em settle.
    pub(crate) recheck_max: i64,
    /// Horizonte do settle (`autoFetchTtl * 1000`).
    pub(crate) settle_horizon_ms: i64,
    /// `autoFetchSettleMaxLots` — teto do LRU de lotes em settle.
    pub(crate) max_settle_lots: usize,
    /// TTL da chave no cofre (mesma régua do autofetch).
    pub(crate) key_ttl_ms: i64,
    /// Teto de contas no cofre (LRU).
    pub(crate) vault_cap: usize,
}

impl Policy {
    pub(crate) fn from_env() -> Self {
        let ttl = env_num("DEBRID_AUTO_FETCH_TTL", 6 * 3_600).max(1);
        Self {
            max_attempts: env_num("DEBRID_AUTO_FETCH_MAX", 3).clamp(1, 12),
            queue_depth: env_num("DEBRID_AUTO_FETCH_QUEUE_DEPTH", 12).clamp(1, 64) as usize,
            queue_ttl_seconds: env_num("DEBRID_AUTO_FETCH_QUEUE_TTL", 86_400).max(1),
            lot_ttl_seconds: ttl,
            marker_ttl_seconds: ttl,
            dead_ttl_seconds: 24 * 3_600,
            recheck_interval_ms: env_num("DEBRID_AUTO_FETCH_RECHECK_MS", 120_000).max(0),
            recheck_max: env_num("DEBRID_AUTO_FETCH_RECHECK_MAX", 3).max(0),
            settle_horizon_ms: ttl * 1_000,
            max_settle_lots: env_num("DEBRID_AUTO_FETCH_SETTLE_MAX_LOTS", 50).max(1) as usize,
            key_ttl_ms: ttl * 1_000,
            vault_cap: env_num("DEBRID_AUTO_FETCH_VAULT_MAX", 64).clamp(1, 1_024) as usize,
        }
    }

    /// Réguas fixas para teste: nenhuma env do processo entra na conta.
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self {
            max_attempts: 3,
            queue_depth: 12,
            queue_ttl_seconds: 86_400,
            lot_ttl_seconds: 21_600,
            marker_ttl_seconds: 21_600,
            dead_ttl_seconds: 86_400,
            recheck_interval_ms: 120_000,
            recheck_max: 3,
            settle_horizon_ms: 21_600_000,
            max_settle_lots: 50,
            key_ttl_ms: 21_600_000,
            vault_cap: 4,
        }
    }
}

fn env_num(key: &str, default: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod fakes;
#[cfg(test)]
mod tests;
