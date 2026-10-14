//! Porte de `src/utils/release-index-media.ts`: fonte de mídia (BluRay, WEB-DL,
//! CAM…) para o índice de releases.
//!
//! - `bankRowsForMediaSource` lê o acervo em lote. O TS chama `readEngine()` e
//!   `listMagnetsMany`; aqui isso vira `engine: Option<&dyn Fn(&[String]) ->
//!   Vec<BankRow>>`. `None` é o `readEngine()` nulo (banco desligado), e o
//!   resultado é vazio.
//! - `mergeMediaSource` é puro: `bank_by_hash` é o mapa que o TS recebe pronto.
//!
//! Mapeamento do `MagnetLike`: `magnet`, `MagnetUri`, `Guid`. `prior.mediaSource`
//! vira `prior_media_source` (`None` = `undefined`). O retorno `None` é o
//! `undefined` do TS, ou seja, a fonte é desconhecida.

use std::collections::HashMap;

use crate::magnet_display_name::magnet_display_name;
use crate::release_labels::source_from_title;

/// `MagnetLike` do TS: os campos de `magnetDisplayName` mais o `Guid`.
#[derive(Debug, Clone, Default)]
pub struct MagnetLike {
    pub magnet: Option<String>,
    pub magnet_uri: Option<String>,
    pub guid: Option<String>,
}

/// Linha do acervo: só o que o merge lê (`uri` e `title`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BankRow {
    pub hash: String,
    pub uri: String,
    pub title: String,
}

/// Consulta em lote ao engine do acervo (`listMagnetsMany` do TS).
pub type MagnetLookup<'a> = &'a dyn Fn(&[String]) -> Vec<BankRow>;

/// `bankRowsForMediaSource(lote)`: busca em lote os hashes SEM `dn=` no item.
/// Devolve o mapa `hash -> linha` (vazio sem engine ou sem hash pendente).
pub fn bank_rows_for_media_source(
    lote: &[(MagnetLike, String)],
    engine: Option<MagnetLookup<'_>>,
) -> HashMap<String, BankRow> {
    let mut need: Vec<String> = Vec::new();
    for (item, hash) in lote {
        if !hash.is_empty() && display_of(item).is_empty() {
            need.push(hash.clone());
        }
    }
    let Some(lookup) = engine else {
        return HashMap::new();
    };
    if need.is_empty() {
        return HashMap::new();
    }
    lookup(&need)
        .into_iter()
        .map(|row| (row.hash.clone(), row))
        .collect()
}

/// `mergeMediaSource(item, title, hash, prior, bankByHash)`.
///
/// CAM do magnet/dn vence título limpo. O acervo cobre o item só com
/// infoHash. Merge com `prior`: CAM vence; senão `novo || prior`.
pub fn merge_media_source(
    item: &MagnetLike,
    title: &str,
    hash: &str,
    prior_media_source: Option<&str>,
    bank_by_hash: Option<&HashMap<String, BankRow>>,
) -> Option<String> {
    let title_source = source_from_title(title);
    let mut magnet_dn = display_of(item);
    let mut magnet_source = source_from_title(&magnet_dn);
    if magnet_dn.is_empty() && !hash.is_empty() {
        if let Some(row) = bank_by_hash.and_then(|m| m.get(hash)) {
            magnet_dn = magnet_display_name(Some(row.uri.as_str()), None, None);
            if magnet_dn.is_empty() && !row.title.is_empty() {
                magnet_dn = row.title.clone();
            }
            magnet_source = source_from_title(&magnet_dn);
        }
    }
    let novo = if magnet_source == "CAM" && title_source != "CAM" {
        if magnet_source.is_empty() {
            title_source
        } else {
            magnet_source
        }
    } else if title_source.is_empty() {
        magnet_source
    } else {
        title_source
    };
    let prior = prior_media_source.unwrap_or("");
    let merged = if novo == "CAM" || prior == "CAM" {
        "CAM"
    } else if !novo.is_empty() {
        novo
    } else {
        prior
    };
    if merged.is_empty() {
        None
    } else {
        Some(merged.to_string())
    }
}

/// `magnetDisplayName(item)` com a ordem `magnet || MagnetUri || Guid`.
fn display_of(item: &MagnetLike) -> String {
    magnet_display_name(
        item.magnet.as_deref(),
        item.magnet_uri.as_deref(),
        item.guid.as_deref(),
    )
}
