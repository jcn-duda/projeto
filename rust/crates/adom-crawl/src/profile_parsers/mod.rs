//! Parsers dos profiles que os adaptadores usam (parseDownloadLinks, parsePostLinks, parseContentMagnets, etc).
//! Migração fiel de:
//! - `resolvers/profiles/vacatorrent-parsers.ts` e `vacatorrent-shapes.ts`
//! - `resolvers/profiles/apachetorrent-parsers.ts`
//! - `resolvers/profiles/redetorrent-parsers.ts`
//! - `resolvers/profiles/hdrtorrents-parsers.ts`
//! - `resolvers/magnet-extract.ts` e `resolvers/release-format.ts`

mod classify;
mod download;
mod magnet;
mod parsers;
mod titles;
mod types;
mod vaca;

pub use classify::*;
pub use download::*;
pub use magnet::*;
pub use parsers::*;
pub use titles::*;
pub use types::*;
pub use vaca::*;

#[cfg(test)]
mod tests_magnet;
#[cfg(test)]
mod tests_parse;
