//! Tipos públicos do cliente BLUDV — alinhados a `src/providers/bludv.ts`.

use serde::{Deserialize, Serialize};

/// Card da lista WordPress (`div.post > div.title > a`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BludvPost {
    pub url: String,
    pub title: String,
}

/// Botão de download raspado do post (legado systemads/videosad ou gate).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BludvDownloadLink {
    pub url: String,
    pub label: String,
    /// Texto de tamanho cru ("3.39 GB"); bytes vêm depois de `parse_size`.
    pub size: Option<String>,
    /// `dublado` / `legendado` / `desconhecido`.
    pub audio: String,
}

/// Opções injetáveis na busca (não lê `opts()` global).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BludvSearchOpts {
    /// Filtra botões `legendado` (espelha `opts().dubbedOnly`).
    pub dubbed_only: bool,
}

/// Item cru do scraper BLUDV.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BludvRawItem {
    pub title: String,
    pub magnet: String,
    /// Neutro das fontes BR (site não publica seeds).
    pub seeders: f64,
    pub size: Option<f64>,
    /// Sempre `"BLUDV"`.
    pub tracker: String,
    pub audio: String,
    /// Sempre `true` (origem BR do provider).
    pub is_br: bool,
}
