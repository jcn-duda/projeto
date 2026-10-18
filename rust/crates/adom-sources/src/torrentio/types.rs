//! Tipos públicos do cliente Torrentio — alinhados a `src/providers/torrentio.ts`.

use serde::{Deserialize, Serialize};

/// Argumentos de busca (filme por IMDb; série por IMDb + S/E).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorrentioSearchArgs {
    pub media_type: TorrentioMediaType,
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

/// Tipo de obra na rota `/stream/{movie|series}/…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TorrentioMediaType {
    Movie,
    Series,
}

impl TorrentioMediaType {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

/// Item cru do pool público Torrentio.
///
/// `file_idx` atravessa o pipeline como no TS (preservado; não consumido no
/// play/HMAC nesta fase). `indexer` é sempre `"torrentio"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TorrentioRawItem {
    pub title: String,
    /// Hash 40-hex em minúsculas.
    pub info_hash: String,
    pub seeders: f64,
    /// Bytes quando a linha de metadados informa tamanho > 0.
    pub size: Option<f64>,
    /// Rótulo depois do ⚙️ na linha de metadados.
    pub tracker: Option<String>,
    /// Sempre `"torrentio"` — identifica o agregador, não o tracker interno.
    pub indexer: String,
    /// `fileIdx` truncado se finito; ausente se NaN/null.
    pub file_idx: Option<i64>,
}
