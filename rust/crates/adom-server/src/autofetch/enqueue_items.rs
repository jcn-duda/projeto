//! Itens do lote `autofetch_batch` e a tradução para [`QueueCandidate`].
//!
//! Separado de `enqueue.rs` pela catraca de linhas e por clareza: aqui só há
//! LEITURA do payload e montagem de valor — nenhuma decisão, nenhum I/O.
//!
//! Os campos internos do pipeline viajam com `_` (contrato do
//! `list_builder/effects.rs` no `adom-search`): `_br`, `_dubbed`, `_quality`,
//! `_size`, `_seeders` e `_seedFloorWaived`. Campo ausente é `false`/`None`,
//! nunca inventado.

use adom_autofetch::v3::{CascadeAttempt, CascadePool, Number, QueueCandidate};
use serde_json::{Map, Value};

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
    pub(super) waived: bool,
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
            waived: raw
                .get("_seedFloorWaived")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// Pool da cascata: dublado BR → `br`, dublado global → `any`, resto →
    /// `seeds` (o mesmo recorte de `autoFetchCandidates`/`autoFetchBrDubbed`).
    pub(super) fn pool(&self) -> CascadePool {
        if self.br {
            CascadePool::Br
        } else if self.dubbed {
            CascadePool::Any
        } else {
            CascadePool::Seeds
        }
    }
}

/// Itens válidos do lote, na ordem de entrada (a cascata depende dela).
pub(super) fn parse_items(payload: &Map<String, Value>) -> Vec<Item> {
    payload
        .get("items")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Item::parse).collect())
        .unwrap_or_default()
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
        bank_dub: None,
        lied: None,
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
