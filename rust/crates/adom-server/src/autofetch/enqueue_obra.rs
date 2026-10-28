//! Teto por OBRA do lote do Chupim — porte da fronteira IMPURA de
//! `src/providers/autofetch-obra.ts` (`reserveObra`/`commitObra`/`releaseObra`).
//!
//! O problema que ele fecha é o do TS (`autofetch-obra.ts:3-9`): cada busca
//! decide sozinha quantos downloads disparar, então buscas repetidas da MESMA
//! obra (o Stremio pergunta de novo, passe tardio, outro episódio/pack) não
//! enxergam o que a anterior aceitou e o Chupim enche a conta com o mesmo
//! conteúdo. A vaga é contada por OBRA numa JANELA DESLIZANTE (`autoFetchTtl`),
//! compartilhada entre buscas.
//!
//! Três peças, na ordem de vida do TS:
//!
//! 1. RESERVA (volátil, `ObraReservations`): checagem e tomada da vaga no MESMO
//!    passo — duas buscas concorrentes não ultrapassam o teto. Lease curto (60 s)
//!    que expira sozinho se o enqueue nunca resolver;
//! 2. COMMIT (durável, `ObraStoreV3`): só no ACEITE, dentro do mesmo lock da
//!    reserva — reserva recusada nunca é persistida;
//! 3. RELEASE: recusa/erro do enqueue e portões posteriores (`account-gate`,
//!    `budget`) devolvem a vaga.
//!
//! Pools são contadores SEPARADOS (`br` acompanha `autoFetchMax`, `any` é 1,
//! `seeds` usa `rareMax`/`topSeedsMax`): o teto mora em `adom_core::pool_cap`,
//! a mesma régua que o Node usa — aqui só se lê a config viva.
//!
//! # Divergências declaradas (TS → aqui)
//!
//! - `obras` do TS é estado de MÓDULO; aqui o estado vive no [`ObraGate`]
//!   pendurado nos [`super::Holds`] do laço do worker, que é o
//!   escritor único do enfileiramento. O dreno (`enqueue_drain`) compartilha a
//!   MESMA instância, como o módulo do TS;
//! - `adapter.cacheCheck` (`autofetch-runner.ts:67`) é sempre verdadeiro neste
//!   worker: só chega aqui adaptador que implementa `check` (o pipeline exige);
//! - a identidade NÃO carrega `type` explícito (`type_ = None`): o payload do
//!   lote não traz o tipo canônico, e o núcleo infere `series` pela temporada
//!   declarada — a mesma inferência do `inferType` do TS.

use std::sync::{Mutex, PoisonError};

use adom_autofetch::v3::{
    season_fill_eligible, CascadeAttempt, ObraLeaseV3, ObraReservationInput, ObraReservations,
    ObraStoreV3,
};
use adom_core::{ObraIdentityInput, ObraLiveConfig, ObraRecordEntry, RollbackAction};
use adom_index::NativeKv;
use serde_json::{Map, Value};

use super::gates::LivePolicy;
use super::Holds;
use crate::autofetch::enqueue_items::Item;

/// Config viva do teto por obra, medida em [`LivePolicy`] com os defaults e
/// clamps do TS (`config/debrid.ts:208,215`, `config/debrid-autofetch-seeds.ts:16,27`).
pub(super) fn live_config(live: &LivePolicy) -> ObraLiveConfig {
    ObraLiveConfig {
        auto_fetch_max: live.max_attempts as f64,
        auto_fetch_top_seeds_max: live.top_seeds_max as f64,
        auto_fetch_rare_max: live.rare_max as f64,
        auto_fetch_ttl: live.obra_ttl_seconds as f64,
    }
}

