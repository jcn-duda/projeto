//! Metadados da busca (`resolveSearchNames` via rota interna), extraído de
//! `search.rs` pela catraca de 400 linhas.

use super::finish::{is_demo, SearchInput};
use super::meta::{MetaQuery, SearchMeta};
use super::Orchestrator;
use crate::request::encoded_for_internal;

impl Orchestrator {
    pub(super) async fn load_meta(&self, input: &SearchInput) -> SearchMeta {
        let query = MetaQuery {
            encoded: encoded_for_internal(input.encoded.as_deref()),
            kind: input.kind.clone(),
            id: input.id.clone(),
            // Coleção/1º lançamento doméstico custam uma ida extra ao TMDB —
            // opt-in, como no Node. Filme, e só com debrid ativo.
            include_multiwork: input.kind == "movie",
            include_home_release: input.kind == "movie",
        };
        match self.meta.resolve(query).await {
            Ok(mut meta) => {
                meta.is_demo = is_demo(&input.options);
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
