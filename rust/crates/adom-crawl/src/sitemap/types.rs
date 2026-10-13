//! Tipos base do módulo sitemap.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Tipo da página descoberta (filme ou série).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrawlPageKind {
    Movie,
    TvShow,
}

impl CrawlPageKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::TvShow => "tv_show",
        }
    }
}

/// Um par `<loc>` / `<lastmod>` extraído do sitemap ou do visualizador.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SitemapEntry {
    pub loc: String,
    pub lastmod: String,
}

/// Erro de escopo ou reconhecimento do sitemap (`assertSitemapScope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SitemapScopeError {
    FormatoDesconhecido,
    SemEntradasReconhecidas,
    SemObrasDoEscopo,
}

impl fmt::Display for SitemapScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FormatoDesconhecido => write!(f, "sitemap_formato_desconhecido"),
            Self::SemEntradasReconhecidas => write!(f, "sitemap_sem_entradas_reconhecidas"),
            Self::SemObrasDoEscopo => write!(f, "sitemap_sem_obras_do_escopo"),
        }
    }
}

impl std::error::Error for SitemapScopeError {}

/// Formato da resposta de sitemap (`redetorrent-discovery.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SitemapShape {
    Xml,
    Viewer,
    Unknown,
}

impl SitemapShape {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Xml => "xml",
            Self::Viewer => "viewer",
            Self::Unknown => "unknown",
        }
    }
}

/// Opções de parsing de sitemap.
#[derive(Debug, Clone)]
pub struct SitemapParseOptions {
    /// Se `true`, tenta ler a tabela do visualizador (Yoast do Vaca ou AIOSEO do RedeTorrent)
    /// quando o XML não contiver blocos `<loc>`.
    pub fallback_to_viewer: bool,
    /// Se `true`, valida que a data é válida e zera `0000-00-00`.
    pub validate_date: bool,
}

impl Default for SitemapParseOptions {
    fn default() -> Self {
        Self {
            fallback_to_viewer: true,
            validate_date: true,
        }
    }
}
