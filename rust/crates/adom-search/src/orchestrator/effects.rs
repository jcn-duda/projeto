//! EFEITOS DE CAUDA: o payload de fio do que o `applyDebrid` do Node enfileira
//! hoje (`autofetch`, `rd-warmer`, `dub-audit`, `br-probe`, `harvester`,
//! `season_key`) mais a captura do banco VIVO (`magnet_capture`).
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
//!   `autoFetchCandidates`/`autoFetchBrDubbed` (`debrid-pipeline-core.ts:130,213`);
//! - `magnet_capture` — o lote que a coleta NATIVA viu vai ao
//!   `captureItems` do Node (`magnet-bank.ts:237`): desde o F4.4 o `/stream` é
//!   do gateway e o banco VIVO (`data/magnets.db`) ficava sem o que a busca
//!   nativa viu — o fallback 📦 e a URI rica do play perdiam acervo.
//!
//! Fora desta fatia, com o contrato exato que falta, em
//! `docs/rust-effects-contract.md`: `br_probe` e o `harvester_enqueue` de
//! `miss`/`gap`/`br-gap` da via do índice.

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Map, Value};

use crate::internal_types::EffectEntry;
use crate::list_builder::{AutofetchItem, EffectSeeds, WorkHint};
use crate::raw_item::RawItem;

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

fn entry(kind: &str, payload: Value) -> EffectEntry {
    let payload: Map<String, Value> = payload.as_object().cloned().unwrap_or_default();
    EffectEntry {
        kind: kind.to_string(),
        payload,
    }
}

/// Itens por efeito de captura do acervo vivo.
///
/// O recorte é do TRANSPORTE, não do banco: a rota Node aceita
/// `express.json({limit:'1mb'})` e `MAX_EFFECTS=100` — o gargalo é o tamanho do
/// JSON, então cada efeito carrega no máximo 200 itens (~100 KB).
pub const MAGNET_CAPTURE_CHUNK: usize = 200;

/// Teto de corpo por POST dos efeitos. Abaixo do `limit: '1mb'` da rota com
/// folga para o envelope (`encoded`) e os demais efeitos do lote.
pub const EFFECTS_BODY_MAX_BYTES: usize = 512 * 1024;

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

/// Captura do banco VIVO (`data/magnets.db`): o lote que a coleta NATIVA viu
/// vira `captureItems(items, indexer, ctx)` no Node (`magnet-bank.ts:237`).
///
/// O agrupamento é `indexer || tracker` — é o `_indexer` do build e o que o
/// `inputFromItem` espera (`magnet-bank-merge.ts:240`). O BLUDV publica
/// `indexer: None` + `tracker: "BLUDV"`: mandar o grupo vazio jogaria tudo no
/// balde `all` e a fonte sumiria do acervo.
///
/// `fromAccount` NUNCA entra (guardrail do índice), `fromFallback` é reserva
/// derivada do próprio banco e `fromSnapshot` é a FOTO do índice: nenhum dos
/// três é observação do site e todos se perpetuariam. Item sem hash também não
/// é observação. O corte em [`MAGNET_CAPTURE_CHUNK`] é do transporte: o banco
/// em si aceita o lote inteiro.
pub fn magnet_capture(
    items: &[RawItem],
    imdb_id: &str,
    season: Option<i64>,
    episode: Option<i64>,
    year: &Value,
) -> Vec<EffectEntry> {
    let mut groups: BTreeMap<String, Vec<&RawItem>> = BTreeMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for item in items {
        // A foto do índice não é observação do site: capturá-la faria o
        // `mergeMagnet` do Node renovar `lastSeen` e sobrescrever `seedersLast`
        // com o número da época do índice — o banco passaria a "provar" um
        // frescor que não houve e autoperpetuaria a reserva do índice.
        if item.from_account || item.from_fallback || item.from_snapshot {
            continue;
        }
        let hash = item.bank_hash();
        if hash.is_empty() || !seen.insert(hash) {
            continue;
        }
        groups.entry(capture_group(item)).or_default().push(item);
    }
    let mut out = Vec::new();
    for (group, group_items) in groups {
        for chunk in group_items.chunks(MAGNET_CAPTURE_CHUNK) {
            let wire: Vec<Value> = chunk.iter().map(|item| item.to_wire()).collect();
            out.push(entry(
                "magnet_capture",
                json!({
                    "items": wire,
                    "indexer": group,
                    "imdbId": imdb_id,
                    "season": season,
                    "episode": episode,
                    "year": year,
                    // A captura REGISTRA o que foi visto; reabrir o filtro é
                    // trabalho de outra operação (`markFilterResult`).
                    "resetPassedFilter": false,
                }),
            ));
        }
    }
    out
}

/// Grupo da captura: `indexer || tracker`, minúsculo e cortado como o
/// `inputFromItem` do Node; vazio cai em `all` (o default dele).
fn capture_group(item: &RawItem) -> String {
    let raw = item
        .indexer
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(item
            .tracker
            .as_deref()
            .filter(|value| !value.trim().is_empty()))
        .unwrap_or("");
    let group: String = raw.trim().to_lowercase().chars().take(64).collect();
    if group.is_empty() {
        "all".into()
    } else {
        group
    }
}

/// Teto de EFEITOS por POST — o mesmo `MAX_EFFECTS=100` da rota Node
/// (`src/routes/internal-search-effects.ts`), que responde 400 acima disto.
/// Vale junto com [`EFFECTS_BODY_MAX_BYTES`]: sem este corte, um lote
/// patológico (efeitos minúsculos e muitos) perderia a captura inteira em
/// silêncio, porque a rota recusa o corpo todo.
pub const EFFECTS_PER_BATCH_MAX: usize = 100;

/// Lotes prontos para o POST: dois gargalos da rota, o TAMANHO do corpo
/// (`express.json({limit:'1mb'})`) e a CONTAGEM de efeitos
/// ([`EFFECTS_PER_BATCH_MAX`]). Efeito que sozinho passa do teto de bytes vai
/// sozinho — a rota responde 413 e o tail só loga, como toda falha de efeito.
pub fn batches_for_transport(effects: Vec<EffectEntry>, max_bytes: usize) -> Vec<Vec<EffectEntry>> {
    let mut out: Vec<Vec<EffectEntry>> = Vec::new();
    let mut current: Vec<EffectEntry> = Vec::new();
    let mut bytes = 0usize;
    for effect in effects {
        let size = serde_json::to_vec(&effect)
            .map(|body| body.len())
            .unwrap_or(0);
        if !current.is_empty()
            && (current.len() >= EFFECTS_PER_BATCH_MAX || bytes.saturating_add(size) > max_bytes)
        {
            out.push(std::mem::take(&mut current));
            bytes = 0;
        }
        bytes = bytes.saturating_add(size);
        current.push(effect);
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
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

#[cfg(test)]
#[path = "magnet_capture_tests.rs"]
mod magnet_capture_tests;
