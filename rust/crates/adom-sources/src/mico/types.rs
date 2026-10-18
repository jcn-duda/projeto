//! Tipos públicos do cliente Mico — alinhados a `src/providers/mico.ts`.

use serde::{Deserialize, Serialize};

/// Argumentos de busca (filme por IMDb; série por IMDb + S/E).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MicoSearchArgs {
    pub media_type: MicoMediaType,
    pub imdb_id: String,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    /// Ano de estreia (só metadado; a captura do banco fica fora desta fatia).
    pub year: Option<i32>,
}

/// Tipo de obra na rota `/stream/{movie|series}/…`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicoMediaType {
    Movie,
    Series,
}

impl MicoMediaType {
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

/// Item cru do addon Mico Leão Dublado.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MicoRawItem {
    pub title: String,
    /// Hash 40-hex em minúsculas.
    pub info_hash: String,
    pub magnet: String,
    pub seeders: f64,
    /// Bytes quando o título informa 💾 com tamanho > 0.
    pub size: Option<f64>,
    /// Sempre `"mico"`.
    pub indexer: String,
    /// `looks_pt_br(title)` ou `(brazil` no título completo.
    pub is_br: bool,
}

/// Resultado do fetch puro (`fetch_streams`) — espelha `{ items, ok }` do TS.
#[derive(Debug, Clone, PartialEq)]
pub struct MicoFetchOutcome {
    pub items: Vec<MicoRawItem>,
    /// `true` só em HTTP 200 (reseta o breaker no `search`).
    pub ok: bool,
}
