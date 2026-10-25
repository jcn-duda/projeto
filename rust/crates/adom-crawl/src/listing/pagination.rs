use super::*;
use serde::{Deserialize, Serialize};

// ── Lógica Pura de Paginação (`listing-discover.ts`) ──────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingPost {
    pub url: String,
    pub kind: Option<CrawlPageKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingPageRead {
    /// Candidatos da página NA ORDEM DO SITE (primeiro = mais novo). A ordem
    /// não é enfeite: o marco do round é o ÚLTIMO post, e ele só significa
    /// "li até aqui" se for o mais antigo da página.
    pub posts: Vec<ListingPost>,
    /// Cards BRUTOS, antes de qualquer filtro do adaptador. É ESTE número que
    /// decide o fim do catálogo: contar só os aceitos fez um card pulado virar
    /// "página calcanhar" (o Apache parou na 211 de 2123, 2026-10-01).
    pub card_count: Option<usize>,
    /// Cards cujo formato o parser reconheceu, antes de filtros de host/tipo.
    pub recognized_count: Option<usize>,
    /// Posts que entraram na fila (orçamento gasto). Default: `posts.len()`.
    pub enqueued: Option<usize>,
    /// O adaptador viu o FIM da listagem ("próxima" ausente/vazia).
    pub end_of_listing: Option<bool>,
}

/// Trava primária de fim de catálogo por contagem.
pub fn is_listing_end(raw_cards: usize, accepted_posts: usize, expected_full_page: usize) -> bool {
    raw_cards.max(accepted_posts) < expected_full_page
}

/// Detecção de inversão / página repetida sem posts inéditos.
pub fn is_repeated_page(fresh_count: usize, end_of_listing: bool) -> bool {
    fresh_count == 0 && !end_of_listing
}

/// Valida se a página possui cards reconhecidos e no host permitido.
pub fn check_listing_recognition(
    raw_cards: usize,
    recognized_cards: usize,
    accepted_keys: usize,
) -> Result<(), &'static str> {
    if recognized_cards == 0 || accepted_keys == 0 {
        if accepted_keys == 0 && recognized_cards > 0 {
            Err("nenhuma-obra-no-host")
        } else if raw_cards > 0 {
            Err("cards-nao-reconhecidos")
        } else {
            Err("nenhum-card")
        }
    } else {
        Ok(())
    }
}
