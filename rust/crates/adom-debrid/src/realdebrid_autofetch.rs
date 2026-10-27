//! Leitura do status para o futuro worker. Ainda não há escrita na conta:
//! enqueue e delete dependem do agendador nativo AIMD com prioridade.

use super::{RealDebrid, READY, WAITING, WORKING};
use crate::error::DebridError;
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct RdTorrentStatus {
    pub state: &'static str,
    pub id: Option<Value>,
}

/// Os hashes prontos são evidência para `rdLedger.noteHit`; o chamador deve
/// persistir os hits no ledger antes de publicar a foto como completa.
pub struct RdTorrentStatuses {
    pub by_hash: BTreeMap<String, RdTorrentStatus>,
    pub ready_hashes: Vec<String>,
}

impl RealDebrid {
    pub async fn torrent_status(&self, api_key: &str) -> Result<RdTorrentStatuses, DebridError> {
        Ok(classify(self.list_torrents(api_key).await?))
    }
}

fn classify(rows: Vec<Value>) -> RdTorrentStatuses {
    let mut by_hash = BTreeMap::new();
    let mut ready_hashes = Vec::new();
    for row in rows {
        let Some(hash) = row
            .get("hash")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let hash = hash.to_lowercase();
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let state = if status == READY {
            ready_hashes.push(hash.clone());
            "ready"
        } else if ["magnet_error", "error", "virus", "dead"].contains(&status.as_str()) {
            "dead"
        } else if WORKING.contains(&status.as_str()) || status == WAITING {
            "downloading"
        } else {
            "unknown"
        };
        by_hash.insert(
            hash,
            RdTorrentStatus {
                state,
                id: row.get("id").cloned(),
            },
        );
    }
    RdTorrentStatuses {
        by_hash,
        ready_hashes,
    }
}

#[cfg(test)]
mod tests {
    use super::super::realdebrid_tests::{listen, open, Scene, KEY};
    use super::*;
    use serde_json::json;

    #[test]
    fn status_e_hits_do_ledger_viram_provas_separadas() {
        let result = classify(vec![
            json!({"hash":"AA","id":1,"status":"downloaded"}),
            json!({"hash":"BB","status":"magnet_error"}),
            json!({"hash":"CC","status":"waiting_files_selection"}),
            json!({"hash":"DD","status":"desconhecido"}),
            json!({"status":"downloaded"}),
        ]);
        assert_eq!(result.by_hash["aa"].state, "ready");
        assert_eq!(result.by_hash["bb"].state, "dead");
        assert_eq!(result.by_hash["cc"].state, "downloading");
        assert_eq!(result.by_hash["dd"].state, "unknown");
        assert_eq!(result.ready_hashes, ["aa"]);
    }

    #[tokio::test]
    async fn status_consulta_inventario_sem_escrita_na_conta() {
        let (addr, mock) = listen(Scene::Ready).await;
        let status = open(addr).torrent_status(KEY).await.unwrap();
        assert_eq!(status.by_hash.len(), 1);
        assert_eq!(status.ready_hashes.len(), 1);
        assert_eq!(status.by_hash[&status.ready_hashes[0]].state, "ready");
        assert_eq!(mock.hits.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(mock.recs.lock().unwrap()[0].path, "/torrents");
    }
}
