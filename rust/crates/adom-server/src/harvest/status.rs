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
    /// O L2 abriu DEGRADADO (arquivo podre quarentenado) — o painel não pode
    /// ler "fila vazia" como "nada a colher".
    pub degraded: bool,
    /// O que o `open` do store respondeu (`None` = arquivo íntegro).
    pub store_error: Option<String>,
    /// Alvos de invalidacao que estouraram as 5 tentativas e pararam na
    /// dead-letter — nada some em silencio; o painel mostra a contagem.
    pub outbox_dead: usize,
}

impl HarvestStatus {
    /// Foto inicial com o veredito do `open` do L2 (`store.rs`).
    pub fn with_store(store: &adom_harvest::HarvestStore) -> Self {
        Self {
            degraded: store.degraded(),
            store_error: store.degraded_error().map(str::to_string),
            ..Self::default()
        }
    }

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

    #[test]
    fn status_do_harvest_mostra_store_degradado() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.db");
        std::fs::write(&path, b"not a database").unwrap();

        let store = adom_harvest::HarvestStore::open(&path).expect("quarentena + recria");
        assert!(store.degraded());

        let status = HarvestStatus::with_store(&store);
        assert!(status.degraded, "GET /harvest tem que avisar o painel");
        assert!(status.store_error.is_some(), "com o motivo do store");
        // O contrato do painel: `degraded`/`storeError` (camelCase).
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["degraded"], true);
        assert!(json["storeError"].as_str().unwrap().contains("quick_check"));
    }

    #[test]
    fn status_do_harvest_expoe_outbox_dead() {
        let status = HarvestStatus {
            outbox_dead: 3,
            ..Default::default()
        };
        // O contrato do painel: `outboxDead` (camelCase).
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["outboxDead"], 3);
    }

    #[test]
    fn status_do_harvest_saudavel_nao_e_degradado() {
        let store = adom_harvest::HarvestStore::open_memory().unwrap();
        let status = HarvestStatus::with_store(&store);
        assert!(!status.degraded);
        assert!(status.store_error.is_none());
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["degraded"], false);
        assert!(json["storeError"].is_null());
    }
}
