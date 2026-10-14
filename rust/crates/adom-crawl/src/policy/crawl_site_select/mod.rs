//! Escolha do PRÓXIMO SITE da rotação serial (Fase 8 multi-site).
//!
//! A política é PURA sobre a foto do motor: o que decide, em que ordem, e POR QUE
//! um site ficou de fora (o motivo é o que o painel mostra; sem ele, "não rasga nada"
//! é indistinguível de "travado pelo teto").
//!
//! Migração fiel de `src/providers/crawl-site-select.ts`.

mod select;
mod types;

pub use select::*;
pub use types::*;

#[cfg(test)]
mod tests_exclusion;
#[cfg(test)]
mod tests_starvation;
