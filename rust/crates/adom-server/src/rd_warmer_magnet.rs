//! Banco de magnets do warmer: pular `bad`, marcar `alive` no hit e reparar o
//! dano histórico (`bad` gravado por recusa legal do RD).
//!
//! # Por que o warmer fala com o `mag:v1`
//!
//! O Node fazia três coisas no `processBatch` que o veredito nativo não cobre:
//! `magnetdb.isBad` antes da sonda (hash que o play provou quebrado não gasta
//! requisição), `markAlive` no hit (o acervo permanente passa a preferir o hash)
//! e `scanBlockedRdBads` no boot (hash que o RD recusou por lei — HTTP 451 — era
//! marcado `bad` por um ramo antigo; recusa legal NÃO é magnet quebrado).
//!
//! O store é o MESMO `MagnetStateStore` do `adom-index` (`data/magnets.db` no
//! `cache.db`), com a precedência `bad > lie > alive` do núcleo. O reparo apaga
//! só o `bad` de hashes cujo ledger diga `blocked`, e `forget_bad_of` alcança
//! todas as contas do adapter — o reparo não precisa da credencial.

use std::sync::Arc;

use adom_index::{MagnetState, MagnetStateStore};

use super::{LedgerMark, WarmLedger};

const ADAPTER: &str = "realdebrid";

/// O que o warmer precisa do banco de magnets. O duplo de teste não toca disco.
pub(crate) trait WarmMagnet: Send + Sync {
    fn is_bad(&self, api_key: &str, hash: &str, now_ms: i64) -> bool;
    fn mark_alive(&self, api_key: &str, hash: &str, now_ms: i64);
    fn scan_blocked_bads(&self, ledger: &dyn WarmLedger, now_ms: i64) -> usize;
}

/// Sem banco (`MAGNET_DB=false`, KV indisponível ou teste): no-op.
#[allow(dead_code)]
pub(crate) struct NoMagnet;

impl WarmMagnet for NoMagnet {
    fn is_bad(&self, _api_key: &str, _hash: &str, _now_ms: i64) -> bool {
        false
    }

    fn mark_alive(&self, _api_key: &str, _hash: &str, _now_ms: i64) {}

    fn scan_blocked_bads(&self, _ledger: &dyn WarmLedger, _now_ms: i64) -> usize {
        0
    }
}

/// Produção: `mag:v1` no `cache.db` compartilhado.
pub(crate) struct MagnetDb {
    store: Option<Arc<MagnetStateStore>>,
    alive_ttl_s: i64,
}

impl MagnetDb {
    pub(crate) fn from_env() -> Self {
        let enabled = super::rd::env_flag_default("MAGNET_DB", true);
        let store = if enabled {
            match MagnetStateStore::open(&adom_store::default_cache_db_path()) {
                Ok(store) => Some(Arc::new(store)),
                Err(err) => {
                    eprintln!("[warmer] magnetdb indisponível ({err}); sem alive/bad");
                    None
                }
            }
        } else {
            None
        };
        Self {
            store,
            // A MESMA régua do `MAGNET_ALIVE_TTL` do Node (`config/audit.ts`).
            alive_ttl_s: super::rd::env_num("MAGNET_ALIVE_TTL", 7 * 24 * 3_600).max(0),
        }
    }

    #[cfg(test)]
    pub(crate) fn memory(store: Arc<MagnetStateStore>) -> Self {
        Self {
            store: Some(store),
            alive_ttl_s: 7 * 24 * 3_600,
        }
    }
}

impl WarmMagnet for MagnetDb {
    fn is_bad(&self, api_key: &str, hash: &str, now_ms: i64) -> bool {
        let Some(store) = self.store.as_deref() else {
            return false;
        };
        matches!(
            store.state(ADAPTER, api_key, hash, now_ms),
            Ok(Some(MagnetState::Bad))
        )
    }

    fn mark_alive(&self, api_key: &str, hash: &str, now_ms: i64) {
        let Some(store) = self.store.as_deref() else {
            return;
        };
        if self.alive_ttl_s <= 0 {
            return;
        }
        // `mark_alive` já recusa hash com `bad` vivo: o play provou que está
        // quebrado e o aquecimento não pode ressuscitá-lo.
        if let Err(err) = store.mark_alive(
            ADAPTER,
            api_key,
            &[hash.to_string()],
            self.alive_ttl_s,
            now_ms,
        ) {
            eprintln!("[warmer] magnetdb alive não gravou: {err}");
        }
    }

    fn scan_blocked_bads(&self, ledger: &dyn WarmLedger, now_ms: i64) -> usize {
        let Some(store) = self.store.as_deref() else {
            return 0;
        };
        // `limit` 0 = sem limite: o reparo varre o namespace inteiro do RD, não
        // uma página do painel. Só conta hash que o ledger prova `blocked`.
        let Ok(page) = store.entries(Some(ADAPTER), Some("bad"), None, 0, now_ms) else {
            return 0;
        };
        let mut cleared = 0;
        for item in page.items {
            if !matches!(ledger.state(&item.hash, now_ms), LedgerMark::Blocked) {
                continue;
            }
            match store.forget_bad_of(ADAPTER, &item.hash) {
                Ok(removed) if removed > 0 => cleared += 1,
                Ok(_) => {}
                Err(err) => eprintln!("[warmer] forget_bad falhou: {err}"),
            }
        }
        cleared
    }
}
