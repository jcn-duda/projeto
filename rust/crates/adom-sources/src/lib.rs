//! `adom-sources` — clientes de metadados e fontes da migração TS→Rust.
//!
//! ## Fase B.1 — Cinemeta / TMDB
//!
//! Porte de `src/utils/cinemeta.ts`, `tmdb.ts`, `tmdb-br-aliases.ts`,
//! `catalog-year.ts` e `tmdb-home-release.ts` (oráculo: branch `esm`), mais a
//! leitura de coleção que o `search-multiwork.ts` consome.
//!
//! O que o lookup garante:
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
//! ## Fase B.2 — Jackett Torznab/JSON
//!
//! Módulo [`jackett`]: cliente HTTP alinhado a `src/providers/jackett*.ts`.
//! Globais agrupados / BR-slow isolados são responsabilidade do plano
//! (`adom-core::plan_jackett_queries`); aqui entram shaping (`strip_diacritics`
//! só sob `is_br`), breaker só em offline, `Link` com
//! `is_safe_download_url` + redirect manual, e falha → `[]` / outcome honesto.
//! Config via `JACKETT_URL` (default loopback `:9117`) e `JACKETT_API_KEY`
//! (nunca em log). **Ainda não** está ligado ao orquestrador/`collectRaw`.
//!
//! ## Fase B — Prowlarr + Torrentio
//!
//! Módulos [`prowlarr`] e [`torrentio`]: clientes HTTP alinhados a
//! `src/providers/prowlarr.ts` e `torrentio.ts`. Prowlarr: `/api/v1/search`,
//! fail-open, chave fora de log, base loopback com guarda SSRF. Torrentio:
//! pool público, fail-open, breaker local, `fileIdx` preservado, fora dos
//! defaults de instalação. **Ainda não** ligados ao collect/orquestrador.
//!
//! Pendências da próxima fatia: integração no collect, cache `raw:v1`,
//! pt-sweep tardio, pré-resolve BR (já no núcleo) e captura do magnet-bank.
//!
//! Fora do escopo B.1 (de propósito): busca por TÍTULO (`tmdb-search.ts`),
//! contagem de temporadas e `external_ids` da raspagem — são background-only
//! e entram com o motor de crawl.
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
pub mod jackett;
pub mod prowlarr;
mod sources;
pub mod torrentio;
mod tmdb;
mod types;
mod wire;

pub use cache::{CacheValue, CollectionRead, HomeReleaseRead, MemoryMetaStore, MetaStore};
pub use cinemeta::CinemetaClient;
pub use config::{
    CinemetaConfig, SourcesConfig, TmdbConfig, CINEMETA_BASE, DEFAULT_USER_AGENT, TMDB_BASE,
};
pub use http::now_ms;
pub use jackett::{
    budget_for, shape_search_query, JackettClient, JackettConfig, JackettMediaType, JackettRawItem,
    QueryOutcome, SearchOptions, JACKETT_DEFAULT_URL,
};
pub use prowlarr::{
    ProwlarrClient, ProwlarrConfig, ProwlarrRawItem, PROWLARR_DEFAULT_URL, PROWLARR_USER_AGENT,
};
pub use sources::MetaSources;
pub use torrentio::{
    TorrentioClient, TorrentioConfig, TorrentioMediaType, TorrentioRawItem, TorrentioSearchArgs,
    TORRENTIO_DEFAULT_URL,
};
pub use tmdb::TmdbClient;
pub use types::{
    CinemetaMeta, CollectionInfo, EpisodeAired, LookupOptions, MediaType, MetaLookup, Titles,
};
