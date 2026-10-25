//! Motor do raspador de sites BR do Adom (C4).
//!
//! Módulo responsável pelo loop principal do sidecar Rust:
//! - Tick periódico com delay configurável
//! - Seleção de batch de URLs pendentes (respeitando paralelismo)
//! - Despacho assíncrono com prazo duro (`step_deadline_ms`)
//! - Entrega da página à INGESTÃO NATIVA e escrita no `crawl.db`
//! - Respeito à janela de ociosidade do usuário
//! - Tolerância a erros — erro de rede não derruba o motor
//!
//! # Arquitetura
//!
//! - [`types`] — types compartilhados (espelho do `crawl-types.ts`), a costura
//!   [`PageEngine`] e as regras puras de decisão do tick
//!   ([`MarkResult::from_work`](crate::store::ops::MarkResult)).
//! - [`loop`] — loop principal: freios, seleção, despacho, prazo duro, entrega.
//! - [`ingest`] — a costura [`PageIngest`] da ingestão nativa (T3-L3).
//! - [`discovery_tick`] — a descoberta de sitemap: um site por tick, cursor por
//!   kind e custo no mesmo teto por hora (fase 6).
//! - [`deliver`] — a entrega da página concluída (substitui o POST antigo).
//! - [`gate_pending`] — o fluxo do resultado `GatePending` (post só-com-portão
//!   do BLUDV): gravação da pendência e fallback de erro retentável.
//! - [`loop_tests`] — o tick real contra um `crawl.db` temporário e um Node falso.
//!
//! # Integração com o parser (C5)
//!
//! O loop já roda de verdade: reivindica, INGERE e grava no store. O
//! único elo que falta é o `fetch + parse` da página, que é exatamente a trait
//! [`PageEngine`] — implemente-a com `net::fetch_text_direct` +
//! `page_parser::parse_crawl_page` e injete com
//! [`CrawlMotor::with_page_engine`]. Enquanto a engine diz que não está pronta,
//! o tick devolve `Skipped("parser-pendente")` e **não reivindica nenhuma URL**:
//! cada `mark_result` consome `tries`, e escrever placeholder na fila real
//! dormiria páginas boas por conta de um elo não implementado. O mesmo vale para
//! a ingestão ausente (`ingest-pendente`).

mod budget;
mod deliver;
/// Descoberta de sitemap dentro do tick (alimenta a fila `crawl_url`).
mod discovery_tick;
mod gate_pending;
pub mod ingest;
pub mod r#loop;
/// Lane de ritmo próprio (Mico): descoberta própria + leitura de página.
pub mod mico_lane;
/// Disparo da lane own_pace dentro do `CrawlMotor` (freios e gancho de teste).
mod own_pace;
/// Handle do `crawl.db` e acesso bloqueante compartilhado (catraca).
mod store_handle;
pub mod types;

#[cfg(test)]
mod loop_tests;
#[cfg(test)]
mod tests;

// Re-exports para ergonomia.
pub use discovery_tick::DiscoveryTick;
pub use ingest::{IngestFuture, PageIngest};
pub use mico_lane::{MicoLane, OwnPaceReport};
pub use r#loop::{CrawlMotor, MotorError, TickOutcome};
pub use types::{
    error_backoff_ms, error_work, now_ms, CrawlRawItem, CrawlReleaseGroup, CrawlResultStatus,
    CrawlWorkResult, MotorConfig, MotorStatus, PageEngine, PageFuture, PageOutcome, SiteStatus,
    UnwiredPageEngine,
};
