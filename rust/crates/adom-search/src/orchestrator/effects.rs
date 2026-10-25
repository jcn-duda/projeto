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
//! - `season_key` — LRU de temporadas com pack pronto (`search-cache.ts:70`);
//! - `autofetch_batch` — lote pós-debrid que o Node entrega a
//!   `autoFetchCandidates`/`autoFetchBrDubbed` (`debrid-pipeline-core.ts:130,213`).
//!
//! A captura do banco VIVO NÃO é efeito: desde a T2-L1 ela acontece no próprio
//! processo (`MagnetBankSource::capture_items`, chamada no fim do tail).
//!
//! Fora desta fatia, com o contrato exato que falta, em
//! `docs/rust-effects-contract.md`: `br_probe` e o `harvester_enqueue` de
//! `miss`/`gap`/`br-gap` da via do índice.

use serde_json::{json, Map, Value};

use crate::internal_types::EffectEntry;
use crate::list_builder::{AutofetchItem, EffectSeeds, WorkHint};

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
    /// Veredito de cache do lote (`known` do `applyDebrid`): o autofetch só
    /// despacha com cache conhecido — sem isso o Node libera os holds.
    pub known: bool,
    /// Dica de obra do build (`n`/`y` do `/resolve`).
    pub work: Option<&'a WorkHint>,
}

pub(super) fn entry(kind: &str, payload: Value) -> EffectEntry {
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

/// Lote pós-debrid do Chupim (`debrid-pipeline-core.ts:130-134,213-220`).
///
/// O Node reconstrói os `Stream`s (campos `_*` são internos do pipeline e
/// viajam com o nome do TS) e roda `autoFetchCandidates` + `autoFetchBrDubbed`
/// com o estado que só ele tem: marker/lock/hold, teto por obra, fila
/// persistente, config viva do painel e `debrid.enqueue`. O Rust só entrega os
/// FATOS medidos — nunca decide nem segura hash.
pub fn autofetch_batch(seeds: &EffectSeeds, ctx: &EffectContext<'_>) -> Option<EffectEntry> {
    // Sem adaptador/conta o Node não teria como enfileirar; com o lote vazio
    // (busca sem stream com hash) também não há o que selecionar.
    if seeds.autofetch.is_empty() || ctx.adapter_id.is_empty() || ctx.api_key.is_empty() {
        return None;
    }
    let items: Vec<Value> = seeds.autofetch.iter().map(item_json).collect();
    let payload = json!({
        "items": items,
        "cached": seeds.cached,
        "known": ctx.known,
        "season": ctx.season,
        "episode": ctx.episode,
        "imdbId": if ctx.imdb_id.is_empty() { Value::Null } else { json!(ctx.imdb_id) },
        "searchKey": ctx.search_key,
    });
    Some(entry("autofetch_batch", payload))
}

/// Um item do lote: `infoHash`/`title`/`name` + os campos `_*` que
/// `autoFetchCandidates`/`autoFetchBrDubbed` consomem. Campo ausente é omitido
/// (o Node trata `undefined` como sempre: `Boolean(undefined)` etc.).
fn item_json(item: &AutofetchItem) -> Value {
    let mut out = Map::new();
    out.insert("infoHash".into(), json!(item.hash));
    out.insert("title".into(), json!(item.title));
    out.insert("name".into(), json!(item.name));
    out.insert("_br".into(), json!(item.br));
    out.insert("_dubbed".into(), json!(item.dubbed));
    out.insert("_dubClaim".into(), json!(item.dub_claim));
    out.insert("_fromFallback".into(), json!(item.from_fallback));
    out.insert("_fallbackFetchable".into(), json!(item.fallback_fetchable));
    out.insert("_seedFloorWaived".into(), json!(item.seed_floor_waived));
    out.insert("_multiWorkAdmitted".into(), json!(item.multi_work_admitted));
    out.insert("_bankDub".into(), json!(item.bank_dub));
    out.insert("_lied".into(), json!(item.lied));
    if let Some(seeders) = item.seeders {
        out.insert("_seeders".into(), json!(seeders));
    }
    if let Some(quality) = &item.quality {
        out.insert("_quality".into(), json!(quality));
    }
    if let Some(size) = item.size {
        out.insert("_size".into(), json!(size));
    }
    if let Some(pack_bytes) = item.pack_bytes {
        out.insert("_packBytes".into(), json!(pack_bytes));
    }
    if let Some(indexer) = &item.indexer {
        out.insert("_indexer".into(), json!(indexer));
    }
    if let Some(tracker) = &item.tracker {
        out.insert("_tracker".into(), json!(tracker));
    }
    Value::Object(out)
}

/// Lote da resposta/tail: `autofetch_batch` + `dub_audit` + `rd_warmer` do lote
/// pós-debrid.
pub fn build_effects(seeds: &EffectSeeds, ctx: &EffectContext<'_>) -> Vec<EffectEntry> {
    let mut out = Vec::new();
    if let Some(effect) = autofetch_batch(seeds, ctx) {
        out.push(effect);
    }
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
