//! Caminhada da LISTAGEM paginada (fase 6, trilha de listing).
//!
//! Porte de `listing-discover.ts::walkListing`. O núcleo não conhece HTML de
//! ninguém: quem lê a página é o [`ListingPageReader`] injetado, e aqui moram
//! só as regras de paginação, fim, custo e portão de séries.
//!
//! Duas travas de fim, e as duas são medidas:
//!
//! 1. **CONTAGEM de cards brutos**: página cheia é o tamanho do acervo; abaixo
//!    do cheio é a página calcanhar. Contar só os aceitos fez um card pulado
//!    virar fim falso.
//! 2. **PÁGINA JÁ VISTA**: página cheia e inteira repetida é inversão (o site
//!    devolveu a última página de novo). A primeira trava sozinha deixaria isso
//!    passar como avanço.
//!
//! Página sem NENHUM card reconhecido é FALHA, nunca "vazio e completo": essa
//! combinação faz o cursor avançar por cima de acervo nunca lido e é silenciosa
//! por definição. Lista vazia DEPOIS do corte (página só com URLs já vistas) é
//! legítima.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;

use crate::discovery::types::DiscoveredUrl;
use crate::listing::cursor::{listing_round_exhausted, ListingCursor};
use crate::listing::pagination::{
    check_listing_recognition, is_listing_end, is_repeated_page, ListingPageRead, ListingPost,
};
use crate::listing::read::read_listing_page;
use crate::listing::CrawlPageKind as CardKind;
use crate::sitemap::CrawlPageKind;

/// Futuro de leitura de UMA página da listagem.
pub type ListingPageFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ListingPageRead, String>> + Send + 'a>>;

/// Quem fala com o site (fetch + parser) para a caminhada.
pub trait ListingPageReader: Send + Sync {
    /// Lê a página `page` (1-based, como o site numera).
    fn read_page<'a>(&'a self, page: u32) -> ListingPageFuture<'a>;
}

/// Entrada da caminhada (tudo o que o núcleo precisa saber).
pub struct ListingWalkInput<'a> {
    pub reader: &'a dyn ListingPageReader,
    /// Tamanho CHEIO de uma página do acervo, medido no site.
    pub expected_per_page: usize,
    /// Teto de páginas da rodada (0 = o laço faz ao menos uma).
    pub round_max_pages: u32,
    /// Série desligada: o candidato `tv_show` é lido (o request foi gasto no
    /// site) mas NÃO entra na fila — mesma política dos sites com sitemap.
    pub series_enabled: bool,
    /// Kind quando o card não declara tipo.
    pub default_kind: CrawlPageKind,
    pub cursor: ListingCursor,
    pub now: i64,
}

/// O que a varredura viu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingWalkResult {
    /// URLs INÉDITAS, na ordem em que a listagem as entregou.
    pub urls: Vec<DiscoveredUrl>,
    /// Motivos curtos das páginas que falharam (nunca credencial).
    pub failures: Vec<String>,
    /// Requisições REAIS ao site, incluindo a página que falhou.
    pub requests: u32,
    /// Páginas que o cursor CONSUMIU (entraram no round de verdade).
    pub pages_consumed: u32,
    /// A varredura fechou um round completo (âncora achada ou fim declarado).
    pub end_of_listing: bool,
    /// O cursor durável para a próxima rodada gravar.
    pub cursor: ListingCursor,
    /// Por que o round fechou — o vocabulário do `read_listing_page`.
    pub reason: String,
    /// A varredura cobriu o acervo (sem falha)?
    pub complete: bool,
}

