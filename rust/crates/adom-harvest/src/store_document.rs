//!
//! Documento do valor `harvest:v1:q` (T1-B1): fila + slot EM VOO + terminais.
//!
//! Saiu do `store.rs` quando o claim durável o levou ao teto de 400 linhas. O
//! [`HarvestStore`] continua dono do SQLite (schema, quarentena, chaves
//! auxiliares); aqui mora só o FORMATO do valor e as duas pontas
//! (`load_queue` / `save_queue`).
//!
//! A obra em voo viaja junto DE PROPÓSITO: qualquer `save` (o enqueue do Node,
//! por exemplo) carrega o claim, então um restart no meio do drain não perde a
//! entrada. Quem decide o que é vivo é a [`crate::HarvestQueue`].

use std::collections::HashMap;

use rusqlite::params;

use super::{backup_corrupt, read_row, HarvestStore, CORRUPT_QUEUE_KEY};
use crate::lease::{InflightEntry, Lease, TerminalEntry};
use crate::queue::QUEUE_KEY;
use crate::reason::is_valid_imdb_id;
use crate::types::{HarvestEntry, PendingFull};

/// Envelope privado: o preview HTTP serializa `HarvestEntry` sem `fullIntent`.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredEntry {
    #[serde(flatten)]
    entry: HarvestEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    full_intent: Option<PendingFull>,
}

fn to_stored(entry: HarvestEntry) -> StoredEntry {
    StoredEntry {
        full_intent: entry.full_intent.clone(),
        entry,
    }
}

fn from_stored(stored: StoredEntry) -> HarvestEntry {
    let mut entry = stored.entry;
    entry.full_intent = stored.full_intent;
    entry.normalize_intent();
    entry
}

/// O que o L2 devolve: a fila, o slot em voo e o contador de mortes de claim.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredQueue {
    pub entries: Vec<HarvestEntry>,
    pub inflight: Option<InflightEntry>,
    /// Mortes de claim por `entry_id` (o slot que voltou conta uma).
    pub attempts: HashMap<String, u32>,
    pub terminal: Vec<TerminalEntry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredInflight {
    entry_id: String,
    entry: StoredEntry,
    lease: Lease,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTerminal {
    entry_id: String,
    entry: StoredEntry,
    reason: String,
    at_ms: i64,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredQueueFile {
    entries: Vec<StoredEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    inflight: Option<StoredInflight>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    attempts: HashMap<String, u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    terminal: Vec<StoredTerminal>,
}

/// O formato ANTERIOR era o array cru. Os dois são lidos: instalação existente
/// não pode perder a fila no upgrade (grava-se sempre o documento novo).
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum QueueFile {
    // `Box` porque o documento é muito maior que o array legado e o enum só
    // existe durante a leitura.
    Current(Box<StoredQueueFile>),
    Legacy(Vec<StoredEntry>),
}

impl HarvestStore {
    /// `cache.get(harvest:v1:q)` — miss/expirado → vazio; filtra IMDb inválido.
    ///
    /// JSON inválido NÃO derruba o boot: o valor cru é copiado para
    /// [`CORRUPT_QUEUE_KEY`] antes de a fila voltar vazia. O original fica onde
    /// está (quem o apaga é o TTL) — leitura nunca destrói evidência.
    pub fn load_queue(&self, now_ms: i64) -> Result<StoredQueue, String> {
        let conn = self.lock();
        let Some((value, expires_at)) = read_row(&conn, QUEUE_KEY)? else {
            return Ok(StoredQueue::default());
        };
        if expires_at <= now_ms {
            conn.execute("DELETE FROM cache WHERE key = ?1", params![QUEUE_KEY])
                .map_err(|err| err.to_string())?;
            return Ok(StoredQueue::default());
        }
        let file = match serde_json::from_str::<QueueFile>(&value) {
            Ok(QueueFile::Current(file)) => *file,
            Ok(QueueFile::Legacy(entries)) => StoredQueueFile {
                entries,
                ..StoredQueueFile::default()
            },
            Err(err) => {
                let problem = format!("fila harvest inválida: {err}");
                match backup_corrupt(&conn, &value, now_ms) {
                    Ok(()) => {
                        eprintln!("[harvest] {problem}; valor cru copiado para {CORRUPT_QUEUE_KEY}")
                    }
                    Err(copy_err) => eprintln!(
                        "[harvest] {problem}; cópia para {CORRUPT_QUEUE_KEY} falhou ({copy_err})"
                    ),
                }
                return Ok(StoredQueue::default());
            }
        };
        Ok(StoredQueue {
            entries: file
                .entries
                .into_iter()
                .map(from_stored)
                .filter(|entry| is_valid_imdb_id(&entry.imdb_id))
                .collect(),
            inflight: file.inflight.and_then(|slot| {
                let entry = from_stored(slot.entry);
                is_valid_imdb_id(&entry.imdb_id).then_some(InflightEntry {
                    entry_id: slot.entry_id,
                    entry,
                    lease: slot.lease,
                })
            }),
            attempts: file.attempts,
            terminal: file
                .terminal
                .into_iter()
                .filter_map(|terminal| {
                    let entry = from_stored(terminal.entry);
                    is_valid_imdb_id(&entry.imdb_id).then_some(TerminalEntry {
                        entry_id: terminal.entry_id,
                        entry,
                        reason: terminal.reason,
                        at_ms: terminal.at_ms,
                    })
                })
                .collect(),
        })
    }

    /// Grava o documento inteiro. Fila E slot vazios → `forget` (o terminal é
    /// só diagnóstico e não segura a chave viva).
    pub fn save_queue(
        &self,
        queue: &StoredQueue,
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        if queue.entries.is_empty() && queue.inflight.is_none() {
            return self.forget_queue();
        }
        let expires_at = now_ms.saturating_add((ttl_seconds as i64).saturating_mul(1000));
        let file = StoredQueueFile {
            entries: queue.entries.iter().cloned().map(to_stored).collect(),
            inflight: queue.inflight.as_ref().map(|slot| StoredInflight {
                entry_id: slot.entry_id.clone(),
                entry: to_stored(slot.entry.clone()),
                lease: slot.lease.clone(),
            }),
            attempts: queue.attempts.clone(),
            terminal: queue
                .terminal
                .iter()
                .map(|terminal| StoredTerminal {
                    entry_id: terminal.entry_id.clone(),
                    entry: to_stored(terminal.entry.clone()),
                    reason: terminal.reason.clone(),
                    at_ms: terminal.at_ms,
                })
                .collect(),
        };
        let encoded = serde_json::to_string(&file).map_err(|err| err.to_string())?;
        let conn = self.lock();
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![QUEUE_KEY, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Só a fila (sem o slot) — atalho de TESTE dos casos antigos.
    #[cfg(test)]
    pub fn load(&self, now_ms: i64) -> Result<Vec<HarvestEntry>, String> {
        Ok(self.load_queue(now_ms)?.entries)
    }

    /// Só a fila (sem o slot) — atalho de TESTE dos casos antigos.
    #[cfg(test)]
    pub fn save(
        &self,
        entries: &[HarvestEntry],
        ttl_seconds: u64,
        now_ms: i64,
    ) -> Result<(), String> {
        let queue = StoredQueue {
            entries: entries.to_vec(),
            ..StoredQueue::default()
        };
        self.save_queue(&queue, ttl_seconds, now_ms)
    }
}
