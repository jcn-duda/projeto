//! Metadados da busca (`resolveSearchNames` via rota interna ou fonte nativa),
//! extraído de `search.rs` pela catraca de 400 linhas.
//!
//! As PRECONDIÇÕES dos opt-ins são as do TS (`search-multiwork.ts`), não "é
//! filme, pede sempre":
//!
//! - **multiobra**: `BR_MULTIWORK_PACKS` (default true) E sem temporada E não
//!   demo E debrid ativo (`debrid.current() != null`). Sem isso o Rust pedia a
//!   coleção para instalação sem debrid e o build admitia pack multiobra que o
//!   Node nunca admitiria;
//! - **1º lançamento doméstico**: `SEARCH_PRE_HOME_RELEASE_CUT` (default true)
//!   E sem temporada E não demo. A data alimenta o corte pré-home-release do
//!   filtro de título.
//!
//! A flag `META_RUST` decide QUEM responde; a montagem é a mesma
//! ([`super::meta::build_search_meta`]).

use serde_json::Value;

use super::finish::{is_demo, str_of, SearchInput};
use super::meta::{MetaQuery, SearchMeta};
use super::Orchestrator;
use crate::request::encoded_for_internal;

impl Orchestrator {
    pub(super) async fn load_meta(&self, input: &SearchInput) -> SearchMeta {
        let parsed = adom_core::parse_stremio_id(&input.id);
        let is_movie = parsed.get("season").is_none_or(Value::is_null);
        let demo = is_demo(&input.options);
        let debrid_active = !str_of(&input.options, "debridService").is_empty()
            && !str_of(&input.options, "debridApiKey").is_empty();
        let query = MetaQuery {
            encoded: encoded_for_internal(input.encoded.as_deref()),
            kind: input.kind.clone(),
            id: input.id.clone(),
            // Coleção/1º lançamento doméstico custam uma ida extra ao TMDB —
            // opt-in, como no Node (gate de operador acima).
            include_multiwork: is_movie
                && !demo
                && debrid_active
                && self.config.build.multi_work_packs,
            include_home_release: is_movie && !demo && self.config.build.pre_home_release_cut,
            deadline_at_ms: input.deadline_at,
        };
        match self.meta.resolve(query).await {
            Ok(mut meta) => {
                meta.is_demo = demo;
                if meta.query.is_empty() {
                    // `resolveSearchNames` cai no IMDb id: nunca query vazia.
                    let fallback = SearchMeta::from_id(&input.id);
                    meta.name = fallback.name;
                    meta.names = fallback.names;
                    meta.query = fallback.query;
                }
                meta
            }
            Err(err) => {
                // Falha de metadados não derruba a busca (o TS cai no id).
                eprintln!("[search] metadados falharam para {}: {err}", input.id);
                SearchMeta::from_id(&input.id)
            }
        }
    }
}
