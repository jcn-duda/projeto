//! Reserva volátil de vagas por obra. O dono do worker deve serializar acesso;
//! esta peça não faz rede nem cria marker antes do aceite.

use std::collections::HashMap;

use adom_core::{
    combined_view, obra_identity, obra_key, overflow_upgrade_allowed, pool_cap, seeds_rare,
    window_ms, ObraIdentityInput, ObraLiveConfig, ObraRecordEntry, PendingReservation,
};

use super::ObraStoreV3;

const LEASE_MS: i64 = 60_000;

pub struct ObraReservationInput {
    pub identity: ObraIdentityInput,
    pub pool: String,
    pub hash: String,
    pub rare: bool,
    pub slot_limit: Option<f64>,
    pub quality: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObraLeaseV3 {
    pub id: String,
    pub key: String,
    pub pool: String,
    pub hash: String,
    pub rare: bool,
    pub overflow: bool,
}

#[derive(Default)]
pub struct ObraReservations {
    pending: HashMap<String, Vec<PendingReservation>>,
    sequence: u64,
}

impl ObraReservations {
    /// `None`: cap fechado. Chave vazia: identidade insuficiente, fail-open.
    /// A reserva é removida por release/commit ou vence em 60 segundos.
    pub fn reserve(
        &mut self,
        store: &ObraStoreV3<'_>,
        input: &ObraReservationInput,
        cfg: &ObraLiveConfig,
        now: i64,
    ) -> Result<Option<ObraLeaseV3>, String> {
        let rare = seeds_rare(&input.pool, input.rare, input.slot_limit, cfg);
        let mut lease = ObraLeaseV3 {
            id: String::new(),
            key: String::new(),
            pool: input.pool.clone(),
            hash: input.hash.to_lowercase(),
            rare,
            overflow: false,
        };
        let imdb = input.identity.imdb_id.as_deref().unwrap_or("");
        let valid_imdb = imdb
            .strip_prefix("tt")
            .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()));
        if input.identity.adapter_id.is_empty()
            || input.identity.account.is_empty()
            || (!valid_imdb
                && input
                    .identity
                    .search_key
                    .as_deref()
                    .unwrap_or("")
                    .is_empty())
        {
            return Ok(Some(lease));
        }
        let key = obra_key(&obra_identity(&input.identity));
        self.prune(&key, now);
        let alive = self.pending.get(&key).map(Vec::as_slice).unwrap_or(&[]);
        let span = window_ms(cfg);
        let record: Vec<_> = store
            .read(&key, now)?
            .into_iter()
            .filter(|entry| span > 0.0 && entry.accepted_at > now as f64 - span)
            .collect();
        let count = record
            .iter()
            .filter(|entry| entry.pool == input.pool)
            .count()
            + alive
                .iter()
                .filter(|entry| entry.pool == input.pool)
                .count();
        let cap = pool_cap(&input.pool, rare, cfg) as usize;
        if count >= cap {
            if count != cap
                || !overflow_upgrade_allowed(
                    &combined_view(&record, alive),
                    &input.pool,
                    input.quality.as_deref().unwrap_or(""),
                )
            {
                return Ok(None);
            }
            lease.overflow = true;
        }
        self.sequence = self.sequence.wrapping_add(1);
        lease.id = format!("{now}:{}", self.sequence);
        lease.key = key.clone();
        self.pending
            .entry(key)
            .or_default()
            .push(PendingReservation {
                id: lease.id.clone(),
                pool: lease.pool.clone(),
                rare,
                at: now as f64,
                hash: lease.hash.clone(),
                quality: input.quality.clone(),
                overflow: lease.overflow,
            });
        Ok(Some(lease))
    }

    pub fn release(&mut self, lease: &ObraLeaseV3) -> bool {
        let Some(entries) = self.pending.get_mut(&lease.key) else {
            return false;
        };
        let before = entries.len();
        entries.retain(|entry| entry.id != lease.id);
        let removed = entries.len() != before;
        if entries.is_empty() {
            self.pending.remove(&lease.key);
        }
        removed
    }

    /// Confirma o aceite sem ponto de espera: grava antes de liberar a
    /// reserva, para uma falha do KV não abrir vaga sem registro durável.
    /// `overflow` ausente herda o lease; falso explícito prevalece. A
    /// serialização global continua sendo responsabilidade do worker.
    pub fn commit(
        &mut self,
        store: &ObraStoreV3<'_>,
        lease: &ObraLeaseV3,
        entry: &ObraRecordEntry,
        overflow: Option<bool>,
        ttl: i64,
        now: i64,
    ) -> Result<bool, String> {
        if lease.key.is_empty() {
            return Ok(false);
        }
        let mut accepted = entry.clone();
        if accepted.hash.is_empty() {
            accepted.hash.clone_from(&lease.hash);
        }
        if accepted.pool.is_empty() {
            accepted.pool.clone_from(&lease.pool);
        }
        accepted.overflow = overflow.unwrap_or(lease.overflow);
        let saved = store.commit(&lease.key, &accepted, ttl, now)?;
        if saved {
            self.release(lease);
        }
        Ok(saved)
    }

    fn prune(&mut self, key: &str, now: i64) {
        if let Some(entries) = self.pending.get_mut(key) {
            entries.retain(|entry| entry.at + LEASE_MS as f64 > now as f64);
            if entries.is_empty() {
                self.pending.remove(key);
            }
        }
    }
}
