//! Persistência do warmer RD: fila/quota nas chaves do Node e intent durável.
//!
//! # Chaves (sem migração)
//!
//! - `rdq:v1:wq`: array `[{hash, score, enqueuedAt, scope?}]`. O Node lê o
//!   MESMO array e ignora `scope`; o campo extra é a única diferença e existe
//!   para o aquecimento não misturar contas. Item carregado do Node (sem
//!   `scope`) adota o escopo do operador no boot.
//! - `rdq:v1:hour`: `{hour, count}` com TTL até o fim da hora + 60 s, como o
//!   `noteQueries` do Node. Restart na mesma hora não zera o teto.
//! - `rdq:v1:uncertain:<conta>:<hash>`: intent `{kind, created_at_ms}`, o
//!   MESMO formato de `adom_debrid::realdebrid_autofetch`. A escrita entra
//!   ANTES do HTTP e só sai com prova; restart no meio de um `addMagnet` não
//!   vira reenvio cego.
//! - `rdq:v1:owned:<conta>:<hash>`: `{id}` da transferência criada pelo
//!   warmer. O worker do Chupim usa o marker de aceite como prova de posse; o
//!   warmer cria transferências efêmeras e remove logo em seguida, então a
//!   posse fica nesta chave própria — sem contaminar `autofetch:v3:m:`.
//!
//! O `NativeKv` é o mesmo `data/cache.db` do Node e do worker; nenhuma chave
//! daqui carrega a API key (só o `accountScope`, o `sha256` dela).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use adom_core::{normalize_hash, prefix};
use adom_debrid::realdebrid_autofetch::{uncertain_key, RdUncertainIntent, RdUncertainStore};
use adom_index::kv::KvWrite;
use adom_index::NativeKv;
use serde_json::{json, Map, Value};

const HOUR_MS: i64 = 3_600_000;
const QUEUE_TTL_SECONDS: i64 = 30 * 24 * 3_600;
const INTENT_TTL_SECONDS: i64 = 6 * 3_600;
const OWNED_TTL_SECONDS: i64 = 6 * 3_600;
/// Quarentena da fila em RAM (sem KV): o worker durável usa o TTL do KV.
const RAM_INTENT_TTL_MS: i64 = 300_000;

pub(crate) fn queue_key() -> String {
    format!("{}wq", prefix("rdq"))
}

pub(crate) fn hour_key() -> String {
    format!("{}hour", prefix("rdq"))
}

fn owned_key(account: &str, hash: &str) -> String {
    format!(
        "{}owned:{account}:{}",
        prefix("rdq"),
        hash.to_ascii_lowercase()
    )
}

// ---------------------------------------------------------------------------
// Fila e balde horário
// ---------------------------------------------------------------------------

/// Item da fila. `scope` vazio = entrada herdada do Node (sem conta): o
/// `WarmKey` resolve pelo escopo do operador no momento da drenagem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WarmItem {
    pub(crate) hash: String,
    pub(crate) scope: String,
    pub(crate) score: i64,
    pub(crate) enqueued_at: i64,
}

/// Porta da fila/quota. O `Warmer` é o dono em RAM; esta porta só persiste e
/// reidrata. Sem KV, [`RamQueue`] mantém o comportamento anterior.
pub(crate) trait WarmQueue: Send + Sync {
    fn load(&self, now_ms: i64, queue_max: usize, default_scope: &str) -> Vec<WarmItem>;
    fn save(&self, items: &[WarmItem], now_ms: i64);
    fn load_hour(&self, now_ms: i64) -> (i64, i64);
    fn save_hour(&self, hour: i64, count: i64, now_ms: i64);
}

/// Fila volátil (teste ou `cache.db` indisponível): nada persiste.
#[allow(dead_code)]
pub(crate) struct RamQueue;

impl WarmQueue for RamQueue {
    fn load(&self, _now_ms: i64, _queue_max: usize, _default_scope: &str) -> Vec<WarmItem> {
        Vec::new()
    }

    fn save(&self, _items: &[WarmItem], _now_ms: i64) {}

    fn load_hour(&self, now_ms: i64) -> (i64, i64) {
        (now_ms.div_euclid(HOUR_MS), 0)
    }

    fn save_hour(&self, _hour: i64, _count: i64, _now_ms: i64) {}
}

/// Fila durável no `NativeKv`. Sem KV, a fila continua em RAM no `Warmer` e
/// esta porta vira no-op (o processo não perde o trabalho atual, só o restart).
pub(crate) struct NativeQueue {
    kv: Option<Arc<NativeKv>>,
}

