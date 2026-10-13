//! Motor do raspador de sites BR do Adom (C4).
//!
//! Módulo responsável pelo loop principal do sidecar Rust:
//! - Tick periódico com delay configurável
//! - Seleção de batch de URLs pendentes (respeitando paralelismo)
//! - Despacho assíncrono com prazo duro (`step_deadline_ms`)
//! - Entrega do resultado ao Node e escrita no `crawl.db`
//! - Respeito à janela de ociosidade do usuário
//! - Tolerância a erros — erro de rede não derruba o motor
//!
//! # Arquitetura
//!
//! - [`types`] — types compartilhados (espelho do `crawl-types.ts`), a costura
//!   [`PageEngine`] e as regras puras de decisão do tick
//!   ([`MarkResult::from_work`](crate::store::ops::MarkResult)).
//! - [`loop`] — loop principal: freios, seleção, despacho, prazo duro, entrega.
//! - [`loop_tests`] — o tick real contra um `crawl.db` temporário e um Node falso.
//!
//! # Integração com o parser (C5)
//!
//! O loop já roda de verdade: reivindica, entrega ao Node e grava no store. O
//! único elo que falta é o `fetch + parse` da página, que é exatamente a trait
//! [`PageEngine`] — implemente-a com `net::fetch_text_direct` +
//! `page_parser::parse_crawl_page` e injete com
//! [`CrawlMotor::with_page_engine`]. Enquanto a engine diz que não está pronta,
//! o tick devolve `Skipped("parser-pendente")` e **não reivindica nenhuma URL**:
//! cada `mark_result` consome `tries`, e escrever placeholder na fila real
//! dormiria páginas boas por conta de um elo não implementado.

pub mod r#loop;
pub mod types;

#[cfg(test)]
mod loop_tests;
#[cfg(test)]
mod tests;

// Re-exports para ergonomia.
pub use r#loop::{CrawlMotor, MotorError, TickOutcome};
pub use types::{
    error_backoff_ms, error_work, now_ms, CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus,
    CrawlWorkResult, MotorConfig, MotorStatus, PageEngine, PageFuture, PageOutcome, SiteStatus,
    UnwiredPageEngine,
};
