//! Balde horário durável do colhedor — espelho de `harvest-worker.ts`
//! (`HOUR_KEY`, `hourBucketTtlSeconds`, `hydrateCurrentHour`, `noteQueries`).
//!
//! Sem isto, restart/deploy zera o contador da hora e o colhedor pode estourar
//! `HARVEST_MAX_HOUR` de novo na mesma hora (risco de ban no indexer). Só este
//! contador é durável; pausa e trabalho recente continuam em memória.

use adom_core::prefix;
use serde::{Deserialize, Serialize};

use crate::queue::HARVEST_NAMESPACE;
use crate::store::HarvestStore;

/// Ms por balde horário civil UTC (mesmo corte do TS: `Date.now()/3_600_000`).
pub const HOUR_MS: i64 = 3_600_000;

/// Índice do balde horário UTC a partir de epoch ms.
pub fn hour_bucket(now_ms: i64) -> i64 {
    now_ms.div_euclid(HOUR_MS)
}

/// Balde em memória do worker — o espelho durável é este módulo.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HourMeter {
    hour: i64,
    count: u32,
}

impl HourMeter {
    /// Poda na virada: só a hora de `now_ms` conta.
    fn sync(&mut self, now_ms: i64) {
        let hour = hour_bucket(now_ms);
        if self.hour != hour {
            *self = Self { hour, count: 0 };
        }
    }

    pub fn count(&mut self, now_ms: i64) -> u32 {
        self.sync(now_ms);
        self.count
    }

    pub fn note(&mut self, count: u32, now_ms: i64) {
        if count == 0 {
            return;
        }
        self.sync(now_ms);
        self.count = self.count.saturating_add(count);
    }

    /// Semeia com o L2 sem regredir o que o processo já debitou.
    pub fn hydrate(&mut self, count: u32, now_ms: i64) {
        self.sync(now_ms);
        if count > self.count {
            self.count = count;
        }
    }

    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

/// Chave canônica do balde (`harvest:v1:hour`).
pub const HOUR_KEY: &str = "harvest:v1:hour";

pub fn hour_key() -> String {
    format!("{}hour", prefix(HARVEST_NAMESPACE))
}

/// O que o L2 guarda: a hora civil UTC e as consultas contadas nela.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredHour {
    pub hour: i64,
    pub count: u32,
}

/// Segundos até o fim do balde + 60 de folga; mínimo 60 (o L2 não some na virada).
pub fn hour_ttl_seconds(hour: i64, now_ms: i64) -> u64 {
    let end_ms = hour.saturating_add(1).saturating_mul(HOUR_MS);
    let left_ms = end_ms.saturating_sub(now_ms).max(0);
    let seconds_left = (left_ms + 999) / 1000;
    (seconds_left + 60).max(60) as u64
}

/// Lê o balde só se for da hora corrente e tiver contagem positiva.
pub fn load_hour(store: &HarvestStore, now_ms: i64) -> Result<Option<StoredHour>, String> {
    let Some(raw) = store.get_value(&hour_key(), now_ms)? else {
        return Ok(None);
    };
    let stored: StoredHour = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    Ok((stored.hour == hour_bucket(now_ms) && stored.count > 0).then_some(stored))
}

/// Grava o balde da hora corrente com o TTL do TS.
pub fn save_hour(store: &HarvestStore, count: u32, now_ms: i64) -> Result<StoredHour, String> {
    let hour = hour_bucket(now_ms);
    let state = StoredHour { hour, count };
    let encoded = serde_json::to_string(&state).map_err(|err| err.to_string())?;
    store.put_value(
        &hour_key(),
        &encoded,
        hour_ttl_seconds(hour, now_ms),
        now_ms,
    )?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 472_222;

    #[test]
    fn hour_bucket_bate_com_corte_ts() {
        assert_eq!(hour_bucket(0), 0);
        assert_eq!(hour_bucket(HOUR_MS - 1), 0);
        assert_eq!(hour_bucket(HOUR_MS), 1);
        assert_eq!(hour_bucket(1_700_000_000_000), 472_222);
    }

    #[test]
    fn meter_poda_na_virada_e_hidrata_sem_regredir() {
        let mut meter = HourMeter::default();
        meter.note(2, HOUR * HOUR_MS);
        assert_eq!(meter.count(HOUR * HOUR_MS), 2);
        meter.hydrate(1, HOUR * HOUR_MS);
        assert_eq!(meter.count(HOUR * HOUR_MS), 2);
        meter.hydrate(5, HOUR * HOUR_MS);
        assert_eq!(meter.count(HOUR * HOUR_MS), 5);
        assert_eq!(meter.count((HOUR + 1) * HOUR_MS), 0);
    }

    #[test]
    fn ttl_termina_no_fim_da_hora_com_folga() {
        let start = HOUR * HOUR_MS;
        // Início da hora: 3600 s restantes + 60 de folga.
        assert_eq!(hour_ttl_seconds(HOUR, start), 3660);
        // 1 ms antes da virada: 1 s (arredondado) + 60.
        assert_eq!(hour_ttl_seconds(HOUR, start + HOUR_MS - 1), 61);
        // Fora da janela: nunca abaixo do mínimo.
        assert_eq!(hour_ttl_seconds(HOUR, start + HOUR_MS), 60);
    }

    #[test]
    fn save_e_load_so_na_hora_corrente() {
        let store = HarvestStore::open_memory().unwrap();
        let now = HOUR * HOUR_MS + 1_000;
        let saved = save_hour(&store, 7, now).unwrap();
        assert_eq!(
            saved,
            StoredHour {
                hour: HOUR,
                count: 7
            }
        );
        assert_eq!(load_hour(&store, now).unwrap(), Some(saved));
        // A linha ainda vive (TTL até o fim da hora + folga), mas outra hora não a lê.
        assert_eq!(load_hour(&store, now + HOUR_MS).unwrap(), None);
    }

    #[test]
    fn load_ignora_zero_e_json_podre() {
        let store = HarvestStore::open_memory().unwrap();
        let now = HOUR * HOUR_MS + 5_000;
        save_hour(&store, 0, now).unwrap();
        assert_eq!(load_hour(&store, now).unwrap(), None);
        store.put_value(&hour_key(), "{podre", 3_600, now).unwrap();
        assert_eq!(load_hour(&store, now).unwrap(), None);
    }
}
