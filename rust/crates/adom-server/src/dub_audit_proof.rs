//! Desfecho OK do interrogatório de áudio: grava a PROVA e só invalida a obra
//! quando a prova realmente promove o item.
//!
//! O TS gravava a prova de arquivo dentro do `resolveLink` do adaptador e por
//! isso podia invalidar a lista depois: a próxima busca já nascia `_dubbed`. O
//! play nativo não grava nada, então o claim nunca virava prova, a auditoria
//! repetia o play real a cada busca e invalidava a obra — a lista pronta nunca
//! ficava no `streams.db` (commit descartado pela fence).
//!
//! Três regras fecham o laço:
//! - a prova (`adom_core::play_file_evidence`) é gravada no índice a partir dos
//!   arquivos que o play devolveu;
//! - a obra só é invalidada se a prova traz rótulo dublado (`Dublado`, `Dual`,
//!   `Nacional`) — sem ele a lista seguinte continuaria claim e o laço voltaria;
//! - o candidato provado OK fica numa memória com prazo
//!   (`DEBRID_DUB_AUDIT_OK_TTL_MS`) e não volta a ser interrogado a cada busca.

use std::collections::HashMap;
use std::sync::Mutex;

use adom_core::{play_file_evidence, DebridFile, PlayFileEvidence};
use adom_debrid::play::PlayOutcome;

use super::{now_ms, Candidate, DubAudit};

/// Rótulos que o build trata como prova de dublagem (`is_dub_label`).
fn promotes(evidence: &PlayFileEvidence) -> bool {
    matches!(evidence.audio.as_str(), "Dublado" | "Dual" | "Nacional")
}

/// Memória dos candidatos já provados OK. Chave inclui a conta (o play foi
/// feito com ela) e a locação, como o dedupe da fila.
#[derive(Default)]
pub(crate) struct OkMemory {
    until: Mutex<HashMap<String, i64>>,
}

impl OkMemory {
    fn key(candidate: &Candidate) -> String {
        format!(
            "{}|{}|{}|{:?}|{:?}",
            candidate.adapter,
            adom_core::account_scope(&serde_json::Value::String(candidate.api_key.clone())),
            candidate.hash.to_ascii_lowercase(),
            candidate.season,
            candidate.episode
        )
    }

    pub(crate) fn recent(&self, candidate: &Candidate, now: i64) -> bool {
        let map = self.until.lock().unwrap_or_else(|err| err.into_inner());
        map.get(&Self::key(candidate))
            .is_some_and(|until| *until > now)
    }

    fn remember(&self, candidate: &Candidate, ttl_ms: i64, now: i64) {
        if ttl_ms <= 0 {
            return;
        }
        let mut map = self.until.lock().unwrap_or_else(|err| err.into_inner());
        // Poda no próprio insert: a memória nunca cresce além do vivo.
        map.retain(|_, until| *until > now);
        map.insert(Self::key(candidate), now.saturating_add(ttl_ms));
    }
}

impl DubAudit {
    /// Play OK: grava a prova dos arquivos e decide se a lista precisa nascer
    /// de novo (só quando a prova promove o claim).
    pub(super) fn on_ok(&self, candidate: &Candidate, outcome: &PlayOutcome) {
        let now = now_ms();
        let evidence = outcome.files.as_deref().and_then(|files| {
            let files: Vec<DebridFile> = files
                .iter()
                .map(|file| DebridFile {
                    path: file.path.clone(),
                    size: file.size,
                })
                .collect();
            play_file_evidence(&files)
        });
        if let Some(evidence) = &evidence {
            self.writes
                .mark_file_evidence(&candidate.hash, evidence, now);
        }
        self.ok_memory
            .remember(candidate, self.config.ok_ttl_ms, now);
        let promoted = evidence.as_ref().is_some_and(promotes);
        if candidate.dubbed && candidate.needs_promote && promoted {
            self.invalidate(candidate);
        }
    }
}

#[cfg(test)]
#[path = "dub_audit_proof_tests.rs"]
mod tests;
