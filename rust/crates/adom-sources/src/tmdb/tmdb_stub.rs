//! Dublê do TMDB para os testes de identificação — sem rede.
//!
//! Não é `#[allow(dead_code)]`: os campos são lidos pelos métodos que os testes
//! usam, e o módulo só existe em `cfg(test)`.

use std::sync::{Arc, Mutex};

use super::search::{
    ExternalImdbResult, SearchFuture, SearchWorkType, TmdbSearchApi, TmdbSearchHit,
    TmdbSearchResult,
};

/// Candidato no formato que o cliente entrega (já reduzido).
pub(crate) fn hit(
    tmdb_id: u64,
    title: &str,
    original_title: &str,
    year: Option<i64>,
) -> TmdbSearchHit {
    TmdbSearchHit {
        tmdb_id,
        title: title.to_string(),
        original_title: original_title.to_string(),
        year,
    }
}

/// TMDB de mentira: hits fixos, `external_ids` fixo e falhas ligáveis.
#[derive(Clone, Default)]
pub(crate) struct StubTmdb {
    hits: Vec<TmdbSearchHit>,
    external: ExternalImdbResult,
    search_fails: bool,
    external_fails: bool,
    calls: Arc<Mutex<Vec<String>>>,
}

impl StubTmdb {
    /// Obra única que casa título e ano e resolve o IMDb dado.
    pub(crate) fn movie(title: &str, year: i64, imdb: &str) -> Self {
        Self::single(hit(1, title, title, Some(year)), imdb)
    }

    fn single(hit: TmdbSearchHit, imdb: &str) -> Self {
        Self {
            hits: vec![hit],
            external: ExternalImdbResult {
                ok: true,
                imdb: Some(imdb.to_string()),
            },
            ..Self::default()
        }
    }

    /// Hits crus (com homônimos, originais etc.).
    pub(crate) fn with_hits(hits: Vec<TmdbSearchHit>) -> Self {
        Self {
            hits,
            external: ExternalImdbResult {
                ok: true,
                imdb: Some("tt0000001".to_string()),
            },
            ..Self::default()
        }
    }

    /// A API de busca falhou (rede/5xx) — `ok:false`.
    pub(crate) fn with_search_failure(mut self) -> Self {
        self.search_fails = true;
        self
    }

    /// `external_ids` falhou — `ok:false`.
    pub(crate) fn with_external_failure(mut self) -> Self {
        self.external_fails = true;
        self
    }

    /// A obra existe no TMDB mas NÃO tem IMDb (`ok:true, imdb:None`).
    pub(crate) fn without_imdb(mut self) -> Self {
        self.external = ExternalImdbResult {
            ok: true,
            imdb: None,
        };
        self
    }

    /// Consultas feitas (`search:<tipo>:<título>` e `external:<tipo>:<id>`).
    pub(crate) fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls envenenado").clone()
    }
}

impl TmdbSearchApi for StubTmdb {
    fn search<'a>(
        &'a self,
        kind: SearchWorkType,
        title: &'a str,
    ) -> SearchFuture<'a, TmdbSearchResult> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("calls envenenado")
                .push(format!("search:{}:{title}", kind.label()));
            if self.search_fails {
                return TmdbSearchResult::default();
            }
            TmdbSearchResult {
                ok: true,
                hits: self.hits.clone(),
            }
        })
    }

    fn external_imdb<'a>(
        &'a self,
        tmdb_id: u64,
        kind: SearchWorkType,
    ) -> SearchFuture<'a, ExternalImdbResult> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("calls envenenado")
                .push(format!("external:{}:{tmdb_id}", kind.label()));
            if self.external_fails {
                return ExternalImdbResult::default();
            }
            self.external.clone()
        })
    }
}
