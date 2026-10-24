//! Sonda dirigida BR — porte de `src/providers/br-probe.ts` (ESTADO, sem rede).
//!
//! # Fronteira desta fatia
//!
//! O consumidor TS continua DONO da persistência até a transferência da fila:
//! `autofetch:v3:probe:` e `harvest:v1:q` seguem gravadas por `br-probe.ts` +
//! `harvest-queue.ts`. Aqui só as DECISÕES; nenhum consumidor novo. Invalidar
//! listas prontas e contar métrica continuam no Node — `skipped` volta para
//! quem conta e `mode` é do call site.
//!
//! # Contrato
//!
//! Identidade GLOBAL por obra: `<type>:<imdbId>:<season>:<episode>` (filme sem
//! S/E, série por EPISÓDIO). Só `pending` tem lease (10 min) e SÓ `pending` com
//! lease vivo bloqueia seeds — `found` NÃO bloqueia. `failed`/`capped` têm
//! retry curto (5 min). `pending` vencido é órfão: sai como `failed` e a próxima
//! solicitação reagenda. `pending` só é gravado com trabalho REALMENTE aceito na
//! fila (entrada `br_probe` ou colheita em voo coalescida) — sem isso o worker
//! não executaria o modo dirigido e o aviso congelaria no cache.
//!
//! Tempo entra por `now_ms` (como em [`crate::seen`]): teste simula lease
//! vencido sem dormir nem mexer em relógio global.

use std::fmt::Write as _;

use adom_core::prefix;
use sha2::{Digest, Sha256};

use crate::queue::HarvestQueue;
use crate::reason::{is_valid_imdb_id, obra_identity};
use crate::seen::{mark_recently_queued, was_recently_queued};
use crate::store::HarvestStore;
use crate::types::{
    BrProbeRecord, BrProbeState, BrProbeWork, EnqueueReason, HarvestEntry, HarvestRequest,
    ProbeConfig, ProbeFinal, RequestProbeResult,
};

/// Namespace da chave (`prefix("autofetch")` → `autofetch:v3:`).
pub const PROBE_NAMESPACE: &str = "autofetch";

/// Lease do `pending`. Curto de propósito: crash/restart não pode bloquear
/// seeds para sempre, e é maior que os 60 s de cache da lista que só tem aviso.
pub const PENDING_LEASE_MS: i64 = 10 * 60_000;

/// Retry curto de `failed`/`capped`: não martela a fila e libera os seeds.
pub const RETRY_MS: i64 = 5 * 60_000;

/// TTL do registro (`BR_PROBE_TTL_S`, default do TS: 12 h).
pub const DEFAULT_PROBE_TTL_SECONDS: u64 = 43_200;

/// Identidade GLOBAL por obra — a MESMA string que entra no sha256 da chave.
pub fn probe_identity(work: &BrProbeWork) -> String {
    format!(
        "{}:{}:{}:{}",
        work.media_type.as_str(),
        work.imdb_id,
        work.season.map(|n| n.to_string()).unwrap_or_default(),
        work.episode.map(|n| n.to_string()).unwrap_or_default()
    )
}

/// `probeKey()` do TS: `<prefix>probe:<sha256(identidade)>`.
pub fn probe_key(work: &BrProbeWork) -> String {
    let mut hasher = Sha256::new();
    hasher.update(probe_identity(work).as_bytes());
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(hex, "{byte:02x}");
    }
    format!("{}probe:{hex}", prefix(PROBE_NAMESPACE))
}

/// Sonda dirigida: guarda a config e executa as decisões contra o L2 da colheita.
pub struct BrProbe {
    config: ProbeConfig,
}

impl BrProbe {
    pub fn new(config: ProbeConfig) -> Self {
        Self { config }
    }

    /// Interseção dirigida: index-only ∩ pt-BR, na ordem de `index_only`,
    /// menos os isentos da busca viva — onde mora o dublado titulado em PT.
    pub fn probe_indexers(&self) -> Vec<&str> {
        self.config
            .index_only_indexers
            .iter()
            .filter(|id| self.config.pt_br_indexers.contains(id))
            .filter(|id| !self.config.live_exempt_indexers.contains(id))
            .map(String::as_str)
            .collect()
    }

    /// Sonda operante: índice ativo, toggle ligado e interseção não vazia.
    pub fn enabled(&self) -> bool {
        self.config.release_index_enabled
            && self.config.auto_fetch_br_probe
            && !self.probe_indexers().is_empty()
    }

