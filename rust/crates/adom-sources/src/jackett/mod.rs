//! Cliente Jackett Torznab/JSON (Fase B.2).
//!
//! Espelha as regras de `src/providers/jackett*.ts` / AGENTS.md:
//!
//! - **Plano**: globais agrupados e BR/slow isolados com query pt-BR ficam no
//!   caller (`adom-core::plan_jackett_queries`); este módulo consulta a lista
//!   que recebe — cada indexer em paralelo, orçamento BR/slow via
//!   [`budget_for`].
//! - **Query**: [`shape_search_query`] aplica `strip_diacritics` **só** sob
//!   `is_br`; globais colapsam sigla com ponto.
//! - **Breaker**: abre só em offline (rede ou fonte morta no envelope
//!   `Indexers[]`); resultado vazio saudável não conta.
//! - **Link**: input de terceiro — `adom_core::is_safe_download_url` + exceção
//!   `/dl/<indexer>/` do próprio Jackett; fetch com redirect manual.
//! - **Falha**: rede/timeout/HTTP → `[]` ou [`QueryOutcome`] honesto; nunca
//!   panic. A API key nunca entra em log nem em `Debug`.
//!
//! Fora desta fatia (de propósito): integração no orquestrador/`collectRaw`,
//! cache `raw:v1`, varredura pt-BR tardia (`pt-sweep`), pré-resolve BR do
//! núcleo e captura do banco de magnets.

mod breaker;
mod client;
mod config;
mod download;
mod query;
mod results;
mod types;

pub use breaker::{now_ms as breaker_now_ms, Breaker, BreakerSnapshot};
pub use client::JackettClient;
pub use config::{JackettConfig, JACKETT_DEFAULT_URL, JACKETT_USER_AGENT};
pub use download::{download_url_allowed, is_jackett_download_link, resolve_download_magnet};
pub use query::{budget_for, shape_for, shape_search_query};
pub use results::{
    category_policy, in_category_bucket, indexer_failure, map_results, MapOptions,
    CATEGORY_UNFILTERED, OTHER_AS_UNKNOWN, UNRELIABLE_CATEGORY,
};
pub use types::{JackettMediaType, JackettRawItem, QueryOutcome, SearchOptions};