/// Anda a listagem a partir de `cursor.page` até o fim do acervo (ou o teto da
/// rodada), entregando URLs inéditas.
pub async fn walk_listing(input: ListingWalkInput<'_>) -> ListingWalkResult {
    let ListingWalkInput {
        reader,
        expected_per_page,
        round_max_pages,
        series_enabled,
        default_kind,
        now,
        cursor: start_cursor,
    } = input;
    let mut cursor = start_cursor;
    let default_card_kind = card_kind(default_kind);
    let mut urls: Vec<DiscoveredUrl> = Vec::new();
    let mut failures: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut requests = 0u32;
    let mut pages_consumed = 0u32;
    let mut end_of_listing = false;
    let mut reason = String::from("walk");
    let mut complete = false;
    let full = expected_per_page.max(1);

    while pages_consumed < round_max_pages.max(1) {
        if listing_round_exhausted(&cursor, round_max_pages) {
            break;
        }
        let page = cursor.page.max(1);
        // A requisição CONTA mesmo quando falha: foi um request ao site, e é
        // ele que pesa no teto por hora. O cursor, ao contrário, não consome a
        // página que falhou — o retry relê a mesma.
        requests = requests.saturating_add(1);
        let read = match reader.read_page(page).await {
            Ok(read) => read,
            Err(err) => {
                failures.push(format!("listing-pagina-{page}:{}", reason_of(&err)));
                break;
            }
        };

        let mut page_keys: Vec<String> = Vec::new();
        let mut fresh: Vec<(String, CardKind)> = Vec::new();
        for post in &read.posts {
            let url = post.url.trim();
            if url.is_empty() {
                continue;
            }
            page_keys.push(url.to_string());
            if seen.contains(url) {
                continue;
            }
            seen.insert(url.to_string());
            fresh.push((url.to_string(), post.kind.unwrap_or(default_card_kind)));
        }

        let raw_cards = read.card_count.unwrap_or(page_keys.len());
        let recognized_cards = read.recognized_count.unwrap_or(page_keys.len());
        if let Err(motive) = check_listing_recognition(raw_cards, recognized_cards, page_keys.len())
        {
            // Um `urls: []` com `complete: true` aqui faria o cursor avançar
            // por cima de acervo nunca lido.
            failures.push(format!("listing-pagina-{page}:{motive}"));
            break;
        }

        let counted = is_listing_end(raw_cards, page_keys.len(), full);
        // Página inteira já vista com o tamanho cheio: o site devolveu a MESMA
        // página (inversão). Não prova fim, mas também não pode ser relida.
        let repeated = is_repeated_page(fresh.len(), counted);

        for (url, card_kind) in fresh {
            let kind = discovery_kind(card_kind);
            // Série desligada: a página conta como lida (o orçamento foi gasto
            // no site), mas nenhuma URL dela entra na fila.
            if kind == CrawlPageKind::TvShow && !series_enabled {
                continue;
            }
            // `lastmod` vazio de propósito: a listagem publica o ANO da obra,
            // não a data de publicação — data inventada é pior que ausente.
            urls.push(DiscoveredUrl {
                url,
                lastmod: String::new(),
                kind,
            });
        }

        let consumed = read_listing_page(
            &cursor,
            &cursor_page(&page_keys, counted),
            now,
            round_max_pages,
            0,
        );
        if !consumed.advanced {
            // Token incoerente: o round reinicia sem consumir (a listagem
            // pararia para sempre). As URLs desta página já entraram acima.
            cursor = consumed.cursor;
            reason = consumed.reason.as_str().to_string();
            break;
        }
        cursor = consumed.cursor;
        pages_consumed = pages_consumed.saturating_add(1);
        complete = consumed.complete;
        if consumed.complete {
            end_of_listing = true;
            reason = consumed.reason.as_str().to_string();
            break;
        }
        // Página cheia e repetida é inversão: fecha o round sem afirmar
        // cobertura do acervo.
        if repeated {
            reason = "already-seen-page".to_string();
            break;
        }
        reason = consumed.reason.as_str().to_string();
    }

    ListingWalkResult {
        urls,
        // `read_listing_page` só chama `complete` para âncora achada ou fim
        // declarado; teto de rodada nunca é cobertura. Falha derruba de novo:
        // uma página que falhou não prova nada sobre as outras.
        complete: complete && failures.is_empty(),
        failures,
        requests,
        pages_consumed,
        end_of_listing,
        cursor,
        reason,
    }
}

/// Página como o CURSOR a vê: TODAS as URLs lidas (mesmo as já vistas) e o
/// fim medido por CONTAGEM (o `endOfListing` que o `walkListing` passa não é o
/// declarado pelo adaptador — é o `counted`).
fn cursor_page(page_keys: &[String], counted: bool) -> ListingPageRead {
    ListingPageRead {
        posts: page_keys
            .iter()
            .map(|url| ListingPost {
                url: url.clone(),
                kind: None,
            })
            .collect(),
        card_count: None,
        recognized_count: None,
        enqueued: Some(page_keys.len()),
        end_of_listing: Some(counted),
    }
}

/// Os dois `CrawlPageKind` do crate: o dos cards (`listing`) e o do motor
/// (`sitemap`). A conversão fica na borda, num lugar só.
fn discovery_kind(kind: CardKind) -> CrawlPageKind {
    match kind {
        CardKind::Movie => CrawlPageKind::Movie,
        CardKind::TvShow => CrawlPageKind::TvShow,
    }
}

/// O caminho de volta (o `defaultKind` do adaptador TS).
fn card_kind(kind: CrawlPageKind) -> CardKind {
    match kind {
        CrawlPageKind::Movie => CardKind::Movie,
        CrawlPageKind::TvShow => CardKind::TvShow,
    }
}

/// Erro de terceiro vira motivo curto e sem espaço (vai para `failures`).
fn reason_of(raw: &str) -> String {
    let text = raw.trim();
    let head: String = text.chars().take(80).collect();
    let slug = head.split_whitespace().collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        "erro".to_string()
    } else {
        slug
    }
}

#[cfg(test)]
#[path = "tests_walk.rs"]
mod tests;
