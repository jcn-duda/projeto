use serde::{Deserialize, Serialize};

/// Botão/link parseado de um post ou página de download.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ResolverLink {
    pub url: String,
    pub quality: Option<u32>,
    pub size: Option<String>,
    pub audio: Option<String>,
    pub episode: Option<u32>,
    pub episode_last: Option<u32>,
    pub season: Option<u32>,
    pub source: Option<String>,
    pub real_title: Option<String>,
    pub description: Option<String>,
}

/// Card de temporada ou batch da página season-internal do VacaTorrent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VacaSeasonCard {
    pub url: String,
    pub is_batch: bool,
    pub season: Option<u32>,
    pub title: String,
}