impl NativeQueue {
    pub(crate) fn new(kv: Option<Arc<NativeKv>>) -> Self {
        Self { kv }
    }
}

impl WarmQueue for NativeQueue {
    fn load(&self, now_ms: i64, queue_max: usize, default_scope: &str) -> Vec<WarmItem> {
        let Some(kv) = self.kv.as_deref() else {
            return Vec::new();
        };
        let Some(Value::Array(rows)) = kv.get_json(&queue_key(), now_ms).ok().flatten() else {
            return Vec::new();
        };
        let mut items: Vec<WarmItem> = Vec::new();
        for row in rows {
            let hash = normalize_hash(row.get("hash").and_then(Value::as_str).unwrap_or(""));
            if hash.is_empty() {
                continue;
            }
            let scope = row
                .get("scope")
                .and_then(Value::as_str)
                .filter(|scope| !scope.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| default_scope.to_string());
            items.push(WarmItem {
                hash,
                scope,
                score: row.get("score").and_then(Value::as_i64).unwrap_or(0),
                enqueued_at: row
                    .get("enqueuedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(now_ms),
            });
        }
        // A ordem do Node: score desc, depois chegada. O desempate é estável,
        // então a fila que o Node deixou é reidratada na mesma ordem.
        items.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(a.enqueued_at.cmp(&b.enqueued_at))
        });
        items.truncate(queue_max);
        items
    }

    fn save(&self, items: &[WarmItem], now_ms: i64) {
        let Some(kv) = self.kv.as_deref() else {
            return;
        };
        if items.is_empty() {
            let _ = kv.forget(&queue_key());
            return;
        }
        let rows: Vec<Value> = items
            .iter()
            .map(|item| {
                let mut row = Map::new();
                row.insert("hash".into(), json!(item.hash));
                row.insert("score".into(), json!(item.score));
                row.insert("enqueuedAt".into(), json!(item.enqueued_at));
                // O Node ignora o campo; só o Rust o lê para não misturar contas.
                if !item.scope.is_empty() {
                    row.insert("scope".into(), json!(item.scope));
                }
                Value::Object(row)
            })
            .collect();
        if let Err(err) = kv.put_json(&queue_key(), &Value::Array(rows), QUEUE_TTL_SECONDS, now_ms)
        {
            eprintln!("[warmer] fila rdq:v1:wq não persistiu: {err}");
        }
    }

    fn load_hour(&self, now_ms: i64) -> (i64, i64) {
        let hour = now_ms.div_euclid(HOUR_MS);
        let Some(kv) = self.kv.as_deref() else {
            return (hour, 0);
        };
        let Some(value) = kv.get_json(&hour_key(), now_ms).ok().flatten() else {
            return (hour, 0);
        };
        let stored = value.get("hour").and_then(Value::as_i64);
        let count = value
            .get("count")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        // Hora velha no KV não vira teto gasto na hora nova.
        if stored == Some(hour) {
            (hour, count)
        } else {
            (hour, 0)
        }
    }

    fn save_hour(&self, hour: i64, count: i64, now_ms: i64) {
        let Some(kv) = self.kv.as_deref() else {
            return;
        };
        // Resto da hora + 60 s de folga, com piso 60 — a mesma régua do Node.
        let ttl = (((hour + 1) * HOUR_MS - now_ms) / 1_000 + 60).max(60);
        let value = json!({ "hour": hour, "count": count.max(0) });
        if let Err(err) = kv.put_json(&hour_key(), &value, ttl, now_ms) {
            eprintln!("[warmer] quota rdq:v1:hour não persistiu: {err}");
        }
    }
}

// ---------------------------------------------------------------------------
// Intent + posse
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StoreState {
    intents: HashMap<String, i64>,
    owned: HashMap<String, String>,
}

/// Quarentena em RAM: fallback quando o `cache.db` não abre. Mesmo contrato do
/// `RdUncertainStore`, com TTL curto porque a fila também morre com o processo.
#[derive(Default)]
pub(crate) struct WarmStore {
    inner: Mutex<StoreState>,
}

impl WarmStore {
    fn lock(&self) -> MutexGuard<'_, StoreState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn own(&self, account: &str, hash: &str, id: &str) {
        self.lock()
            .owned
            .insert(uncertain_key(account, hash), id.to_string());
    }

    pub(crate) fn settle(&self, account: &str, hash: &str) {
        self.lock().intents.remove(&uncertain_key(account, hash));
    }

    pub(crate) fn release(&self, account: &str, hash: &str) {
        let key = uncertain_key(account, hash);
        let mut state = self.lock();
        state.intents.remove(&key);
        state.owned.remove(&key);
    }
}