/// Identidade estável da obra para o lote: `adapterId:account:type:imdbId:season:episode`
/// (`obraIdentity`, `autofetch-obra.ts:142`). Sem IMDb válido o núcleo cai no
/// digest do `searchKey`; sem os dois a identidade é degenerada e o teto NÃO se
/// aplica (fail-open, como o gate de conta frio).
///
/// O pack de temporada normaliza o EPISÓDIO para vazio: packs da MESMA
/// temporada dividem a vaga, mesmo anunciados em buscas de E01/E02
/// (`autofetch-runner.ts:67`). A prova de pack é a do título
/// (`isSeasonPackFillEligible`), a MESMA que o preenchimento de temporada usa —
/// não há segunda régua aqui.
pub(super) fn identity(
    adapter: &str,
    account: &str,
    payload: &Map<String, Value>,
    item: &Item,
    season_fill: bool,
) -> ObraIdentityInput {
    let season = payload.get("season").and_then(Value::as_i64);
    let episode = payload.get("episode").and_then(Value::as_i64);
    let is_pack = season_fill && season_fill_eligible(&item.label(), season, true);
    ObraIdentityInput {
        adapter_id: adapter.to_string(),
        account: account.to_string(),
        // `type_` nulo: o lote não carrega o tipo; a temporada declarada é a
        // evidência que sobra (o `inferType` do TS faz o mesmo).
        type_: None,
        imdb_id: text(payload, "imdbId"),
        season: season.map(|value| value as f64),
        episode: if is_pack {
            None
        } else {
            episode.map(|value| value as f64)
        },
        is_pack,
        search_key: text(payload, "searchKey"),
    }
}

