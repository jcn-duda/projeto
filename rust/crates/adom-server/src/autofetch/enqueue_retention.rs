//! Proteção DURÁVEL do que o Chupim baixa contra a limpeza da checagem
//! (invariante 6: autofetch e `dropUncached` são forças opostas).
//!
//! O [`super::Holds`] do laço é só a trava de concorrência do processo; a
//! limpeza da checagem da AllDebrid lê outra coisa: `adhold:v1` e `adprot:v1`
//! no KV nativo (`al_cleanup_facts::protected`). Desde o corte do TS (B4) nada
//! gravava essas chaves, e a busca seguinte via o download recém-aceito como
//! "fora do cache" e o apagava da conta em minutos — o recheck então ficava sem
//! sinal até o settle. Régua portada de `protected.ts` (`hold`/`release`/
//! `protectBr`) e das duas chamadas do runner (aceite imediato e dreno).

use adom_autofetch::v3::{CascadeAttempt, CascadePool};
use adom_index::NativeKv;
use serde_json::json;

use super::super::enqueue_items::Item;
use super::Holds;

/// Único serviço com retenção durável (`HELD_ADAPTER` do TS).
const HELD_ADAPTER: &str = "alldebrid";
/// `DEBRID_AUTO_FETCH_PROTECT_BR_TTL` (10 anos, `config/debrid.ts`).
const PROTECT_BR_TTL_DEFAULT: i64 = 315_360_000;

fn norm(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

pub(in crate::autofetch) fn hold_key(account: &str, hash: &str) -> String {
    format!("adhold:v1:{}:{}", norm(account), norm(hash))
}

pub(in crate::autofetch) fn adprot_key(adapter: &str, account: &str, hash: &str) -> String {
    format!(
        "adprot:v1:{}:{}:{}",
        norm(adapter),
        norm(account),
        norm(hash)
    )
}

/// `held.hold`: protege o hash pelo TTL do autofetch. Chamar de novo renova.
pub(in crate::autofetch) fn hold(
    kv: &NativeKv,
    account: &str,
    hash: &str,
    ttl_seconds: i64,
    now_ms: i64,
) -> Result<(), String> {
    if account.trim().is_empty() || hash.trim().is_empty() {
        return Ok(());
    }
    kv.put_json(
        &hold_key(account, hash),
        &json!({ "at": now_ms }),
        ttl_seconds.max(1),
        now_ms,
    )
}

/// [`hold`] de todo o lote; uma falha solta o que já foi preso e recusa o lote
/// (sem hold durável não há download: a limpeza o apagaria).
pub(in crate::autofetch) fn hold_all(
    holds: &Holds,
    kv: &NativeKv,
    account: &str,
    hashes: &[String],
    ttl_seconds: i64,
    now_ms: i64,
) -> Result<(), String> {
    for hash in hashes {
        if let Err(err) = hold(kv, account, hash, ttl_seconds, now_ms) {
            release_all(holds, kv, account, hashes, &[]);
            return Err(format!("hold durável: {err}"));
        }
    }
    Ok(())
}

/// `held.release`: o download não aconteceu, volta a valer a limpeza normal.
/// Falha só vai ao log: o hold vence sozinho pelo TTL.
pub(in crate::autofetch) fn release(kv: &NativeKv, account: &str, hash: &str) {
    if let Err(err) = kv.forget(&hold_key(account, hash)) {
        eprintln!("[autofetch] soltar hold de {hash} falhou: {err}");
    }
}

/// Fatos do release que decidem a retenção BR (`autofetch-runner.ts:139`).
pub(in crate::autofetch) struct BrFacts {
    pub(in crate::autofetch) pool_br: bool,
    pub(in crate::autofetch) br: bool,
    pub(in crate::autofetch) dubbed: bool,
    pub(in crate::autofetch) lied: bool,
}

impl BrFacts {
    fn retains(&self) -> bool {
        self.pool_br && self.br && self.dubbed && !self.lied
    }
}

fn protect_enabled() -> bool {
    crate::al_cleanup_facts::literal_true_env("DEBRID_AUTO_FETCH_PROTECT_BR")
}

fn protect_ttl() -> i64 {
    std::env::var("DEBRID_AUTO_FETCH_PROTECT_BR_TTL")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| (value as i64).max(1))
        .unwrap_or(PROTECT_BR_TTL_DEFAULT)
}

/// `held.protectBr` depois do aceite. Idempotente: um registro anterior mantém
/// o `acceptedAt`. Nunca derruba o aceite — falha de escrita vai ao log.
pub(in crate::autofetch) fn protect_br(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    hash: &str,
    facts: &BrFacts,
    now_ms: i64,
) {
    protect_br_with(
        kv,
        adapter,
        account,
        hash,
        facts,
        protect_enabled(),
        protect_ttl(),
        now_ms,
    );
}

#[allow(clippy::too_many_arguments)] // flag e TTL separados para o teste não tocar no env
pub(in crate::autofetch) fn protect_br_with(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    hash: &str,
    facts: &BrFacts,
    enabled: bool,
    ttl_seconds: i64,
    now_ms: i64,
) {
    if !enabled || norm(adapter) != HELD_ADAPTER || !facts.retains() || hash.trim().is_empty() {
        return;
    }
    let key = adprot_key(adapter, account, hash);
    match kv.get_json(&key, now_ms) {
        Ok(Some(value)) if !value.is_null() => return,
        Ok(_) => {}
        Err(err) => {
            eprintln!("[autofetch] leitura do adprot de {hash} falhou: {err}");
            return;
        }
    }
    let value = json!({ "acceptedAt": now_ms, "readyAt": null });
    if let Err(err) = kv.put_json(&key, &value, ttl_seconds, now_ms) {
        eprintln!("[autofetch] gravar adprot de {hash} falhou: {err}");
    }
}

/// Retenção do aceite IMEDIATO: a promessa e a classificação do banco contam
/// como dublado, como no runner do TS.
pub(in crate::autofetch) fn protect_item(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    attempt: &CascadeAttempt,
    item: &Item,
    now_ms: i64,
) {
    let facts = BrFacts {
        pool_br: attempt.pool == CascadePool::Br,
        br: item.br,
        dubbed: item.dubbed || item.dub_claim || item.bank_dub,
        lied: item.lied,
    };
    protect_br(kv, adapter, account, &attempt.info_hash, &facts, now_ms);
}

/// Solta a trava do processo de todos e o hold DURÁVEL de quem não foi aceito:
/// o aceito segue protegido pelo TTL do autofetch (o `held.release` do TS só
/// roda quando o download não acontece).
pub(in crate::autofetch) fn release_all(
    holds: &Holds,
    kv: &NativeKv,
    account: &str,
    hashes: &[String],
    accepted: &[(String, Option<String>)],
) {
    for hash in hashes {
        holds.release(account, hash);
        if !accepted.iter().any(|(done, _)| done == hash) {
            release(kv, account, hash);
        }
    }
}

#[cfg(test)]
#[path = "enqueue_retention_tests.rs"]
mod tests;
