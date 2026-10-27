//! Registros v3 de remoções represadas. Apenas estado: não executa remoções.
//!
//! `note` e `retry` preservam o TTL restante, como o Node; o chamador deve
//! serializar escritores até a virada conjunta do worker e do dreno.
//! Antes de ligar o dreno, conciliar a ordem das chaves com o L1 do Node e
//! decidir a semântica do id em `retry`, que aqui relê o valor atual.
//! A listagem é ordenada pela chave do SQLite, não pela ordem do L1 do Node;
//! o retry usa o id atual, enquanto o Node usa o id lido no início do drain.
//! Resolver esses contratos antes de ligar a execução destrutiva.

use adom_store::kv::NativeKv;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::NAMESPACE_V3;

const BASE_MS: i64 = 5 * 60_000;
const CAP_MS: i64 = 6 * 3_600_000;
const GIVE_UP_AFTER: i64 = 5;

pub fn suppressed_key(adapter: &str, account: &str, hash: &str) -> String {
    format!(
        "{NAMESPACE_V3}:sup:{adapter}:{account}:{}",
        hash.to_lowercase()
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suppressed {
    pub id: String,
    pub at: i64,
    pub fails: i64,
    pub next_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuppressedRetry {
    Missing,
    Scheduled,
    GivenUp,
}

pub struct SuppressedV3<'a> {
    kv: &'a NativeKv,
}

impl<'a> SuppressedV3<'a> {
    pub fn new(kv: &'a NativeKv) -> Self {
        Self { kv }
    }

    /// Registro legado `{id, at}` nasce sem falhas e é elegível imediatamente.
    pub fn read(
        &self,
        adapter: &str,
        account: &str,
        hash: &str,
        now: i64,
    ) -> Result<Option<Suppressed>, String> {
        let Some(value) = self
            .kv
            .get_json(&suppressed_key(adapter, account, hash), now)?
        else {
            return Ok(None);
        };
        let Some(id) = value
            .get("id")
            .and_then(value_as_id)
            .filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        let number = |name: &str| value.get(name).and_then(Value::as_f64).unwrap_or(0.0) as i64;
        Ok(Some(Suppressed {
            id,
            at: number("at"),
            fails: number("fails").max(0),
            next_at: number("nextAt"),
        }))
    }

    /// Nova observação reseta o backoff, sem renovar um TTL que já existia.
    pub fn note(
        &self,
        adapter: &str,
        account: &str,
        hash: &str,
        id: &str,
        ttl: i64,
        now: i64,
    ) -> Result<bool, String> {
        if adapter.is_empty() || account.is_empty() || hash.is_empty() || id.is_empty() {
            return Ok(false);
        }
        let key = suppressed_key(adapter, account, hash);
        let remaining = self
            .kv
            .remaining_seconds(&key, now)?
            .filter(|n| *n > 0)
            .unwrap_or(ttl);
        let record = Suppressed {
            id: id.into(),
            at: now,
            fails: 0,
            next_at: 0,
        };
        self.kv.put_json(
            &key,
            &serde_json::to_value(record).map_err(|e| e.to_string())?,
            remaining,
            now,
        )?;
        Ok(true)
    }

    /// Uma falha adia 5, 10, 20 e 40 minutos; a quinta aposenta o registro.
    /// Se ele já sumiu, não o recria.
    pub fn retry(
        &self,
        adapter: &str,
        account: &str,
        hash: &str,
        ttl: i64,
        now: i64,
    ) -> Result<SuppressedRetry, String> {
        let Some(mut record) = self.read(adapter, account, hash, now)? else {
            return Ok(SuppressedRetry::Missing);
        };
        let key = suppressed_key(adapter, account, hash);
        record.fails = record.fails.saturating_add(1);
        if record.fails >= GIVE_UP_AFTER {
            self.kv.forget(&key)?;
            return Ok(SuppressedRetry::GivenUp);
        }
        if record.at == 0 {
            record.at = now;
        }
        record.next_at = now.saturating_add((BASE_MS * (1_i64 << (record.fails - 1))).min(CAP_MS));
        let remaining = self
            .kv
            .remaining_seconds(&key, now)?
            .filter(|n| *n > 0)
            .unwrap_or(ttl);
        self.kv.put_json(
            &key,
            &serde_json::to_value(record).map_err(|e| e.to_string())?,
            remaining,
            now,
        )?;
        Ok(SuppressedRetry::Scheduled)
    }

    pub fn forget(&self, adapter: &str, account: &str, hash: &str) -> Result<bool, String> {
        self.kv.forget(&suppressed_key(adapter, account, hash))
    }

    /// Lista só a conta solicitada; `eligible_only` respeita o prazo de retry.
    pub fn list(
        &self,
        adapter: &str,
        account: &str,
        now: i64,
        eligible_only: bool,
    ) -> Result<Vec<(String, Suppressed)>, String> {
        let prefix = format!("{NAMESPACE_V3}:sup:{adapter}:{account}:");
        let mut out = Vec::new();
        for key in self.kv.keys_matching(&prefix, now)? {
            let hash = &key[prefix.len()..];
            if let Some(record) = self.read(adapter, account, hash, now)? {
                if !eligible_only || record.next_at <= now {
                    out.push((hash.into(), record));
                }
            }
        }
        Ok(out)
    }
}

fn value_as_id(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}
