//! Tipos da descoberta nativa do raspador (fase 6, trilha de SITEMAP).
//!
//! O contrato é o mesmo do `CrawlDiscovery` do TS
//! (`src/providers/crawl-types.ts`), com uma diferença de forma: a completude
//! por kind é explícita em dois `bool` em vez de um objeto opcional. Em Rust
//! não existe a distinção "ausente = legado" — quem monta o relatório sempre
//! sabe dos dois kinds, e um kind sem fonte consultada (séries desligadas) sai
//! `true` de propósito: sem URLs dele o cursor simplesmente não anda.

use crate::sitemap::CrawlPageKind;
use crate::store::ops::UrlRow;
use crate::store::url_key::crawl_url_key;

/// Uma URL descoberta numa rodada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredUrl {
    pub url: String,
    pub lastmod: String,
    pub kind: CrawlPageKind,
}

/// Resultado de UMA rodada de descoberta.
///
/// `complete` é a completude GERAL (todas as fontes responderam); os
/// `complete_*` são POR KIND — o sitemap de filme e o de série falham
/// independentemente, e o cursor de um tipo não pode ser refém da falha do
/// outro (decisão F2 da Fase 7 do TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub urls: Vec<DiscoveredUrl>,
    pub complete: bool,
    pub complete_movie: bool,
    pub complete_tv_show: bool,
    /// Origem de cada falha (`<loc>: <motivo>`), para diagnóstico no painel.
    pub failures: Vec<String>,
    /// Requisições REAIS da rodada (índice + um fetch por post-sitemap).
    /// Sem isto a descoberta entraria de graça no teto por hora, que é de
    /// requisições.
    pub request_cost: u32,
}

impl DiscoveryReport {
    /// Relatório vazio e completo: usado quando não há fonte nenhuma para o
    /// kind (séries desligadas) — não é falha, é ausência declarada.
    pub fn empty_complete() -> Self {
        Self {
            urls: Vec::new(),
            complete: true,
            complete_movie: true,
            complete_tv_show: true,
            failures: Vec::new(),
            request_cost: 0,
        }
    }

    /// Converte o relatório em linhas da fila. A gravação NÃO é `upsert_urls`
    /// (que faz REPLACE e apagaria `status`/`progress` de linha existente):
    /// quem enfileira é `enqueue_discovered`, que aplica a regra do
    /// `decideUpsert` do TS.
    pub fn to_rows(&self, site: &str, now: i64) -> Vec<UrlRow> {
        self.urls
            .iter()
            .map(|u| UrlRow {
                site: site.to_string(),
                url: u.url.clone(),
                url_key: crawl_url_key(&u.url),
                kind: u.kind.as_str().to_string(),
                status: "pending".to_string(),
                lastmod: u.lastmod.clone(),
                imdb: None,
                tries: 0,
                next_at: 0,
                checked_at: 0,
                releases: 0,
                error: String::new(),
                progress: String::new(),
                added_at: now,
            })
            .collect()
    }
}

/// O que a rodada precisa saber do estado durável e da configuração.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryOptions {
    /// Cursor do kind (`None` = carga inicial daquele kind).
    pub since_movie: Option<String>,
    pub since_tv_show: Option<String>,
    /// Séries ligadas no painel (ou modo amostra): sem isto nenhuma URL
    /// `tv_show` é emitida — página de temporada enfileirada como filme é
    /// obra errada no acervo.
    pub emit_series: bool,
}

impl DiscoveryOptions {
    /// Cursor do kind pedido — o mesmo `sinceOf` do adaptador TS.
    pub fn since(&self, kind: CrawlPageKind) -> Option<&str> {
        match kind {
            CrawlPageKind::Movie => self.since_movie.as_deref(),
            CrawlPageKind::TvShow => self.since_tv_show.as_deref(),
        }
    }
}
