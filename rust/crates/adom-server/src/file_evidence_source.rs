//! Fonte de produção da prova de arquivo (`idx:v14:file:<hash>`) para o build
//! do `/stream`: o `applyFileEvidence` do Node, lido do índice nativo.
//!
//! Quem grava a prova é o play (`play_effects_native`) e a auditoria de
//! dublagem; sem esta leitura o build não a via, e o claim de dublagem nunca
//! virava prova (o laço auditoria → invalidação → busca sem cache).

use std::collections::BTreeMap;

use adom_search::orchestrator::{FileEvidenceSource, ProvenFile};
use adom_store::ReleaseIndexStore;

pub(crate) struct NativeFileEvidence {
    index: ReleaseIndexStore,
}

impl NativeFileEvidence {
    /// Mesmo `cache.db` e mesmos limites do índice do `/stream`.
    pub(crate) fn open(ttl_seconds: u64, max_releases: usize) -> Result<Self, String> {
        let path = adom_store::default_cache_db_path();
        let index = ReleaseIndexStore::open(&path)?.with_limits(ttl_seconds, max_releases);
        Ok(Self { index })
    }
}

impl FileEvidenceSource for NativeFileEvidence {
    fn evidence_for(&self, hashes: &[String]) -> BTreeMap<String, ProvenFile> {
        let now = adom_sources::now_ms();
        hashes
            .iter()
            .filter_map(|hash| {
                let ev = self.index.file_evidence(hash, now)?;
                Some((
                    hash.to_lowercase(),
                    ProvenFile {
                        audio: ev.a,
                        en: ev.e.unwrap_or(0) != 0,
                        quality: ev.q,
                        name: ev.n,
                    },
                ))
            })
            .collect()
    }
}
