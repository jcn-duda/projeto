//! Módulo FlareSolverr — cliente, sessão, detecção de desafio e escalonamento.
//!
//! Porte fiel de `resolvers/flare.ts` e `resolvers/profiles/vacatorrent-crawl-fetch.ts`.
//!
//! # Arquitetura
//!
//! - [`types`] — tipos compartilhados (`FlareError`, `FlareSolution`, defaults)
//! - [`session`] — `FlareSession` e `FlareSessions` (mapa por hostname)
//! - [`challenge`] — `is_cloudflare_challenge(status, headers, body)`
//! - [`client`] — `fetch_text_via_flare(url, solver_url, timeout_ms)`
//! - [`escalate`] — `fetch_text_crawl(url, deps)` — escalonamento direto → Flare
//!
//! # Integração
//!
//! O maestro deve:
//! 1. Adicionar `pub mod flare;` em `lib.rs`
//! 2. Garantir que `crate::net::{fetch_text_direct, FetchDirectOptions, CrawlFetchError}`
//!    e `crate::net::allowlist::Allowlist` existam (Agente 1)
//! 3. Adicionar `reqwest` (com `rustls-tls`, `json`), `tokio` (com `sync`) ao `Cargo.toml`

pub mod challenge;
pub mod client;
pub mod escalate;
pub mod session;
pub mod types;

// Re-exports para conveniência do consumidor.
pub use challenge::is_cloudflare_challenge;
pub use client::fetch_text_via_flare;
pub use escalate::{
    fetch_text_crawl, fetch_text_crawl_accept, is_direct_challenge, CrawlFetchDeps,
};
pub use session::{build_flare_headers, FlareSession, FlareSessions};
pub use types::{FlareError, FlareSolution, DIRECT_CHALLENGE_MSG};

#[cfg(test)]
mod tests;
