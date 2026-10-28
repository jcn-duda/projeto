//! Itens do lote `autofetch_batch` e a tradução para [`QueueCandidate`].
//!
//! Separado de `enqueue.rs` pela catraca de linhas e por clareza: aqui só há
//! LEITURA do payload e montagem de valor — nenhuma decisão, nenhum I/O.
//!
//! Os campos internos do pipeline viajam com `_` (contrato do
//! `list_builder/effects.rs` no `adom-search`): `_br`, `_dubbed`, `_quality`,
//! `_size`, `_seeders`, `_seedFloorWaived`, `_rare` e `_slotLimit`. Campo
//! ausente é `false`/`None`, nunca inventado.
//!
//! # Fronteira do `rare` (TS → nativo)
//!
//! `rare` e `slotLimit` NASCEM no build: `pickSeedsPool` decide o regime raro e
//! devolve `{ rare, slotLimit }` em todo candidato do pool `seeds`
//! (`src/providers/autofetch-candidates.ts:268,296`,
//! `src/providers/autofetch-seeds-pool.ts:174,190`). O worker do Node só
//! TRANSPORTA o par até `tryObraCap` (`autofetch-runner.ts:82`); o teto que ele
//! aplica vem de `rare` (`poolCap`, `autofetch-obra.ts:161`) e `slotLimit` é a
//! vaga por busca. Aqui o worker faz o mesmo: quando o lote JÁ traz `_rare`
//! (`rare_decided`), ele é lido e não recalculado — recalculá-lo seria uma
//! SEGUNDA régua de um fato que veio decidido. Quando o lote NÃO traz (o caso
//! do lote nativo: `orchestrator/effects.rs` não emite esses dois campos), a
//! decisão sai de [`seeds_pick`], a Mesma régua `pickSeedsPool` do núcleo
//! (`adom_core::pick_seeds_pool`).

use std::collections::{BTreeMap, HashSet};

use adom_autofetch::v3::{CascadeAttempt, CascadePool, Number, QueueCandidate};
use adom_core::{pick_seeds_pool, PoolStream, RareConfig, SeedsPickLive, SeedsPickOpts};
use serde_json::{Map, Value};

use super::season_fill::SeasonHint;

/// Item do lote, já normalizado (só o que a cascata e a fila leem).
#[derive(Debug, Clone)]
pub(super) struct Item {
    pub(super) info_hash: String,
    pub(super) title: Option<String>,
    pub(super) name: Option<String>,
    pub(super) quality: Option<String>,
    pub(super) size: Option<i64>,
    pub(super) seeders: Option<i64>,
    pub(super) br: bool,
    pub(super) dubbed: bool,
    pub(super) dub_claim: bool,
    pub(super) bank_dub: bool,
    pub(super) lied: bool,
    pub(super) from_fallback: bool,
    pub(super) fallback_fetchable: bool,
    pub(super) multi_work_admitted: bool,
    pub(super) waived: bool,
    /// Candidato do regime RARO do pool `seeds` (`rare` em
    /// `autofetch-candidates.ts:40`). Decide entre `rareMax` e `topSeedsMax` no
    /// teto por obra (`autofetch-obra.ts:161`) e nos slots do lote.
    pub(super) rare: bool,
    /// O lote DECIDIU o `rare` (`_rare` presente). Sem isso, `rare` é `false`
    /// por omissão e quem decide é [`seeds_pick`].
    pub(super) rare_decided: bool,
    /// `slotLimit` do pool que decidiu o candidato
    /// (`autofetch-candidates.ts:281`): quantas vagas a BUSCA pode gastar com
    /// ele. `None` = pool sem regime de vaga (o teto do lote manda).
    pub(super) slot_limit: Option<i64>,
}

