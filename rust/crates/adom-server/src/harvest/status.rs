//! Snapshot do colhedor para a API administrativa (`GET /harvest`).
//!
//! O loop escreve; as rotas leem. `depth`/`preview`/`inflight`/`queries` são a
//! foto do último ciclo — o snapshot NÃO segura o lock da fila (um drain pode
//! durar minutos e o painel não pode pendurar).

use adom_harvest::{DrainOutcome, HarvestEntry, HarvestMediaType};
use serde::{Deserialize, Serialize};

/// Última obra drenada (a linha de `last` no painel).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastDrain {
    pub imdb_id: String,
    #[serde(rename = "type")]
    pub media_type: HarvestMediaType,
    pub reason: String,
    pub ok: bool,
    pub queries: u32,
    /// Epoch ms do fim do drain.
    pub at: i64,
}

/// Contadores acumulados desde o boot (não persistidos — o TS também não).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestCounters {
    pub drained: u64,
    pub failed: u64,
}

/// Snapshot serializável da fila + worker.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestStatus {
    pub paused: bool,
    pub inflight: bool,
    pub depth: usize,
    pub preview: Vec<HarvestEntry>,
    pub last: Vec<LastDrain>,
    pub queries_this_hour: u32,
    pub counters: HarvestCounters,
}

impl HarvestStatus {
    /// Registra um drain concluído e mantém `last` no tamanho do preview.
    pub fn note_drain(
        &mut self,
        entry: &HarvestEntry,
        outcome: DrainOutcome,
        at: i64,
        limit: usize,
    ) {
        self.counters.drained = self.counters.drained.saturating_add(1);
        if !outcome.ok {
            self.counters.failed = self.counters.failed.saturating_add(1);
        }
        self.last.push(LastDrain {
            imdb_id: entry.imdb_id.clone(),
            media_type: entry.media_type,
            reason: entry.reason.clone(),
            ok: outcome.ok,
            queries: outcome.queries,
            at,
        });
        if self.last.len() > limit {
            let excess = self.last.len() - limit;
            self.last.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adom_harvest::HarvestRequest;

    fn entry(imdb: &str) -> HarvestEntry {
        // A fila é a dona do `HarvestEntry`; o teste só precisa do formato.
        let mut queue = adom_harvest::HarvestQueue::new(Default::default());
        queue.enqueue(HarvestRequest::movie(imdb, "miss"));
        queue.take_head().expect("entrada")
    }

    #[test]
    fn last_respeita_o_teto_e_conta_falhas() {
        let mut status = HarvestStatus::default();
        status.note_drain(&entry("tt1"), DrainOutcome::ok_with_queries(3), 10, 2);
        status.note_drain(&entry("tt2"), DrainOutcome::failed(), 11, 2);
        status.note_drain(&entry("tt3"), DrainOutcome::failed(), 12, 2);
        assert_eq!(status.last.len(), 2);
        assert_eq!(status.last[0].imdb_id, "tt2");
        assert_eq!(status.last[1].imdb_id, "tt3");
        assert_eq!(status.counters.drained, 3);
        assert_eq!(status.counters.failed, 2);
    }
}
