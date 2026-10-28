//! `RdUncertainStore` DURÁVEL do worker nativo sobre o `NativeKv`.
//!
//! # Por que durável
//!
//! O Real-Debrid só pode escrever com o intent (`rdq:v1:uncertain:<conta>:<hash>`)
//! gravado ANTES do HTTP: restart no meio de um `addMagnet` não pode virar
//! reenvio cego. Em RAM o intent morre com o processo — é o que o warmer faz,
//! porque a fila dele também é volátil. O worker grava no `cache.db`, ao lado da
//! fila (`autofetch:v3:q:`), do lote de recheck e do marker de aceite.
//!
//! # As três provas
//!
//! 1. [`has_intent`](RdUncertainStore::has_intent) = linha viva **e** sem
//!    marker-com-id. O worker prova o aceite gravando o marker com o id do
//!    transfer (`enqueue.rs`), e o caminho nativo não chama
//!    `acknowledge_marker`: sem esta leitura, todo hash já aceito ficaria em
//!    quarentena para sempre e o `remove` nunca passaria.
//! 2. [`put_intent_if_absent`](RdUncertainStore::put_intent_if_absent) usa
//!    `INSERT OR IGNORE` dentro de transação: o primeiro gravador ganha e o
//!    segundo NÃO move o carimbo do primeiro.
//! 3. [`owns_transfer`](RdUncertainStore::owns_transfer) compara o id com o do
//!    marker. Marker legado (`1`, aceite sem id) não prova posse nenhuma.
//!
//! Nada aqui lê ou grava a chave do usuário: as chaves envolvidas são o
//! `accountScope` (`sha256` da chave) e o infoHash.

use std::sync::Arc;

use adom_debrid::realdebrid_autofetch::{RdUncertainIntent, RdUncertainStore};
use adom_debrid::RdLedgerPeek;
use adom_index::kv::KvWrite;
use adom_index::NativeKv;
use serde_json::Value;

/// Prefixo das chaves de intent. O MESMO texto de
/// `adom_debrid::realdebrid_autofetch::uncertain_key` (privado lá); o teste
/// `prefixo_bate_com_o_crate` prende os dois, para uma mudança de um lado só
/// não criar um namespace paralelo de quarentena.
pub(crate) const UNCERTAIN_PREFIX: &str = "rdq:v1:uncertain:";

/// Adapter do marker de aceite — a prova durável de posse do worker.
const ADAPTER: &str = "realdebrid";

/// TTL do intent: a janela do autofetch (6 h, o default de
/// `DEBRID_AUTO_FETCH_TTL`). Depois disso a linha expira na leitura do KV, o
/// que é a válvula de escape de um processo que morreu no meio da escrita.
const INTENT_TTL_SECONDS: i64 = 6 * 3_600;

/// Intent durável sobre o KV JSON compartilhado com o Node.
pub(crate) struct RdKvStore {
    kv: Arc<NativeKv>,
}

impl RdKvStore {
    pub(crate) fn new(kv: Arc<NativeKv>) -> Self {
        Self { kv }
    }

    /// Id provado pelo marker do worker (`{"id": "<transfer>"}`). Valor `1`
    /// (aceite antigo, sem id) devolve `None`.
    fn marker_id(&self, account: &str, hash: &str) -> Result<Option<String>, String> {
        let key = adom_autofetch::v3::marker_key(ADAPTER, account, hash);
        let Some(value) = self.kv.get_json(&key, adom_sources::now_ms())? else {
            return Ok(None);
        };
        Ok(value
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string))
    }
}

/// `(conta, hash)` de uma chave de intent; `None` = fora do formato.
fn split_key(key: &str) -> Option<(&str, &str)> {
    let rest = key.strip_prefix(UNCERTAIN_PREFIX)?;
    let (account, hash) = rest.split_once(':')?;
    (!account.is_empty() && !hash.is_empty()).then_some((account, hash))
}

impl RdUncertainStore for RdKvStore {
    fn has_intent(&self, key: &str) -> Result<bool, String> {
        if self.kv.get_json(key, adom_sources::now_ms())?.is_none() {
            return Ok(false);
        }
        // Marker com id = aceite provado. O intent cumpriu o papel de barrar o
        // reenvio; soltá-lo daqui é a reconciliação do caminho nativo.
        let Some((account, hash)) = split_key(key) else {
            return Ok(true);
        };
        Ok(self.marker_id(account, hash)?.is_none())
    }

    fn put_intent_if_absent(&self, key: &str, intent: &RdUncertainIntent) -> Result<bool, String> {
        let value = serde_json::to_value(intent).map_err(|err| err.to_string())?;
        let now = adom_sources::now_ms();
        self.kv.put_many_json_and_forget(
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
        Ok(self.kv.get_json(key, now)?.as_ref() == Some(&value))
    }

    fn clear_intent(&self, key: &str) -> Result<(), String> {
        self.kv.forget(key).map(|_| ())
    }

    fn owns_transfer(&self, account_scope: &str, hash: &str, id: &str) -> Result<bool, String> {
        if account_scope.is_empty() || hash.is_empty() || id.is_empty() {
            return Ok(false);
        }
        Ok(self
            .marker_id(account_scope, hash)?
            .is_some_and(|owned| owned == id))
    }
}

/// `DEBRID_RD_LEDGER` — o MESMO kill-switch do warmer (default LIGADO).
pub(crate) fn ledger_enabled() -> bool {
    std::env::var("DEBRID_RD_LEDGER")
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

/// Peek do ledger `rdc:v2` para o `check` do RD. `None` = sem prova para aquele
/// hash: a lista não fecha `complete` e o lote sai recusado com
/// `unknown-cache` — é o preço de nunca inventar ⚡.
pub(crate) fn ledger_peek(kv: Arc<NativeKv>, enabled: bool) -> Option<RdLedgerPeek> {
    if !enabled {
        return None;
    }
    Some(Arc::new(move |hash: &str| {
        let value = kv
            .get_json(&adom_core::ledger_key(hash), adom_sources::now_ms())
            .ok()
            .flatten()?;
        let stored = value.get("s").and_then(Value::as_str);
        match adom_core::peek_state(true, stored) {
            "hit" => Some(true),
            "miss" | "blocked" => Some(false),
            _ => None,
        }
    }))
}

#[cfg(test)]
#[path = "rd_store_tests.rs"]
mod tests;
