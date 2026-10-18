//! `adom-sources` — clientes de metadados da Fase B.1 da migração TS→Rust.
//!
//! Porte de `src/utils/cinemeta.ts`, `tmdb.ts`, `tmdb-br-aliases.ts`,
//! `catalog-year.ts` e `tmdb-home-release.ts` (oráculo: branch `esm`), mais a
//! leitura de coleção que o `search-multiwork.ts` consome.
//!
//! O que este crate garante:
//!
//! - **`find` duplo** (pt-BR e en-US) no MESMO prazo absoluto do caller. O
//!   canônico inglês sai SÓ de `title`/`name` da consulta en-US — nunca
//!   `original_*`, que repetiria o idioma de origem;
//! - **aliases BR** (`alternative_titles` só `iso_3166_1 = BR`) filtrados pelas
//!   travas que já moram no `adom-core` (`filter_br_aliases`, teto 2);
//! - **cache longo só com `ok:true`**: falha/timeout usa o TTL transitório
//!   curto. TTLs e store são injetáveis (`MetaStore`);
//! - **multiobra** (`belongs_to_collection` + partes, raiz do núcleo) e **data
//!   doméstica** (`tmdb-home-release`) como opt-ins de filme, sob teto próprio
//!   que nunca estende o prazo;
//! - **réguas do núcleo chamadas, não duplicadas**: `catalog_year_of`,
//!   `catalog_alt_year_of`, `filter_br_aliases`, `collection_root`,
//!   `dedupe_names`, `pre_home_release_contradicts`, `is_non_feature`;
//! - **falha de rede nunca derruba**: todo método devolve `Option`/parcial e
//!   loga `[sources]`; nada de `unwrap` em resposta de terceiro;
//! - **tipos públicos**, sem `serde_json::Value` vazando: o orquestrador
//!   consome [`MetaLookup`], [`Titles`], [`CinemetaMeta`] e [`CollectionInfo`].
//!
//! Fora do escopo desta fatia (de propósito): busca por TÍTULO
//! (`tmdb-search.ts`), contagem de temporadas e `external_ids` da raspagem —
//! são background-only e entram com o motor de crawl.
//!
//! ```no_run
//! # async fn exemplo() -> Result<(), String> {
//! use adom_sources::{LookupOptions, MediaType, MetaSources, SourcesConfig};
//!
//! let config = SourcesConfig::default(); // preencha tmdb.api_key
//! let sources = MetaSources::with_memory_store(config)?;
//! let deadline = adom_sources::now_ms() + 1_500;
//! let meta = sources
//!     .lookup("tt0111161", MediaType::Movie, deadline, &LookupOptions::default())
//!     .await;
//! println!("{:?}", meta.title_pt);
//! # Ok(())
//! # }
//! ```

mod cache;
mod cinemeta;
mod config;
mod http;
mod sources;
mod tmdb;
mod types;
mod wire;

pub use cache::{CacheValue, CollectionRead, HomeReleaseRead, MemoryMetaStore, MetaStore};
pub use cinemeta::CinemetaClient;
pub use config::{
    CinemetaConfig, SourcesConfig, TmdbConfig, CINEMETA_BASE, DEFAULT_USER_AGENT, TMDB_BASE,
};
pub use http::now_ms;
pub use sources::MetaSources;
pub use tmdb::TmdbClient;
pub use types::{
    CinemetaMeta, CollectionInfo, EpisodeAired, LookupOptions, MediaType, MetaLookup, Titles,
};
