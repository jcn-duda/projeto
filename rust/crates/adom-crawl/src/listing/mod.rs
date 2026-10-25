//! Parsers e regras puras da família listing (descobertas paginadas por listagem).
//!
//! Duas camadas, e a separação é de propósito:
//!
//! - **cards**: o HTML de cada site vira `ListingPageRead` (`apache`, `hdr`).
//! - **caminhada**: cursor durável (`lc1`), leitura de UMA página e o laço que
//!   anda a listagem até o fim (`cursor`, `read`, `walk`). Nada aqui conhece
//!   HTML: quem lê a página é um `ListingPageReader` injetado.
//!
//! Portado de:
//! - `src/providers/crawl-cursor.ts`
//! - `src/providers/crawl-listing-read.ts`
//! - `src/providers/crawl-sites/listing-discover.ts`
//! - `src/providers/crawl-sites/hdrtorrents-discovery.ts`
//! - `src/providers/crawl-sites/apachetorrent-discovery.ts`
//! - `resolvers/text.ts` (`parseSize`)

mod apache;
pub mod base64url;
mod core;
pub mod cursor;
mod hdr;
mod pagination;
pub mod read;
pub mod walk;

pub use apache::*;
pub use core::*;
pub use hdr::*;
pub use pagination::*;

pub use apache::apache_count_listing_cards as count_listing_cards;
pub use apache::apache_page_kind_of as page_kind_of;
pub use apache::apache_parse_listing_cards as parse_listing_cards;
// Nomes explícitos: os dois módulos novos têm vocabulário próprio e um glob
// aqui esconderia colisão com os parsers de card.
pub use cursor::{
    decode_listing_cursor, encode_listing_cursor, listing_cursor_exhausted, listing_cursor_key,
    listing_round_exhausted, restart_listing_round, start_listing_cursor, ListingCursor,
    LISTING_CURSOR_TAG, LISTING_ROUND_MAX_PAGES,
};
pub use read::{read_listing_page, ListingReadReason, ListingReadResult};
pub use walk::{
    walk_listing, ListingPageFuture, ListingPageReader, ListingWalkInput, ListingWalkResult,
};

#[cfg(test)]
mod tests_apache;
#[cfg(test)]
mod tests_hdr;
#[cfg(test)]
mod tests_parse;
