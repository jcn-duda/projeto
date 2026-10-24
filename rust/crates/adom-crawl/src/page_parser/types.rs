//! Tipos do parser de página do raspador: release crua, grupo por temporada e
//! o resultado estruturado `CrawlPageParsed` (com os construtores `error`/
//! `no_torrent` que o resto do parser usa).

use serde::{Deserialize, Serialize};

use crate::vaca_series::CrawlReleaseItem;

/// Release crua extraída pelo parser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlParsedRelease {
    pub title: String,
    pub magnet: String,
    pub indexer: String,
    pub tracker: String,
    pub is_br: bool,
    pub seeders: i64,
    pub size: Option<String>,
}

impl CrawlReleaseItem for CrawlParsedRelease {
    fn title(&self) -> &str {
        &self.title
    }

    fn magnet_display_name(&self) -> String {
        adom_core::magnet_display_name(Some(&self.magnet), None, None)
    }
}

/// Grupo de releases por temporada/episódio para séries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlParsedGroup {
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub releases: Vec<CrawlParsedRelease>,
}

/// Resultado estruturado do parsing de uma página de obra.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrawlPageParsed {
    pub url: String,
    pub status: String, // "done" | "no-torrent" | "error"
    pub imdb: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub season: Option<i64>,
    pub work_type: Option<String>, // "movie" | "series"
    pub releases: Vec<CrawlParsedRelease>,
    pub groups: Vec<CrawlParsedGroup>,
    pub unlocated: Vec<CrawlParsedRelease>,
    pub error: Option<String>,
}

impl CrawlPageParsed {
    pub fn error(url: &str, msg: &str) -> Self {
        Self {
            url: url.to_string(),
            status: "error".to_string(),
            imdb: None,
            title: None,
            year: None,
            original_title: None,
            season: None,
            work_type: None,
            releases: Vec::new(),
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: Some(msg.to_string()),
        }
    }

    pub fn no_torrent(
        url: &str,
        title: Option<String>,
        year: Option<i64>,
        imdb: Option<String>,
        work_type: Option<String>,
    ) -> Self {
        Self {
            url: url.to_string(),
            status: "no-torrent".to_string(),
            imdb,
            title,
            year,
            original_title: None,
            season: None,
            work_type,
            releases: Vec::new(),
            groups: Vec::new(),
            unlocated: Vec::new(),
            error: None,
        }
    }
}