impl Item {
    fn parse(raw: &Value) -> Option<Self> {
        let info_hash = raw.get("infoHash")?.as_str()?.to_ascii_lowercase();
        if info_hash.is_empty() {
            return None;
        }
        let text = |key: &str| raw.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            info_hash,
            title: text("title"),
            name: text("name"),
            quality: text("_quality"),
            size: raw.get("_size").and_then(Value::as_i64),
            seeders: raw.get("_seeders").and_then(Value::as_i64),
            br: raw.get("_br").and_then(Value::as_bool).unwrap_or(false),
            dubbed: raw.get("_dubbed").and_then(Value::as_bool).unwrap_or(false),
            dub_claim: raw
                .get("_dubClaim")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            bank_dub: raw
                .get("_bankDub")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            lied: raw.get("_lied").and_then(Value::as_bool).unwrap_or(false),
            from_fallback: raw
                .get("_fromFallback")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            fallback_fetchable: raw
                .get("_fallbackFetchable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            multi_work_admitted: raw
                .get("_multiWorkAdmitted")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            waived: raw
                .get("_seedFloorWaived")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            rare: raw.get("_rare").and_then(Value::as_bool).unwrap_or(false),
            rare_decided: raw.get("_rare").and_then(Value::as_bool).is_some(),
            slot_limit: raw.get("_slotLimit").and_then(Value::as_i64),
        })
    }

    /// Pool da cascata: dublado BR → `br`, dublado global → `any`, resto →
    /// `seeds` (o mesmo recorte de `autoFetchCandidates`/`autoFetchBrDubbed`).
    pub(super) fn pool(&self) -> CascadePool {
        if self.is_br_dubbed_proven() {
            CascadePool::Br
        } else if self.dubbed && !self.lied {
            CascadePool::Any
        } else {
            CascadePool::Seeds
        }
    }

    /// Mesmo predicado de retenção BR do runner TS: origem BR e prova positiva
    /// (`_dubbed`, `_dubClaim` ou `_bankDub`), sem contradição `_lied`.
    pub(super) fn is_br_dubbed_proven(&self) -> bool {
        self.br && (self.dubbed || self.dub_claim || self.bank_dub) && !self.lied
    }

    /// Título do release: `stream.title || stream.name || ''` do TS. Título
    /// vazio cai para o `name` (é o rótulo que o pack prova a temporada).
    pub(super) fn label(&self) -> String {
        let usable = |value: &Option<String>| value.clone().filter(|text| !text.trim().is_empty());
        usable(&self.title)
            .or_else(|| usable(&self.name))
            .unwrap_or_default()
    }
}

/// Itens válidos do lote, na ordem de entrada (a cascata depende dela).
pub(super) fn parse_items(payload: &Map<String, Value>) -> Vec<Item> {
    payload
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Item::parse)
                // Mesmo filtro do `autofetch_items`: packs multiobra nunca
                // entram no Chupim e fallback só entra quando é fetchable.
                .filter(|item| !item.multi_work_admitted)
                .filter(|item| !item.from_fallback || item.fallback_fetchable)
                .collect()
        })
        .unwrap_or_default()
}

