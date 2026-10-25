//! Snapshot de evidência BR para o algoritmo de prioridade já existente.
//!
//! O comparador, o ingresso e o preview só lêem esta foto em memória.
//! A leitura do índice acontece fora do lock da fila: uma consulta nativa
//! por identidade, `dubbed` via [`adom_core::has_br_dubbed`] (nunca `len()>0`).
//! Índice ausente devolve foto neutra. `GET /harvest` não passa daqui.

use std::collections::{HashMap, HashSet};

use adom_core::BrGapRelease;
use adom_harvest::{obra_identity, BrEvidence, HarvestEntry, HarvestQueue};
use adom_search::orchestrator::{IndexedReleaseWire, ReleaseIndexSource};

use super::Inner;

#[derive(Clone, Copy, Default)]
struct EvidenceValue {
    present: bool,
    dubbed: bool,
}

/// Foto por `entry_identity`. Identidade ausente = rank neutro.
#[derive(Clone, Default)]
pub(crate) struct EvidenceSnapshot {
    by_identity: HashMap<String, EvidenceValue>,
}

/// Identidade da fila (IMDb + S/E) para uma leitura do índice.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct WorkIdentity {
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

impl WorkIdentity {
    pub(crate) fn from_entry(entry: &HarvestEntry) -> Self {
        Self {
            imdb_id: entry.imdb_id.clone(),
            season: entry.season,
            episode: entry.episode,
        }
    }

    pub(crate) fn key(&self) -> String {
        obra_identity(&self.imdb_id, self.season, self.episode)
    }
}

/// Identidades da fila atual, sem duplicata. Sem lock — o chamador já o tem.
pub(crate) fn queue_identities(queue: &HarvestQueue) -> Vec<WorkIdentity> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for entry in queue.entries() {
        let id = WorkIdentity::from_entry(entry);
        if seen.insert(id.key()) {
            out.push(id);
        }
    }
    out
}

impl EvidenceSnapshot {
    /// Uma leitura por identidade. Sem I/O depois de construída.
    pub(crate) fn from_index(
        index: Option<&dyn ReleaseIndexSource>,
        identities: &[WorkIdentity],
        now_ms: i64,
    ) -> Self {
        let Some(index) = index else {
            return Self::default();
        };
        let mut by_identity = HashMap::new();
        let mut seen = HashSet::new();
        for id in identities {
            let key = id.key();
            if !seen.insert(key.clone()) {
                continue;
            }
            let wires = index.lookup(
                &id.imdb_id,
                id.season.map(i64::from),
                id.episode.map(i64::from),
                now_ms,
            );
            let gaps: Vec<BrGapRelease<'_>> = wires.iter().map(gap_from_wire).collect();
            by_identity.insert(
                key,
                EvidenceValue {
                    present: !wires.is_empty(),
                    dubbed: adom_core::has_br_dubbed(&gaps),
                },
            );
        }
        Self { by_identity }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.by_identity.len()
    }

    /// Foto de teste: os IMDbs listados têm BR dublado no filme raiz.
    #[cfg(test)]
    pub(crate) fn with_dubbed(imdbs: &[&str]) -> Self {
        let mut by_identity = HashMap::new();
        for imdb in imdbs {
            by_identity.insert(
                obra_identity(imdb, None, None),
                EvidenceValue {
                    present: true,
                    dubbed: true,
                },
            );
        }
        Self { by_identity }
    }
}

impl BrEvidence for EvidenceSnapshot {
    fn lookup(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        self.by_identity
            .get(&obra_identity(imdb_id, season, episode))
            .is_some_and(|value| value.present)
    }

    fn has_br_dubbed(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        self.by_identity
            .get(&obra_identity(imdb_id, season, episode))
            .is_some_and(|value| value.dubbed)
    }
}

fn gap_from_wire(release: &IndexedReleaseWire) -> BrGapRelease<'_> {
    BrGapRelease {
        source: release.source.as_deref(),
        is_br: release.is_br,
        dubbed: release.dubbed,
        lied: release.lied,
        quality: release.quality.as_str(),
    }
}

impl Inner {
    /// Cópia da última foto. Nunca chamar com o lock da fila se o chamador
    /// ainda vai esperar este mutex — a ordem é sempre foto → fila.
    pub(crate) fn snapshot(&self) -> EvidenceSnapshot {
        self.evidence
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub(crate) fn replace_snapshot(&self, snap: EvidenceSnapshot) {
        *self.evidence.lock().unwrap_or_else(|err| err.into_inner()) = snap;
    }

    /// Copia identidades (lock curto), solta, lê o índice, guarda a foto.
    /// Nunca segura o lock da fila durante o SQLite.
    pub(crate) async fn refresh_snapshot(&self, now_ms: i64) -> EvidenceSnapshot {
        let identities = {
            let queue = self.queue.lock().await;
            queue_identities(&queue)
        };
        let snap = EvidenceSnapshot::from_index(self.index.as_deref(), &identities, now_ms);
        self.replace_snapshot(snap.clone());
        snap
    }
}

/// Reordena a fila ATUAL com a foto e publica. Sem nova leitura do índice.
pub(crate) fn order_and_publish(
    inner: &Inner,
    queue: &mut HarvestQueue,
    worker: &mut adom_harvest::HarvestWorker,
    snapshot: &EvidenceSnapshot,
    now: i64,
) {
    queue.prioritize(snapshot, now);
    inner.publish(queue, worker, now);
}

#[cfg(test)]
#[path = "evidence_tests.rs"]
mod tests;