fn text(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// Entrada durável do aceite (`commitObra`, `autofetch-obra.ts:324`): o mínimo
/// do F6 — hash, pool, título, classificação de áudio, id e qualidade.
pub(super) fn record_entry(
    attempt: &CascadeAttempt,
    item: &Item,
    transfer_id: Option<&str>,
) -> ObraRecordEntry {
    ObraRecordEntry {
        hash: attempt.info_hash.clone(),
        pool: attempt.pool.as_str().to_string(),
        // O `commit` do store grava o instante do aceite.
        accepted_at: 0.0,
        title: Some(item.label()).filter(|label| !label.is_empty()),
        br: item.br,
        dubbed: item.dubbed,
        id: transfer_id.map(str::to_string),
        quality: attempt.quality.clone(),
        overflow: attempt.overflow,
    }
}

/// Resultado do portão da obra, na ordem do `classifyEnqueue`
/// (`autofetch-gates.ts:57`): os portões ANTERIORES ao teto (marker) nem
/// consultam a reserva; o teto fechado é `Closed`; o concedido carrega o lease.
#[derive(Debug)]
pub(super) enum Gate {
    Granted(ObraLeaseV3),
    Closed,
    /// Portão anterior venceu: a reserva NÃO foi pedida (nada a devolver).
    Skipped,
}

impl Gate {
    pub(super) fn lease(&self) -> Option<&ObraLeaseV3> {
        match self {
            Self::Granted(lease) => Some(lease),
            Self::Closed | Self::Skipped => None,
        }
    }
}

/// Reservas por obra do processo. Serializa acesso como o módulo do TS: a
/// reserva é síncrona, então duas buscas concorrentes enxergam a vaga uma da
/// outra mesmo com `await` no meio do lote.
#[derive(Default)]
pub(in crate::autofetch) struct ObraGate {
    inner: Mutex<ObraReservations>,
}

impl ObraGate {
    fn lock(&self) -> std::sync::MutexGuard<'_, ObraReservations> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `reserveObra` (`autofetch-obra.ts:261`): `Closed` = teto do pool fechado
    /// nesta janela (o chamador desiste e libera o que já adquiriu).
    pub(super) fn reserve(
        &self,
        kv: &NativeKv,
        identity: &ObraIdentityInput,
        cfg: &ObraLiveConfig,
        attempt: &CascadeAttempt,
        now_ms: i64,
    ) -> Result<Gate, String> {
        let store = ObraStoreV3::new(kv);
        let input = ObraReservationInput {
            identity: identity.clone(),
            pool: attempt.pool.as_str().to_string(),
            hash: attempt.info_hash.clone(),
            rare: attempt.rare,
            slot_limit: attempt.slot_limit.map(|value| value as f64),
            quality: attempt.quality.clone(),
        };
        Ok(match self.lock().reserve(&store, &input, cfg, now_ms)? {
            Some(lease) => Gate::Granted(lease),
            None => Gate::Closed,
        })
    }

    /// `commitObra`: grava o registro ANTES de soltar a reserva, para uma falha
    /// do KV não abrir vaga sem registro. O TTL do registro é a JANELA
    /// (`autoFetchTtl`), não o TTL do marker.
    pub(super) fn commit(
        &self,
        kv: &NativeKv,
        lease: &ObraLeaseV3,
        entry: &ObraRecordEntry,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<bool, String> {
        let store = ObraStoreV3::new(kv);
        self.lock()
            .commit(&store, lease, entry, None, ttl_seconds, now_ms)
    }

    /// `releaseObra`: devolve a vaga. Idempotente por desenho (o lease carrega
    /// o próprio id).
    pub(super) fn release(&self, lease: &ObraLeaseV3) {
        self.lock().release(lease);
    }
}

/// `releaseObra` do lote: devolve a vaga do teto da obra. Sem lease (portão
/// anterior venceu ou teto fechado) não há nada a devolver.
pub(super) fn release_obra(holds: &Holds, gate: &Gate) {
    if let Some(lease) = gate.lease() {
        holds.obra().release(lease);
    }
}

/// `commitObra` (`autofetch-obra.ts:324`): só no aceite, e com o TTL da JANELA
/// (`autoFetchTtl`), não com o TTL do marker.
#[allow(clippy::too_many_arguments)]
pub(super) fn commit_obra(
    holds: &Holds,
    kv: &NativeKv,
    gate: &Gate,
    attempt: &CascadeAttempt,
    item: &Item,
    transfer_id: Option<&str>,
    ttl_seconds: i64,
    now_ms: i64,
) -> Result<bool, String> {
    let Some(lease) = gate.lease() else {
        return Ok(false);
    };
    let entry = record_entry(attempt, item, transfer_id);
    holds.obra().commit(kv, lease, &entry, ttl_seconds, now_ms)
}

/// Recusa do SERVIÇO: a vaga da obra e o hold voltam NA HORA
/// (`autofetch-runner.ts:154-156` na recusa, `163-165` no erro; o `budget` da
/// tabela de portões pede o mesmo par, `autofetch-gates.ts:95`). Sem isso o
/// hash fica preso até o fim do lote e uma busca concorrente não o tenta.
pub(super) fn refuse(holds: &Holds, account: &str, hash: &str, gate: &Gate) {
    release_obra(holds, gate);
    holds.release(account, hash);
}

/// Aplica a tabela do `rollbackFor` (`autofetch-gates.ts:73`): só o hold existe
/// neste worker (lock e vaga são do dreno da próxima leva), mas o mapa é lido do
/// núcleo para o motivo `in-flight` continuar NÃO soltando o hold.
pub(super) fn rollback(
    holds: &Holds,
    account: &str,
    hash: &str,
    actions: &[RollbackAction],
    gate: &Gate,
) {
    // A reserva da obra, quando existe, volta SEMPRE: qualquer desistência
    // encerra a tentativa e um lease sem uso ficaria preso 60 s. A tabela do TS
    // só precisa listar `obra` porque lá os portões anteriores ao teto nem
    // tomam a reserva (aqui o `Gate::Skipped` cobre esse recorte).
    release_obra(holds, gate);
    if actions.contains(&RollbackAction::Hold) {
        holds.release(account, hash);
    }
}

#[cfg(test)]
#[path = "enqueue_obra_tests.rs"]
mod tests;
