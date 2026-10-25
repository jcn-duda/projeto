//! Leitura de UMA página da listagem — o único verbo que move o cursor.
//!
//! Porte de `crawl-listing-read.ts`, e as duas fases são a razão de existir:
//!
//! - **CARGA INICIAL** (`sweep == false`): anda da página 1 até o fim. A âncora
//!   NÃO vale aqui. Medido na VPS: o Apache achou a "âncora" na página 42,
//!   fechou a rodada como completa e a carga inteira levaria ~4 dias e meio.
//! - **INCREMENTAL** (`sweep == true`): ao chegar ao fim, a passada seguinte
//!   começa na página 1 e fecha ao reencontrar o post mais NOVO da passada
//!   anterior (`head` → `anchor`). Sem a volta à página 1, post novo do site
//!   nunca seria lido.
//!
//! A ordem das decisões é a do TS e importa: round esgotado (token incoerente)
//! reinicia ANTES de qualquer consumo; `max_pages` estourado não consome; o
//! teto do round fecha SEM cobertura (exceto no incremental sem âncora, onde
//! reler as páginas do topo É a cobertura).

use crate::listing::cursor::{
    listing_cursor_exhausted, listing_round_exhausted, restart_listing_round, ListingCursor,
};
use crate::listing::pagination::ListingPageRead;
use crate::store::url_key::crawl_url_key;

/// Por que o round parou. `Walk` = a página foi lida e o round continua.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingReadReason {
    AnchorFound,
    EndOfListing,
    RoundCap,
    PageCap,
    Walk,
}

impl ListingReadReason {
    /// Vocabulário logado/persistido (o mesmo do TS).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::AnchorFound => "anchor-found",
            Self::EndOfListing => "end-of-listing",
            Self::RoundCap => "round-cap",
            Self::PageCap => "page-cap",
            Self::Walk => "walk",
        }
    }
}

/// O que a leitura decidiu sobre a página e o cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListingReadResult {
    /// Cursor para gravar — igual ao de entrada quando nada foi consumido.
    pub cursor: ListingCursor,
    /// O round cobriu a listagem? Só a âncora achada ou o fim declarado fecham.
    pub complete: bool,
    pub reason: ListingReadReason,
    /// A âncora do round apareceu nesta página.
    pub anchor_found: bool,
    /// A página foi consumida (posição e orçamento contados)?
    pub advanced: bool,
}

/// Caminho utilizável de um post (`''`/`/` não são marco).
fn post_key(post: &str) -> String {
    let key = crawl_url_key(post);
    if key.is_empty() || key == "/" {
        String::new()
    } else {
        key
    }
}

/// O marco do round na carga inicial: o post mais ANTIGO lido (último da
/// página, na ordem do site).
fn closing_anchor(posts: &[String]) -> String {
    posts
        .iter()
        .rev()
        .find_map(|post| {
            let key = post_key(post);
            (!key.is_empty()).then_some(key)
        })
        .unwrap_or_default()
}

/// Consome UMA página e decide o destino do round.
///
/// `round_max_pages` é o teto da rodada (0 desliga) e `max_pages` é o teto
/// ABSOLUTO de profundidade (0 desliga; o `walkListing` não usa).
pub fn read_listing_page(
    cursor: &ListingCursor,
    page: &ListingPageRead,
    now: i64,
    round_max_pages: u32,
    max_pages: u32,
) -> ListingReadResult {
    if listing_round_exhausted(cursor, round_max_pages) {
        return ListingReadResult {
            cursor: restart_listing_round(cursor, now),
            complete: false,
            reason: ListingReadReason::RoundCap,
            anchor_found: false,
            advanced: false,
        };
    }
    if listing_cursor_exhausted(cursor, max_pages) {
        return ListingReadResult {
            cursor: cursor.clone(),
            complete: false,
            reason: ListingReadReason::PageCap,
            anchor_found: false,
            advanced: false,
        };
    }

    let keys: Vec<String> = page.posts.iter().map(|p| post_key(&p.url)).collect();
    let page_no = cursor.page.max(1);
    let anchor_found = cursor.sweep && !cursor.anchor.is_empty() && keys.contains(&cursor.anchor);
    let end_of_listing = page.end_of_listing.unwrap_or(false);
    // O post mais novo da passada: o primeiro da página 1.
    let head = match &cursor.head {
        Some(head) if !head.is_empty() => head.clone(),
        _ if page_no == 1 => keys
            .iter()
            .find(|k| !k.is_empty())
            .cloned()
            .unwrap_or_default(),
        _ => String::new(),
    };
    let round_page = cursor.round_page.saturating_add(1);
    let reached_cap = round_max_pages > 0 && round_page >= round_max_pages;
    let complete =
        anchor_found || end_of_listing || (cursor.sweep && cursor.anchor.is_empty() && reached_cap);
    let close = complete || reached_cap;
    let seen = cursor
        .seen
        .saturating_add(page.enqueued.unwrap_or(page.posts.len()) as u64);
    let rounds = if close {
        cursor.rounds.saturating_add(1)
    } else {
        cursor.rounds
    };
    let next = if complete {
        ListingCursor {
            page: 1,
            seen,
            round_page: 0,
            rounds,
            updated_at: now,
            sweep: true,
            // Sem `head` (cursor gravado antes do campo) a âncora da carga
            // inicial é um post do MEIO do catálogo: como parada do
            // incremental ela faria a passada reler quase tudo.
            anchor: if head.is_empty() {
                if cursor.sweep {
                    cursor.anchor.clone()
                } else {
                    String::new()
                }
            } else {
                head.clone()
            },
            head: None,
            ..cursor.clone()
        }
    } else {
        ListingCursor {
            page: page_no.saturating_add(1),
            seen,
            round_page: if close { 0 } else { round_page },
            // Na carga inicial o marco segue o fim do trecho lido; no
            // incremental ele é a parada da passada e não se move até fechar.
            anchor: if close && !cursor.sweep {
                let closing = closing_anchor(&keys);
                if closing.is_empty() {
                    cursor.anchor.clone()
                } else {
                    closing
                }
            } else {
                cursor.anchor.clone()
            },
            rounds,
            updated_at: now,
            head: (!head.is_empty()).then_some(head),
            ..cursor.clone()
        }
    };
    ListingReadResult {
        cursor: next,
        complete,
        reason: if anchor_found {
            ListingReadReason::AnchorFound
        } else if end_of_listing {
            ListingReadReason::EndOfListing
        } else if reached_cap {
            ListingReadReason::RoundCap
        } else {
            ListingReadReason::Walk
        },
        anchor_found,
        advanced: true,
    }
}

#[cfg(test)]
#[path = "tests_read.rs"]
mod tests;
