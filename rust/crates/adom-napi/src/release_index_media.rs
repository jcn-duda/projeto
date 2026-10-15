//! Sombra da fonte de mídia do índice de releases (`adom-core::release_index_media`).
//!
//! O Node passa as linhas do acervo (`bankByHash`) JÁ LIDAS do SQLite: o Rust
//! não toca no banco, só repete o merge puro (`merge_media_source`). Divergência
//! é métrica e log no lado Node; o valor gravado segue sendo o do TS.

use std::collections::HashMap;

use napi_derive::napi;

/// Linha do acervo: os mesmos campos do `BankRow` do adom-core.
#[napi(object)]
pub struct BankRowNapi {
    pub hash: String,
    pub uri: String,
    pub title: String,
}

/// `mergeMediaSource(item, title, hash, prior, bankByHash)`: fonte de mídia
/// (BluRay/WEB-DL/CAM…) para o índice. CAM do magnet/dn vence título limpo; o
/// acervo cobre o item só com infoHash; merge com prior: CAM vence, senão
/// `novo || prior`. `None` = desconhecida (o `undefined` do TS).
#[napi(catch_unwind)]
pub fn release_index_media_merge(
    magnet: Option<String>,
    magnet_uri: Option<String>,
    guid: Option<String>,
    title: String,
    hash: String,
    prior_media_source: Option<String>,
    bank: Vec<BankRowNapi>,
) -> Option<String> {
    let item = adom_core::MagnetLike {
        magnet,
        magnet_uri,
        guid,
    };
    let by_hash: HashMap<String, adom_core::BankRow> = bank
        .into_iter()
        .map(|row| {
            (
                row.hash.clone(),
                adom_core::BankRow {
                    hash: row.hash,
                    uri: row.uri,
                    title: row.title,
                },
            )
        })
        .collect();
    adom_core::merge_media_source(
        &item,
        &title,
        &hash,
        prior_media_source.as_deref(),
        Some(&by_hash),
    )
}
