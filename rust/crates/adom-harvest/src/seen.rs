//! Dedupe de 12h da fila — espelho de `queueDedupeKey` / `wasRecentlyQueued` /
//! `markRecentlyQueued` em `src/providers/harvest-queue.ts`.
//!
//! A chave é `harvest:v1:seen:<sha256(obraIdentity:reason)>` com valor `"1"` e
//! TTL de 12h. O contrato tem duas metades que não se confundem: **ler não
//! renova** (a obra continua elegível até o TTL vencer) e **gravar é do
//! chamador**, só depois do aceite — gravar antes engolia a promoção de motivo
//! (`miss` → `br-gap`) porque o pedido mais forte chegava como duplicata.

use std::fmt::Write as _;

use adom_core::prefix;
use sha2::{Digest, Sha256};

use crate::queue::HARVEST_NAMESPACE;
use crate::reason::obra_identity;
use crate::store::HarvestStore;
use crate::types::HarvestEntry;

/// TTL do dedupe por obra+motivo (`HARVEST_DEDUPE_TTL_S` no TS).
pub const DEDUPE_TTL_SECONDS: u64 = 12 * 3600;

/// `harvest:v1:seen:<hex>` para obra+motivo.
pub fn seen_key(imdb_id: &str, season: Option<i32>, episode: Option<i32>, reason: &str) -> String {
    let identity = obra_identity(imdb_id, season, episode);
    let mut hasher = Sha256::new();
    hasher.update(format!("{identity}:{reason}").as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("{}seen:{hex}", prefix(HARVEST_NAMESPACE))
}

pub fn entry_seen_key(entry: &HarvestEntry) -> String {
    seen_key(&entry.imdb_id, entry.season, entry.episode, &entry.reason)
}

/// Já aceita nos últimos 12h? Não renova o TTL.
pub fn was_recently_queued(
    store: &HarvestStore,
    entry: &HarvestEntry,
    now_ms: i64,
) -> Result<bool, String> {
    Ok(store.get_value(&entry_seen_key(entry), now_ms)?.as_deref() == Some("1"))
}

/// Grava/renova o dedupe — só quando o pedido é ACEITO.
pub fn mark_recently_queued(
    store: &HarvestStore,
    entry: &HarvestEntry,
    now_ms: i64,
) -> Result<(), String> {
    store.put_value(&entry_seen_key(entry), "1", DEDUPE_TTL_SECONDS, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HarvestMediaType;

    fn entry(imdb: &str, reason: &str, season: Option<i32>, episode: Option<i32>) -> HarvestEntry {
        HarvestEntry {
            imdb_id: imdb.into(),
            media_type: HarvestMediaType::Movie,
            season,
            episode,
            reason: reason.into(),
            enqueued_at: 1_700_000_000_000,
            priority_at: None,
            resumed: false,
            br_probe: false,
            full_base: false,
            full_intent: None,
        }
    }

    #[test]
    fn chave_deterministica_separa_obra_e_motivo() {
        let filme = entry("tt0111161", "miss", None, None);
        let key = entry_seen_key(&filme);
        assert!(key.starts_with("harvest:v1:seen:"));
        assert_eq!(key.len(), "harvest:v1:seen:".len() + 64);
        assert_eq!(key, entry_seen_key(&filme));
        assert_ne!(
            key,
            entry_seen_key(&entry("tt0111161", "br-gap", None, None))
        );
        assert_ne!(
            entry_seen_key(&filme),
            entry_seen_key(&entry("tt0903747", "miss", Some(1), Some(2)))
        );
    }

    #[test]
    fn marca_e_expira_em_doze_horas() {
        let store = HarvestStore::open_memory().unwrap();
        let filme = entry("tt0111161", "miss", None, None);
        let now = 1_700_000_000_000;
        assert!(!was_recently_queued(&store, &filme, now).unwrap());
        mark_recently_queued(&store, &filme, now).unwrap();
        assert_eq!(
            store
                .get_value(&entry_seen_key(&filme), now)
                .unwrap()
                .as_deref(),
            Some("1")
        );
        assert!(was_recently_queued(&store, &filme, now).unwrap());
        // Ler não renova: 1 ms antes do TTL ainda vale; no TTL, expirou.
        assert!(was_recently_queued(&store, &filme, now + 12 * 3600 * 1000 - 1).unwrap());
        assert!(!was_recently_queued(&store, &filme, now + 12 * 3600 * 1000).unwrap());
        assert!(store
            .get_value(&entry_seen_key(&filme), now)
            .unwrap()
            .is_none());
    }

    #[test]
    fn motivo_diferente_nao_bloqueia_a_mesma_obra() {
        let store = HarvestStore::open_memory().unwrap();
        let now = 1_700_000_000_000;
        mark_recently_queued(&store, &entry("tt0111161", "miss", None, None), now).unwrap();
        assert!(
            !was_recently_queued(&store, &entry("tt0111161", "br-gap", None, None), now).unwrap()
        );
    }
}
