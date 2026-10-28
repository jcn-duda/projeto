//! Itens do lote `autofetch_batch` e a tradução para [`QueueCandidate`].
//!
//! Separado de `enqueue.rs` pela catraca de linhas e por clareza: aqui só há
//! LEITURA do payload e montagem de valor — nenhuma decisão, nenhum I/O.
//!
//! Os campos internos do pipeline viajam com `_` (contrato do
//! `list_builder/effects.rs` no `adom-search`): `_br`, `_dubbed`, `_quality`,
//! `_size`, `_seeders` e `_seedFloorWaived`. Campo ausente é `false`/`None`,
//! nunca inventado.

use std::collections::BTreeMap;

use adom_autofetch::v3::{CascadeAttempt, CascadePool, Number, QueueCandidate};
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
    fn label(&self) -> String {
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