    fn ineligibility_reason(&self) -> &'static str {
        if !self.config.release_index_enabled {
            return "release-index-off";
        }
        if !self.config.auto_fetch_br_probe {
            return "disabled";
        }
        "no-intersection"
    }

    fn read_record(
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<Option<BrProbeRecord>, String> {
        let Some(raw) = store.get_value(&probe_key(work), now_ms)? else {
            return Ok(None);
        };
        // JSON podre é ausência de registro, nunca um estado inventado.
        Ok(serde_json::from_str(&raw).ok())
    }

    fn write_record(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        record: BrProbeRecord,
        now_ms: i64,
    ) -> Result<(), String> {
        let encoded = serde_json::to_string(&record).map_err(|err| err.to_string())?;
        store.put_value(&probe_key(work), &encoded, self.config.ttl_seconds, now_ms)
    }

    fn write_pending(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<(), String> {
        self.write_record(
            store,
            work,
            BrProbeRecord {
                state: BrProbeState::Pending,
                at: now_ms,
                lease_until: Some(now_ms.saturating_add(PENDING_LEASE_MS)),
            },
            now_ms,
        )
    }

    /// Estado para diagnóstico, leitura QUIET. `None` é o `off` do TS: toggle
    /// desligado, obra inválida ou nenhum registro — nunca inventa estado.
    /// `pending` com lease vencido é órfão e sai como `failed`.
    pub fn state(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<Option<BrProbeState>, String> {
        if !self.enabled() {
            return Ok(None);
        }
        let Some(work) = normalize(work) else {
            return Ok(None);
        };
        let Some(raw) = Self::read_record(store, &work, now_ms)? else {
            return Ok(None);
        };
        if raw.state == BrProbeState::Pending && !is_pending_record(Some(&raw), now_ms) {
            return Ok(Some(BrProbeState::Failed));
        }
        Ok(Some(raw.state))
    }

    /// `pending` com lease vivo — bloqueio TRANSITÓRIO (o que a F1 defere).
    pub fn is_pending(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<bool, String> {
        Ok(self.state(store, work, now_ms)? == Some(BrProbeState::Pending))
    }

    /// O que bloqueia o pool seeds: APENAS `pending` com lease vivo.
    pub fn blocks_seeds(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<bool, String> {
        self.is_pending(store, work, now_ms)
    }

    /// Idade scheduled → run (`autofetch.brProbe.runWaitMs`). `None` sem registro.
    pub fn run_wait_ms(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<Option<i64>, String> {
        let Some(work) = normalize(work) else {
            return Ok(None);
        };
        Ok(Self::read_record(store, &work, now_ms)?.map(|raw| now_ms - raw.at))
    }

    /// Solicita a sonda de uma obra. Nunca bloqueia: é chamada de dentro da
    /// seleção do Chupim e do caminho do índice.
    ///
    /// Só grava `pending` com trabalho realmente aceito na fila. Ordem do TS:
    /// duplicata/promoção e coalescing ANTES do dedupe (pedido forte não é
    /// engolido) e dedupe de 12 h só após o aceite. O `HarvestQueue` do crate
    /// não aplica dedupe — `seen.rs` é do chamador —, então ele entra aqui.
    pub fn request(
        &self,
        store: &HarvestStore,
        queue: &mut HarvestQueue,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<RequestProbeResult, String> {
        let Some(work) = normalize(work) else {
            return Ok(RequestProbeResult::skipped("invalid", false));
        };
        if !self.enabled() {
            return Ok(RequestProbeResult::skipped(
                self.ineligibility_reason(),
                true,
            ));
        }

        let raw = Self::read_record(store, &work, now_ms)?;
        if is_pending_record(raw.as_ref(), now_ms) {
            return Ok(RequestProbeResult::scheduled(Some("pending")));
        }
        if let Some(record) = raw.as_ref() {
            match record.state {
                BrProbeState::Found | BrProbeState::Empty => {
                    return Ok(RequestProbeResult::skipped(record.state.as_str(), false));
                }
                BrProbeState::Failed | BrProbeState::Capped if now_ms - record.at < RETRY_MS => {
                    return Ok(RequestProbeResult::skipped("retry", false));
                }
                _ => {}
            }
        }

        if !queue.is_enabled() {
            return Ok(RequestProbeResult::skipped("disabled", false));
        }

        let dedupe_entry = HarvestEntry {
            imdb_id: work.imdb_id.clone(),
            media_type: work.media_type,
            season: work.season,
            episode: work.episode,
            reason: "br-gap".to_string(),
            enqueued_at: now_ms,
            priority_at: Some(now_ms),
            resumed: false,
            br_probe: true,
            full_base: false,
        };
        let identity = obra_identity(&work.imdb_id, work.season, work.episode);
        let listed = queue
            .find_queued(&work.imdb_id, work.season, work.episode)
            .is_some();
        let in_flight = queue.inflight().is_inflight(&identity);
        // Duplicata/promoção e coalescing vêm antes: só o pedido NOVO passa pelo
        // dedupe (um pedido mais forte não pode ser engolido por um fraco).
        if !listed && !in_flight && was_recently_queued(store, &dedupe_entry, now_ms)? {
            return Ok(RequestProbeResult::skipped("dedupe", false));
        }

        let outcome = queue.enqueue(HarvestRequest {
            imdb_id: work.imdb_id.clone(),
            media_type: work.media_type,
            season: work.season,
            episode: work.episode,
            reason: "br-gap".to_string(),
            br_probe: true,
        });
        if !outcome.accepted {
            return Ok(RequestProbeResult::skipped(outcome.reason.as_str(), false));
        }
        // Dedupe só DEPOIS do aceite, e não na duplicata nem no upgrade de flag
        // de uma entrada já listada (o TS não grava nesses dois).
        let mark_dedupe = match outcome.reason {
            EnqueueReason::Promoted => true,
            EnqueueReason::Queued | EnqueueReason::Coalesced => !listed,
            _ => false,
        };
        if mark_dedupe {
            mark_recently_queued(store, &dedupe_entry, now_ms)?;
        }

        if outcome.reason == EnqueueReason::Coalesced {
            // A execução corrente cobre a sonda; o tick finaliza pelo resultado.
            self.write_pending(store, &work, now_ms)?;
            return Ok(RequestProbeResult::scheduled(Some("inflight")));
        }
        let apto = queue
            .find_queued(&work.imdb_id, work.season, work.episode)
            .is_some_and(|entry| entry.br_probe);
        if !apto {
            // Sem entrada dirigida o worker não executaria o probe: NÃO grava
            // `pending` (o aviso congelaria sem sonda).
            return Ok(RequestProbeResult::skipped(outcome.reason.as_str(), false));
        }
        self.write_pending(store, &work, now_ms)?;
        Ok(RequestProbeResult::scheduled(None))
    }

    /// Estado final, chamado pelo colhedor ao consumir a entrada dirigida.
    /// `false` para obra inválida. A invalidação das listas prontas da obra é do
    /// consumidor Node nesta fatia — inclusive em `empty`/`failed`/`capped`,
    /// para o aviso de `pending` não congelar no cache.
    pub fn finalize(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        state: ProbeFinal,
        now_ms: i64,
    ) -> Result<bool, String> {
        let Some(work) = normalize(work) else {
            return Ok(false);
        };
        self.write_record(
            store,
            &work,
            BrProbeRecord {
                state: state.as_state(),
                at: now_ms,
                lease_until: None,
            },
            now_ms,
        )?;
        Ok(true)
    }

    /// Preempção: a obra volta à fila e será recolhida. Não finaliza — renova o
    /// lease para o aviso/bloqueio não caírem no meio de um retry.
    pub fn note_preempted(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        now_ms: i64,
    ) -> Result<bool, String> {
        let Some(work) = normalize(work) else {
            return Ok(false);
        };
        self.write_pending(store, &work, now_ms)?;
        Ok(true)
    }

    /// Só testes: grava um registro cru (mesma chave derivada da identidade).
    pub fn set_record_for_test(
        &self,
        store: &HarvestStore,
        work: &BrProbeWork,
        record: BrProbeRecord,
        now_ms: i64,
    ) -> Result<(), String> {
        let Some(work) = normalize(work) else {
            return Ok(());
        };
        self.write_record(store, &work, record, now_ms)
    }
}

fn normalize(work: &BrProbeWork) -> Option<BrProbeWork> {
    if !is_valid_imdb_id(&work.imdb_id) {
        return None;
    }
    Some(work.clone())
}

fn is_pending_record(raw: Option<&BrProbeRecord>, now_ms: i64) -> bool {
    raw.is_some_and(|record| {
        record.state == BrProbeState::Pending
            && record.lease_until.is_some_and(|until| until > now_ms)
    })
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
