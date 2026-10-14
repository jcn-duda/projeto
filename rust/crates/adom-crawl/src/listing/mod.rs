//! Parsers e regras puras da família listing (descobertas paginadas por listagem).
//!
//! Portado de:
//! - `src/providers/crawl-sites/listing-discover.ts`
//! - `src/providers/crawl-sites/hdrtorrents-discovery.ts`
//! - `src/providers/crawl-sites/apachetorrent-discovery.ts`
//! - `resolvers/text.ts` (`parseSize`)

mod apache;
mod core;
mod hdr;
mod pagination;

pub use apache::*;
pub use core::*;
pub use hdr::*;
pub use pagination::*;

pub use apache::apache_count_listing_cards as count_listing_cards;
pub use apache::apache_page_kind_of as page_kind_of;
pub use apache::apache_parse_listing_cards as parse_listing_cards;

#[cfg(test)]
mod tests_apache;
#[cfg(test)]
mod tests_hdr;
#[cfg(test)]
mod tests_parse;