impl RdUncertainStore for WarmStore {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        let now = adom_sources::now_ms();
        let mut state = self.lock();
        match state.intents.get(key) {
            Some(created) if now - created < RAM_INTENT_TTL_MS => Ok(true),
            Some(_) => {
                state.intents.remove(key);
                Ok(false)
            }
            None => Ok(false),
        }
    }

    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String> {
        Ok(self
            .lock()
            .intents
            .insert(key.to_string(), intent.created_at_ms)
            .is_none())
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        self.lock().intents.remove(key);
        Ok(())
    }

    fn owns_transfer(&self, account: &str, hash: &str, id: &str) -> Result<bool, String> {
        Ok(self
            .lock()
            .owned
            .get(&uncertain_key(account, hash))
            .is_some_and(|known| known == id))
    }
}

/// Intent/posse duráveis sobre o `NativeKv` (produção) ou em RAM (fallback).
pub(crate) struct WarmIntentStore {
    kv: Option<Arc<NativeKv>>,
    ram: WarmStore,
}

impl WarmIntentStore {
    pub(crate) fn new(kv: Option<Arc<NativeKv>>) -> Self {
        Self {
            kv,
            ram: WarmStore::default(),
        }
    }

    /// Só teste/fallback: nenhum KV disponível.
    #[allow(dead_code)]
    pub(crate) fn memory() -> Self {
        Self::new(None)
    }

    pub(crate) fn own(&self, account: &str, hash: &str, id: &str) {
        let Some(kv) = self.kv.as_deref() else {
            self.ram.own(account, hash, id);
            return;
        };
        let value = json!({ "id": id });
        if let Err(err) = kv.put_json(
            &owned_key(account, hash),
            &value,
            OWNED_TTL_SECONDS,
            adom_sources::now_ms(),
        ) {
            eprintln!("[warmer] posse rdq:v1:owned não gravou: {err}");
        }
    }

    /// O `enqueue` devolveu id: o intent daquela escrita está resolvido, mas a
    /// posse fica (o `remove` seguinte exige as duas coisas ao contrário).
    pub(crate) fn settle(&self, account: &str, hash: &str) {
        if self.kv.is_none() {
            self.ram.settle(account, hash);
            return;
        }
        if let Some(kv) = self.kv.as_deref() {
            let _ = kv.forget(&uncertain_key(account, hash));
        }
    }

    /// Libera intent e posse de um hash já resolvido.
    pub(crate) fn release(&self, account: &str, hash: &str) {
        let Some(kv) = self.kv.as_deref() else {
            self.ram.release(account, hash);
            return;
        };
        let _ = kv.forget(&uncertain_key(account, hash));
        let _ = kv.forget(&owned_key(account, hash));
    }
}

impl RdUncertainStore for WarmIntentStore {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        let Some(kv) = self.kv.as_deref() else {
            return self.ram.has_intent(key);
        };
        Ok(kv.get_json(key, adom_sources::now_ms())?.is_some())
    }

    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String> {
        let Some(kv) = self.kv.as_deref() else {
            return self.ram.put_intent_if_absent(key, intent);
        };
        let value = serde_json::to_value(intent).map_err(|err| err.to_string())?;
        let now = adom_sources::now_ms();
        kv.put_many_json_and_forget(
            &[KvWrite {
                key,
                value: &value,
                ttl_seconds: INTENT_TTL_SECONDS,
                now_ms: now,
                only_if_absent: true,
            }],
            &[],
        )?;
        // O bool é "EU gravei": a linha vigente é comparada com a pretendida.
        Ok(kv.get_json(key, now)?.as_ref() == Some(&value))
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        let Some(kv) = self.kv.as_deref() else {
            return self.ram.clear_intent(key);
        };
        kv.forget(key).map(|_| ())
    }

    fn owns_transfer(&self, account: &str, hash: &str, id: &str) -> Result<bool, String> {
        let Some(kv) = self.kv.as_deref() else {
            return self.ram.owns_transfer(account, hash, id);
        };
        if account.is_empty() || hash.is_empty() || id.is_empty() {
            return Ok(false);
        }
        let Some(value) = kv.get_json(&owned_key(account, hash), adom_sources::now_ms())? else {
            return Ok(false);
        };
        Ok(value
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|known| known == id))
    }
}
