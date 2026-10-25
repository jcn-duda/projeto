//! Leitura de UMA página da listagem de um site (fetch + parser + host).
//!
//! Porte do `readListing` do `hdrtorrents.ts` / `apachetorrent.ts`. É a única
//! parte da caminhada que conhece HTML: [`walk_listing`](crate::listing::walk)
//! recebe só `posts`, `card_count` e `recognized_count`.
//!
//! Dois números diferentes, e trocá-los custa a cobertura do acervo:
//!
//! - `card_count` são os cards BRUTOS do HTML (antes de qualquer filtro) — é a
//!   régua do fim do catálogo;
//! - `recognized_count` são os cards que o PARSER reconheceu (já sem taxonomia,
//!   link externo e duplicata do próprio card), antes do filtro de host.
//!
//! O host é recusado AQUI, com a allowlist viva do perfil: a regra pura resolve
//! a URL absoluta, mas não conhece os domínios do site.
//!
//! Failover de domínio: o perfil guarda os hosts candidatos, e o caminho da
//! listagem é o mesmo em todos eles (`/pagina/N/`). O host ativo fica memoizado
//! na instância; uma falha faz UMA tentativa nos demais e rememoiza. Enquanto o
//! host ativo responde, cada página custa um request só — o custo da troca não
//! é contado pelo caminhador, e é por isso que ela é mantida rara.

use std::sync::{Arc, Mutex};

use crate::discovery::fetch::SitemapFetch;
use crate::discovery::listing::config::ListingFlavor;
use crate::listing::walk::{ListingPageFuture, ListingPageReader};
use crate::listing::{
    apache_count_listing_cards, apache_parse_listing_cards, hdr_count_listing_cards,
    hdr_parse_listing_cards, ListingPageRead, ListingPost,
};
use crate::net::allowlist::Allowlist;

/// `Accept` de uma página de listagem (HTML; XML no fim da fila para o site que
/// resolve o visualizador como sitemap).
pub const ACCEPT_LISTING: &str = "text/html,application/xhtml+xml,application/xml;q=0.9";

/// Leitor de páginas de UM site: hosts candidatos, parser e allowlist.
pub struct SiteListingReader {
    site: String,
    /// Hosts candidatos como base absoluta (`https://host`), na ordem do perfil.
    bases: Vec<String>,
    /// Base que respondeu por último (memoizada entre páginas da rodada).
    active: Mutex<Option<String>>,
    flavor: ListingFlavor,
    page_path: &'static str,
    fetcher: Arc<dyn SitemapFetch>,
    allow: Allowlist,
}

impl SiteListingReader {
    pub fn new(
        site: &str,
        bases: Vec<String>,
        flavor: ListingFlavor,
        page_path: &'static str,
        fetcher: Arc<dyn SitemapFetch>,
        allow: Allowlist,
    ) -> Self {
        Self {
            site: site.to_string(),
            bases,
            active: Mutex::new(None),
            flavor,
            page_path,
            fetcher,
            allow,
        }
    }

    /// Base ativa primeiro, depois os demais candidatos (sem repetir).
    fn host_order(&self) -> Vec<String> {
        let mut order: Vec<String> = Vec::new();
        if let Some(active) = self.active.lock().ok().and_then(|g| g.clone()) {
            order.push(active);
        }
        for base in &self.bases {
            if !order.contains(base) {
                order.push(base.clone());
            }
        }
        order
    }

    async fn fetch_page(&self, page: u32) -> Result<(String, String), String> {
        let mut failures: Vec<String> = Vec::new();
        for base in self.host_order() {
            let url = page_url(&base, self.page_path, page);
            match self.fetcher.fetch(&self.site, &url).await {
                Ok(body) => {
                    if let Ok(mut active) = self.active.lock() {
                        *active = Some(base.clone());
                    }
                    return Ok((base, body));
                }
                Err(err) => failures.push(format!("{url}: {err}")),
            }
        }
        Err(failures.join(" | "))
    }

    /// Cards da página: posts aceitos, brutos e reconhecidos.
    fn parse(&self, html: &str, base: &str) -> ListingPageRead {
        let mut posts: Vec<ListingPost> = Vec::new();
        let mut recognized = 0usize;
        let raw = match self.flavor {
            ListingFlavor::Hdr => {
                let cards = hdr_parse_listing_cards(html, base);
                for card in cards {
                    recognized += 1;
                    // Host de fora do site é recusado aqui — mesma política do
                    // adaptador TS.
                    if !self.host_ok(&card.url) {
                        continue;
                    }
                    posts.push(ListingPost {
                        url: card.url,
                        kind: Some(card.kind),
                    });
                }
                hdr_count_listing_cards(html)
            }
            ListingFlavor::Apache => {
                let cards = apache_parse_listing_cards(html, base);
                for card in cards {
                    recognized += 1;
                    if !self.host_ok(&card.url) {
                        continue;
                    }
                    posts.push(ListingPost {
                        url: card.url,
                        kind: Some(card.kind),
                    });
                }
                apache_count_listing_cards(html)
            }
        };
        ListingPageRead {
            posts,
            card_count: Some(raw),
            recognized_count: Some(recognized),
            // `None` = o caminhador usa `posts.len()` e o fim medido por
            // contagem. O adaptador da listagem não declara nada disso.
            enqueued: None,
            end_of_listing: None,
        }
    }

    fn host_ok(&self, url: &str) -> bool {
        let Ok(parsed) = url::Url::parse(url) else {
            return false;
        };
        parsed
            .host_str()
            .is_some_and(|host| self.allow.is_detail_host(host))
    }
}

impl ListingPageReader for SiteListingReader {
    fn read_page<'a>(&'a self, page: u32) -> ListingPageFuture<'a> {
        Box::pin(async move {
            let (base, body) = self.fetch_page(page).await?;
            Ok(self.parse(&body, &base))
        })
    }
}

/// URL da página: a 1 é a raiz do site, as demais seguem `page_path`.
pub fn page_url(base: &str, page_path: &str, page: u32) -> String {
    let base = base.trim_end_matches('/');
    if page <= 1 {
        return format!("{base}/");
    }
    format!("{base}/{}/{page}/", page_path.trim_matches('/'))
}
