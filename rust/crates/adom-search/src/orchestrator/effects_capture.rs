//! Captura do banco VIVO (`magnet_capture`): o lote que a coleta NATIVA viu.
//!
//! Separado de `effects.rs` apenas pelo teto de linhas (split mecanico).

use std::collections::{BTreeMap, HashSet};

use serde_json::{json, Value};

use crate::internal_types::EffectEntry;
use crate::raw_item::RawItem;

use super::effects::{entry, MAGNET_CAPTURE_CHUNK};
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
