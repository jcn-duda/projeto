//! Fachada dos dois clientes: um `lookup` só devolve o [`MetaLookup`] que o
//! orquestrador consome.
//!
//! O paralelismo é o do `search-orchestrator.ts`: Cinemeta e TMDB rodam juntos;
//! multiobra e data doméstica rodam junto com eles, no MESMO prazo absoluto,
//! capeados por `collection_timeout_ms` (`min(deadline, now + teto)`) — nunca
//! somam parede de tempo. Qualquer lado pode falhar: o resultado é parcial e
//! honesto, com `None` no campo que não veio.

use std::sync::Arc;

use crate::cache::{MemoryMetaStore, MetaStore};
use crate::cinemeta::CinemetaClient;
use crate::config::SourcesConfig;
use crate::http::{now_ms, Http};
use crate::tmdb::TmdbClient;
use crate::types::{LookupOptions, MediaType, MetaLookup};

/// Os dois clientes de metadados, com store e `User-Agent` compartilhados.
pub struct MetaSources {
    pub cinemeta: CinemetaClient,
    pub tmdb: TmdbClient,
}

impl MetaSources {
    /// Cria a fachada com o store injetado (memória, SQLite, fake de teste…).
    pub fn new(config: SourcesConfig, store: Arc<dyn MetaStore>) -> Result<Self, String> {
        let http = Http::new(&config.user_agent)?;
        Ok(Self {
            cinemeta: CinemetaClient::from_parts(http.clone(), config.cinemeta, store.clone()),
            tmdb: TmdbClient::from_parts(http, config.tmdb, store),
        })
    }

    /// Conveniência para testes/embrião: store em memória.
    pub fn with_memory_store(config: SourcesConfig) -> Result<Self, String> {
        Self::new(config, Arc::new(MemoryMetaStore::new()))
    }

    /// Junta Cinemeta + TMDB (+ opt-ins) sob `deadline_at_ms` (epoch ms).
    ///
    /// Nunca devolve erro: prazo vencido, rede fora ou API sem resposta deixam
    /// os campos correspondentes em `None`. O `imdb`/`type` de entrada sempre
    /// voltam, então o chamador sabe de qual obra é o parcial.
    pub async fn lookup(
        &self,
        imdb: &str,
        media_type: MediaType,
        deadline_at_ms: i64,
        options: &LookupOptions,
    ) -> MetaLookup {
        let imdb = imdb.trim();
        let now = now_ms();
        let cap = options
            .collection_timeout_ms
            .unwrap_or(self.tmdb.config().collection_timeout_ms);
        let cap_deadline = now.saturating_add(i64::try_from(cap).unwrap_or(i64::MAX));
        let sub_deadline = deadline_at_ms.min(cap_deadline);
        let want_collection = options.include_multiwork && !media_type.is_series();
        let want_home = options.include_home_release && !media_type.is_series();

        let (meta, titles, collection, home) = tokio::join!(
            self.cinemeta.get_meta(media_type, imdb, deadline_at_ms),
            self.tmdb.get_titles(imdb, deadline_at_ms),
            async {
                if want_collection {
                    self.tmdb.get_collection(imdb, sub_deadline).await
                } else {
                    None
                }
            },
            async {
                if want_home {
                    self.tmdb.get_home_release_at(imdb, sub_deadline).await
                } else {
                    None
                }
            },
        );

        let mut lookup = MetaLookup::empty(imdb, media_type);
        // Cinemeta e TMDB podem discordar no ano; o núcleo decide o escolhido e
        // devolve o descartado como `alt_year` (Monster: 2018 × 2021).
        let meta_year = meta.as_ref().and_then(|meta| meta.year.as_deref());
        let tmdb_year = titles.as_ref().and_then(|titles| titles.year.as_deref());
        lookup.year = adom_core::catalog_year_of(meta_year, tmdb_year).map(str::to_string);
        lookup.alt_year = adom_core::catalog_alt_year_of(meta_year, tmdb_year);

        if let Some(meta) = &meta {
            lookup.meta_name = meta.name.clone();
            lookup.episodes_by_season = meta.episodes_by_season.clone();
            lookup.episode_aired = meta.episode_aired.clone();
            lookup.released = meta.released.clone();
            lookup.first_aired = meta.first_aired.clone();
        }
        if let Some(titles) = &titles {
            lookup.title_pt = titles.pt.clone();
            lookup.title_en = titles.en.clone();
            lookup.title_original = titles.original.clone();
            lookup.aliases_br = titles.aliases_br.clone();
        }

        // Ordem do `resolveSearchNames`: Cinemeta, en, pt, original, aliases BR.
        let mut names: Vec<Option<&str>> = Vec::with_capacity(5 + lookup.aliases_br.len());
        names.push(lookup.meta_name.as_deref());
        names.push(lookup.title_en.as_deref());
        names.push(lookup.title_pt.as_deref());
        names.push(lookup.title_original.as_deref());
        for alias in &lookup.aliases_br {
            names.push(Some(alias.as_str()));
        }
        lookup.names = adom_core::dedupe_names(&names);

        // Sem o opt-in, a data doméstica só vem do que já está em cache (o
        // build do TS lê por `peekHomeReleaseAt` e não espera rede).
        lookup.home_release_at = if want_home {
            home
        } else if media_type.is_series() {
            None
        } else {
            self.tmdb.peek_home_release_at(imdb)
        };
        lookup.collection = collection;
        lookup
    }
}
