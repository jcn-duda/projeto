//! Costura de rede da descoberta: UMA requisição de texto por chamada.
//!
//! O fetch é o MESMO caminho das páginas (`CrawlPageEngine::fetch_crawl_text`):
//! direto primeiro e FlareSolverr só com desafio do Cloudflare, reusando a
//! sessão `cf_clearance` quente. Duplicar o caminho aqui abriria duas políticas
//! de desafio para o mesmo site no mesmo processo.
//!
//! O custo é contado pelo SERVIÇO (uma chamada = uma requisição no teto por
//! hora), como no TS: o solve do FlareSolverr é o mesmo acesso e não soma; a
//! cadeia de redirects também é a mesma chamada.

use std::future::Future;
use std::pin::Pin;

use crate::page_engine::CrawlPageEngine;

/// `Accept` do sitemap: XML na frente, HTML no fim da fila (índice do
/// RedeTorrent e do Vaca pode vir como tabela do visualizador).
pub const ACCEPT_SITEMAP: &str = "application/xml,text/xml,application/xhtml+xml,text/html;q=0.9";

/// Futuro de UMA busca de texto — sem `async_trait`, sem dependência nova.
pub type SitemapFuture<'a> = Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;

/// Quem entrega o corpo de um sitemap (rede no binário, dublê nos testes).
pub trait SitemapFetch: Send + Sync {
    fn fetch<'a>(&'a self, site: &'a str, url: &'a str) -> SitemapFuture<'a>;
}

impl SitemapFetch for CrawlPageEngine {
    fn fetch<'a>(&'a self, site: &'a str, url: &'a str) -> SitemapFuture<'a> {
        Box::pin(async move { self.fetch_crawl_text(site, url, ACCEPT_SITEMAP).await })
    }
}
