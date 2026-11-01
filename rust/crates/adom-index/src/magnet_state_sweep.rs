//! Poda do namespace `mag:v1` — o caminho que apaga EM VARREDURA.
//!
//! Saiu de `magnet_state_query.rs` pelo teto de 400 linhas (mesmo motivo do
//! `rows`); a máscara do namespace e a ordem de escrita continuam sendo do
//! irmão `query`. Aqui a remoção física acontece, então é aqui que o agregado
//! `mag_meta:v1:counts` é invalidado — na MESMA transação que apaga as linhas:
//! ou tudo acontece, ou nada.

use std::collections::BTreeMap;

use rusqlite::{params, Transaction, TransactionBehavior};

use super::{pair, parse_key, scan_rows, MagCount, MagSweep};
use crate::magnet_state::{is_expired, MagnetStateStore};

impl MagnetStateStore {
    /// Poda do namespace, agora que o Node não apaga mais estas linhas: apaga as
    /// VENCIDAS (parseáveis ou não) e, acima de `max_entries` (`0` = sem teto),
    /// as mais antigas por `rowid`, somando cada removida em `counts`/`evicted`.
    /// Tudo numa transação só, em ordem de escrita.
    pub fn sweep(&self, max_entries: u32, now_ms: i64) -> Result<MagSweep, String> {
        let conn = self.lock();
        let tx = Transaction::new_unchecked(&conn, TransactionBehavior::Immediate)
            .map_err(|err| err.to_string())?;
        let mut expired = 0u32;
        let mut counts: BTreeMap<(String, String), u32> = BTreeMap::new();
        // Vivas que sobram, na ordem em que podem ser evictadas: `rowid` cresce
        // com a escrita, então a primeira da lista é a mais antiga.
        let mut live: Vec<(i64, Option<(String, String)>)> = Vec::new();
        for (rowid, key, expires_at) in scan_rows(&tx)? {
            let parsed = parse_key(&key);
            if is_expired(expires_at, now_ms) {
                expired = expired.saturating_add(1);
                if let Some(item) = parsed {
                    *counts.entry(pair(item)).or_insert(0) += 1;
                }
                tx.execute("DELETE FROM cache WHERE key = ?1", params![key])
                    .map_err(|err| err.to_string())?;
                continue;
            }
            live.push((rowid, parsed.map(pair)));
        }
        // `max_entries == 0` é teto DESLIGADO, não "apaga tudo".
        let excess = if max_entries == 0 {
            0
        } else {
            live.len().saturating_sub(max_entries as usize)
        };
        let mut evicted = 0u32;
        for (rowid, side) in live.into_iter().take(excess) {
            tx.execute("DELETE FROM cache WHERE rowid = ?1", params![rowid])
                .map_err(|err| err.to_string())?;
            evicted = evicted.saturating_add(1);
            if let Some(side) = side {
                *counts.entry(side).or_insert(0) += 1;
            }
        }
        // A poda removeu linhas físicas: invalida o agregado NA MESMA transação
        // — decremento aritmético não alcança (ver `invalidate_counts` no
        // `magnet_meta`); sem remoção, o agregado fica (reconto à toa não).
        if expired > 0 || evicted > 0 {
            crate::magnet_meta::invalidate_counts(&tx)?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(MagSweep {
            expired,
            evicted,
            // Linha removida não tem janela restante a somar.
            counts: counts
                .into_iter()
                .map(|((adapter, side), count)| MagCount {
                    adapter,
                    side,
                    count,
                    ttl_remaining_sum: 0,
                })
                .collect(),
        })
    }
}
