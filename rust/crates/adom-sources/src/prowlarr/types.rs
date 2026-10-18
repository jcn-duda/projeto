//! Tipos públicos do cliente Prowlarr — alinhados ao `map` de
//! `src/providers/prowlarr.ts`.

use serde::{Deserialize, Serialize};

/// Item cru devolvido por [`crate::prowlarr::ProwlarrClient::search`].
///
/// Campos batem com o objeto que o TS monta: title, magnet, infoHash, seeders,
/// size, tracker. O collect Rust ainda não consome isto (próxima fatia).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProwlarrRawItem {
    pub title: String,
    /// `magnetUrl` || `guid` || `downloadUrl`.
    pub magnet: Option<String>,
    pub info_hash: Option<String>,
    pub seeders: Option<f64>,
    pub size: Option<f64>,
    /// `indexer` || `indexerId` do payload.
    pub tracker: Option<String>,
}