/// Fatos do PACK por hash para o lote do recheck: IMDb e temporada declarados
/// pelo pedido mais o título do release.
///
/// `is_pack` NÃO nasce aqui: o TS o deriva do TÍTULO no momento do aceite
/// (`isSeasonPackFillEligible(stream, season ?? null)`,
/// `autofetch-runner.ts:66`) e o gateway aplica a MESMA régua no preenchimento,
/// com o título já persistido. Persistir um booleano aqui seria uma segunda
/// régua para a mesma pergunta.
///
/// Sem IMDb ou sem temporada declarada não existe chave de temporada: o mapa
/// sai vazio em vez de guardar fato inútil.
pub(super) fn season_hints(
    items: &[Item],
    payload: &Map<String, Value>,
) -> BTreeMap<String, SeasonHint> {
    let imdb_id = payload
        .get("imdbId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let season = payload.get("season").and_then(Value::as_i64);
    let (Some(imdb_id), Some(season)) = (imdb_id, season) else {
        return BTreeMap::new();
    };
    items
        .iter()
        .map(|item| {
            (
                item.info_hash.clone(),
                SeasonHint {
                    imdb_id: Some(imdb_id.clone()),
                    season: Some(season),
                    title: item.label(),
                },
            )
        })
        .collect()
}

/// Traduz a tentativa da cascata para o payload PERSISTIDO da fila. O item é a
/// fonte dos fatos (título, tamanho, seeders); a tentativa é a fonte do pool, da
/// qualidade e do `slotLimit`.
pub(super) fn candidate_of(
    attempt: &CascadeAttempt,
    item: &Item,
    payload: &Map<String, Value>,
    now_ms: i64,
) -> QueueCandidate {
    let season = payload.get("season").and_then(Value::as_i64);
    let episode = payload.get("episode").and_then(Value::as_i64);
    QueueCandidate {
        probe_season: season.map(Number::from_i64),
        probe_episode: episode.map(Number::from_i64),
        info_hash: attempt.info_hash.clone(),
        name: item.name.clone(),
        title: item.title.clone(),
        quality: attempt.quality.clone(),
        size: item.size.map(Number::from_i64),
        seeders: item.seeders.map(Number::from_i64),
        br: Some(item.br),
        dubbed: Some(item.dubbed),
        bank_dub: Some(item.bank_dub),
        lied: Some(item.lied),
        pool: Some(attempt.pool.as_str().to_string()),
        imdb_id: payload
            .get("imdbId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        season: season.map(Number::from_i64),
        episode: episode.map(Number::from_i64),
        is_pack: None,
        rare: attempt.rare.then_some(true),
        slot_limit: attempt.slot_limit.map(Number::from_i64),
        // `addedAt` nasce agora; o `write_queue` preserva o que já existia.
        added_at: Some(Number::from_i64(now_ms)),
        extra: std::collections::BTreeMap::new(),
    }
}

/// Config viva do pool `seeds`, medida em [`super::gates::LivePolicy`] com os
/// mesmos defaults/clamps do TS (`src/config/debrid-autofetch-seeds.ts:19,28,29,34`
/// + `src/utils/autofetch-live.ts:113-122`).
pub(super) struct SeedsKnobs {
    pub(super) min_seeders: i64,
    pub(super) top_seeds_max: i64,
    pub(super) pt_first: bool,
    pub(super) rare_max: i64,
    pub(super) rare_threshold: i64,
    pub(super) rare_max_seeders: i64,
    pub(super) queue_depth: i64,
}

/// Resultado do pool `seeds`: quem entra, em que ordem, o regime raro e o teto
/// imediato.
pub(super) struct SeedsPool {
    /// Hashes (minúsculos) selecionados NA ORDEM do pick — melhor swarm/PT
    /// primeiro, como o TS enfileira. O resto do pool `seeds` NÃO é candidato
    /// (o `pickSeedsPool` nem o devolve).
    pub(super) ranked: Vec<String>,
    /// Regime raro ativo: poucos candidatos viáveis E fracos
    /// (`autofetch-seeds-pool.ts:112`).
    pub(super) rare: bool,
    /// Teto imediato efetivo (`rareMax` no raro, `topSeedsMax` no normal).
    pub(super) immediate_limit: i64,
}

/// `pickSeedsPool` (`src/providers/autofetch-seeds-pool.ts:58-143`) sobre o lote.
///
/// Delega ao núcleo (`adom_core::pick_seeds_pool`) a MESMA régua que o bridge
/// do Node usa: ordenação por pack → PT → swarm (`topSeededPool`), piso de
/// `minSeeders` com o complemento relaxado, e o regime RARO por
/// `rareThreshold`/`rareMaxSeeders`. Nada de filtro próprio aqui.
///
/// A ORDEM devolvida é a do pick (melhor swarm primeiro): o TS enfileira nessa
/// ordem, e é ela que decide quem ocupa a vaga imediata quando há mais viáveis
/// que `topSeedsMax`.
pub(super) fn seeds_pick(items: &[&Item], knobs: &SeedsKnobs, season: Option<i64>) -> SeedsPool {
    // Só o pool `seeds` entra no pick (`isSeedsStream`/`topSeededPool` no TS).
    let streams: Vec<PoolStream> = items
        .iter()
        .filter(|item| item.pool() == CascadePool::Seeds)
        .map(|item| stream_of(item))
        .collect();
    // Viabilidade = NÃO-waived. O waiver do piso existe para o item alcançar a
    // CHECAGEM, não para o Chupim baixar o que ninguém semeia
    // (`autofetch-candidates.ts:128-143`).
    let viable: HashSet<String> = items
        .iter()
        .filter(|item| !item.waived)
        .map(|item| item.info_hash.clone())
        .collect();
    let live = SeedsPickLive {
        min_seeders: knobs.min_seeders,
        top_seeds_max: knobs.top_seeds_max,
        pt_first: knobs.pt_first,
    };
    let opts = SeedsPickOpts {
        season,
        queue_depth: knobs.queue_depth,
        rare: RareConfig {
            max: knobs.rare_max,
            threshold: knobs.rare_threshold,
            max_seeders: knobs.rare_max_seeders,
        },
    };
    let picked = pick_seeds_pool(&streams, &live, &opts, &viable);
    SeedsPool {
        ranked: picked
            .candidates
            .iter()
            .filter_map(|&index| streams[index].info_hash.as_deref())
            .map(str::to_lowercase)
            .collect(),
        rare: picked.rare_used,
        immediate_limit: picked.immediate_limit,
    }
}

/// Tradução `Item` → `PoolStream`: os mesmos fatos que o bridge do Node passa
/// ao núcleo, sem inventar campo.
fn stream_of(item: &Item) -> PoolStream {
    PoolStream {
        info_hash: Some(item.info_hash.clone()),
        title: item.title.clone(),
        name: item.name.clone(),
        quality: item.quality.clone(),
        seeders: item.seeders,
        is_br: item.br,
        is_dubbed: item.dubbed,
        is_dub_claim: item.dub_claim,
        is_bank_dub: item.bank_dub,
        is_lied: item.lied,
        from_fallback: item.from_fallback,
        fallback_fetchable: item.fallback_fetchable,
    }
}
