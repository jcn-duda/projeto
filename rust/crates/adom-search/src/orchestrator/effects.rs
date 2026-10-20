//! EFEITOS DE CAUDA: o payload de fio do que o `applyDebrid` do Node enfileira
//! hoje (`autofetch`, `rd-warmer`, `dub-audit`, `br-probe`, `harvester`,
//! `season_key`).
//!
//! O transporte é a rota interna `POST /internal/search/effects` (202,
//! fire-and-forget) e os `kind`s são os que `src/routes/internal-search-effects.ts`
//! valida. Este módulo só MONTA o payload; a seleção dos candidatos mora no
//! build (`list_builder::effects`) e o ENFILEIRAMENTO (marker, fila, dedupe,
//! kill-switch de cada subsistema) continua no Node — o mesmo desenho do
//! `index-write`.
//!
//! Cobertos nesta fatia (dados que o orquestrador nativo já tem):
//!
//! - `dub_audit` — `queueDubAudit(adapter.id, apiKey, collectAuditCandidates(…), searchKey)`
//!   (`debrid-pipeline-core.ts:311,382`);
//! - `rd_warmer` — `queueRdWarmForRelevant` com as releases dos três tiers
//!   (`debrid-pipeline-core.ts:221-243`);
//! - `harvester_enqueue` — episódio seguinte de série assistida
//!   (`search-orchestrator.ts:315`);
//! - `season_key` — LRU de temporadas com pack pronto (`search-cache.ts:70`).
//!
//! Fora desta fatia, com o contrato exato que falta, em
//! `docs/rust-effects-contract.md`: `autofetch`, `br_probe` e o
//! `harvester_enqueue` de `miss`/`gap`/`br-gap` da via do índice.

use serde_json::{json, Map, Value};

use crate::internal_types::EffectEntry;
use crate::list_builder::{EffectSeeds, WorkHint};

/// Fatos da requisição que os payloads carregam (nunca segredo em log).
#[derive(Debug, Clone)]
pub struct EffectContext<'a> {
    /// `adapter.id` do debrid em uso (`debridService` das opções efetivas).
    pub adapter_id: &'a str,
    /// Chave da CONTA do usuário — a mesma que o `applyDebrid` passa ao
    /// `queueDubAudit`. Vai no corpo da rota interna (loopback + token).
    pub api_key: &'a str,
    pub imdb_id: &'a str,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Chave de cache da busca (`input.key`): vira `searchKey` do interrogatório.
    pub search_key: &'a str,
    /// Dica de obra do build (`n`/`y` do `/resolve`).
    pub work: Option<&'a WorkHint>,
}

fn entry(kind: &str, payload: Value) -> EffectEntry {
    let payload: Map<String, Value> = payload.as_object().cloned().unwrap_or_default();
    EffectEntry {
        kind: kind.to_string(),
        payload,
    }
}

/// `collectAuditCandidates` + `queueDubAudit` (`debrid-pipeline-core.ts:311,382`).
pub fn dub_audit(seeds: &EffectSeeds, ctx: &EffectContext<'_>) -> Option<EffectEntry> {
    // Sem candidato ou sem conta/adaptador o Node não teria como drenar a fila.
    if seeds.audit.is_empty() || ctx.adapter_id.is_empty() || ctx.api_key.is_empty() {
        return None;
    }
    let imdb = if ctx.imdb_id.is_empty() {
        Value::Null
    } else {
        Value::String(ctx.imdb_id.to_string())
    };
    let candidates: Vec<Value> = seeds
        .audit
        .iter()
        .map(|candidate| {
            let work = match ctx.work {
                Some(work) => json!({
                    "names": work.names,
                    "year": work.year,
                    "pack": candidate.pack,
                }),
                None => Value::Null,
            };
            json!({
                "hash": candidate.hash,
                "season": ctx.season,
                "episode": ctx.episode,
                "imdbId": imdb.clone(),
                "work": work,
                "dubbed": candidate.dubbed,
                "needsPromote": candidate.needs_promote,
            })
        })
        .collect();
    let mut payload = Map::new();
    payload.insert("adapter_id".into(), json!(ctx.adapter_id));
    payload.insert("api_key".into(), json!(ctx.api_key));
    payload.insert("candidates".into(), Value::Array(candidates));
    payload.insert("search_key".into(), json!(ctx.search_key));
    Some(EffectEntry {
        kind: "dub_audit".into(),
        payload,
    })
}

/// `rdWarmer.enqueue` dos três tiers (`debrid-pipeline-core.ts:221-243`).
///
/// O Node re-pontua (80/40/5) e corta em 10 hashes em `queueRdWarmForRelevant`:
/// o payload leva os hashes escolhidos, não o score — mesma rota do colhedor.
pub fn rd_warmer(seeds: &EffectSeeds) -> Option<EffectEntry> {
    if seeds.warmer.is_empty() {
        return None;
    }
    let releases: Vec<Value> = seeds
        .warmer
        .iter()
        .map(|seed| {
            json!({
                "title": seed.title,
                "infoHash": seed.hash,
                "isBr": seed.is_br,
                "dubbed": seed.dubbed,
            })
        })
        .collect();
    Some(entry("rd_warmer", json!({ "releases": releases })))
}

/// Episódio seguinte de série com play de verdade
/// (`search-orchestrator.ts:312-316`). O `harvester.enqueue` do Node valida
/// `releaseIndex.enabled`/dedupe/teto — aqui não se repete config do operador.
pub fn harvester_next_episode(
    kind: &str,
    imdb_id: &str,
    season: Option<i64>,
    episode: Option<i64>,
    playable: bool,
) -> Option<EffectEntry> {
    if !playable || kind != "series" || !imdb_id.starts_with("tt") {
        return None;
    }
    // Só série com S/E no id: o `season`/`episode` do meta é o do pedido.
    let (season, episode) = (season?, episode?);
    Some(entry(
        "harvester_enqueue",
        json!({
            "imdbId": imdb_id,
            "type": "series",
            "season": season,
            "episode": episode.saturating_add(1),
            "reason": "next-episode",
        }),
    ))
}

/// LRU de temporadas com pack pronto (`search-cache.ts:66-72`). O Node decide
/// pelo `autoFetchSeasonFill`/teto do índice; aqui só viajam os fatos.
pub fn season_key(
    service: &str,
    api_key: &str,
    imdb_id: &str,
    season: i64,
    cache_key: &str,
) -> Option<EffectEntry> {
    if service.is_empty() || api_key.is_empty() || cache_key.is_empty() {
        return None;
    }
    if !imdb_id.starts_with("tt") || season <= 0 {
        return None;
    }
    // `accountScope(apiKey)`: digest SHA-256 hex — a chave crua não vira chave.
    let account = adom_core::account_scope(&Value::String(api_key.to_string()));
    if account == "none" {
        return None;
    }
    Some(entry(
        "season_key",
        json!({
            "adapter_id": service,
            "account": account,
            "imdb": imdb_id,
            "season": season,
            "cache_key": cache_key,
        }),
    ))
}

/// Lote da resposta/tail: `dub_audit` + `rd_warmer` do lote pós-debrid.
pub fn build_effects(seeds: &EffectSeeds, ctx: &EffectContext<'_>) -> Vec<EffectEntry> {
    let mut out = Vec::new();
    if let Some(effect) = dub_audit(seeds, ctx) {
        out.push(effect);
    }
    if let Some(effect) = rd_warmer(seeds) {
        out.push(effect);
    }
    out
}

#[cfg(test)]
#[path = "effects_tests.rs"]
mod effects_tests;
