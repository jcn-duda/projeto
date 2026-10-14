//! Módulo de rede do raspador de sites BR do Adom.
//!
//! Porta Rust da camada HTTP do `resolvers/transport.ts` + `resolvers/protector.ts`:
//! allowlist de hosts, cookie jar por hostname, laço de redirects com deadline
//! da cadeia e fetch de conveniência.
//!
//! # Arquitetura
//!
//! - [`allowlist`] — validação de URLs por sufixos de domínio.
//! - [`cookie_jar`] — cookies por hostname (Set-Cookie → Cookie).
//! - [`redirect`] — `fetch_follow_redirects`: laço com allowlist por hop.
//! - [`fetch`] — `fetch_text_direct`: conveniência sobre o redirect.
//! - [`types`] — erros e tipos compartilhados.

pub mod allowlist;
pub mod cookie_jar;
pub mod fetch;
pub mod redirect;
pub mod types;

#[cfg(test)]
mod tests;

// Re-exports para ergonomia.
pub use allowlist::Allowlist;
pub use cookie_jar::CookieJar;
pub use fetch::{fetch_text_direct, FetchDirectOptions};
pub use redirect::{fetch_follow_redirects, FetchRedirectsOptions};
pub use types::{CrawlFetchError, FetchResponse};
