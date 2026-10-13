//! Motor do raspador de sites BR do Adom (C4).
//!
//! Módulo responsável pelo loop principal do sidecar Rust:
//! - Tick periódico com delay configurável
//! - Seleção de batch de URLs pendentes (respeitando paralelismo)
//! - Despacho assíncrono com prazo duro (`step_deadline_ms`)
//! - Respeito à janela de ociosidade do usuário
//! - Tolerância a erros — erro de rede não derruba o motor
//!
//! # Arquitetura
//!
//! - [`types`] — types compartilhados entre todos os módulos C4
//!   (espelham os types do TypeScript `crawl-types.ts`).
//! - [`loop`] — loop principal: tick, seleção, despacho, prazo duro.
//!
//! # Integração com outros agentes
//!
//! Este módulo define a estrutura do motor, mas depende de:
//! - **Agente 2** (store): trait `CrawlStore` para persistência de URLs e resultados
//! - **Agente 3** (HTTP): `CrawlHttpClient` para fetch + parse
//!
//! Os placeholders estão marcados com `TODO(Agente N)` para integração posterior.

pub mod r#loop;
pub mod types;

#[cfg(test)]
mod tests;

// Re-exports para ergonomia.
pub use r#loop::{CrawlMotor, MotorError};
pub use types::{
    CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus, CrawlWorkResult, MotorConfig,
    MotorStatus, SiteStatus,
};
