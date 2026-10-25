//! Costuras de rede da ingestão: o catálogo que identifica a página e o
//! invalidadores de streams.
//!
//! Por que costura e não chamada direta: o `identify` nativo do `adom-sources`
//! (desde `c6b55f97`) ainda não é reexportado no crate root — `mod tmdb` é
//! privado — então o adaptador de TMDB precisa morar na fiação (fora do
//! `adom-crawl`). O contrato daqui é o MESMO dos quatro vereditos, para o
//! adaptador só traduzir `IdentifyOutcome` → [`PageVerdict`].
//!
//! A invalidação segue a mesma ideia: o `streams.db` do gateway vive em OUTRO
//! processo, então o sidecar precisa da ponte admin em loopback
//! (`POST /streams/invalidate` com `X-Indexer-Test-Token`). [`StreamsInvalidator`]
//! cobre quem já tem o store no processo; a fiação implementa a ponte HTTP.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use adom_store::StreamsStore;

use super::CrawlObra;

/// Futuro boxed de UMA chamada de rede. Sem `async-trait`: nenhuma dependência
/// nova, como no `PageFuture` do motor.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Tipo da obra (`body.kind === 'series' ? 'tv_show' : 'movie'` no Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkKind {
    Movie,
    Series,
}

impl WorkKind {
    /// `"series"` é série; qualquer outro rótulo é filme (como no Node).
    pub fn from_page_kind(kind: &str) -> Self {
        if kind == "series" {
            Self::Series
        } else {
            Self::Movie
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }

    pub fn is_series(self) -> bool {
        matches!(self, Self::Series)
    }
}

/// Entrada da identificação (o `IdentifyInput` de `crawl-identify.ts`).
///
/// `original_title` e `season` existem no `identify` nativo: título original
/// declarado pela página é segundo nome com a MESMA régua estrita, e temporada
/// N≥2 muda a janela de anos da série. A rota do Node passa só
/// tipo/título/ano; o motor pode preencher os outros dois.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifyRequest {
    pub kind: WorkKind,
    /// Título da página (h1), sem ano.
    pub title: String,
    /// Ano declarado pela página; `None` = página sem ano (não consulta).
    pub year: Option<i64>,
    pub original_title: Option<String>,
    pub season: Option<i64>,
}

/// Veredito da identificação (`IdentifyOutcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageVerdict {
    Identified,
    Unidentified,
    Ambiguous,
    Unavailable,
}

impl PageVerdict {
    /// Grafia idêntica à do TS (`identified`, `unavailable`…).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Identified => "identified",
            Self::Unidentified => "unidentified",
            Self::Ambiguous => "ambiguous",
            Self::Unavailable => "unavailable",
        }
    }

    /// Só `unavailable` é transitório (TMDB fora/timeout).
    pub fn is_retryable(self) -> bool {
        matches!(self, Self::Unavailable)
    }
}

/// Resultado de uma identificação (`IdentifyResult` do TS).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentifyVerdict {
    pub outcome: PageVerdict,
    /// Só em `identified`; nunca um chute.
    pub imdb: Option<String>,
    /// Motivo curto e estável (agrupamento no painel/log).
    pub reason: String,
}

impl IdentifyVerdict {
    pub fn identified(imdb: &str) -> Self {
        Self {
            outcome: PageVerdict::Identified,
            imdb: Some(imdb.to_string()),
            reason: "casamento-unico".to_string(),
        }
    }

    pub fn unidentified(reason: &str) -> Self {
        Self {
            outcome: PageVerdict::Unidentified,
            imdb: None,
            reason: reason.to_string(),
        }
    }

    pub fn ambiguous(reason: &str) -> Self {
        Self {
            outcome: PageVerdict::Ambiguous,
            imdb: None,
            reason: reason.to_string(),
        }
    }

    pub fn unavailable(reason: &str) -> Self {
        Self {
            outcome: PageVerdict::Unavailable,
            imdb: None,
            reason: reason.to_string(),
        }
    }
}

/// Contexto do filtro de título (`resolveSearchNames` + ano do catálogo).
/// Sem nomes não há contexto: o `record` falha retentável.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkNames {
    pub names: Vec<String>,
    /// Ano resolvido do catálogo; `None` cai no ano da página.
    pub year: Option<i64>,
}

/// Identificação da obra de uma página + nomes para o filtro.
pub trait ObraCatalog: Send + Sync {
    /// Identifica uma página sem IMDb (os quatro vereditos do TMDB).
    fn identify<'a>(&'a self, request: &'a IdentifyRequest) -> BoxFuture<'a, IdentifyVerdict>;

    /// Nomes (e ano) do catálogo para a obra JÁ identificada. `None` = sem
    /// nomes (o filtro não roda).
    fn names<'a>(&'a self, obra: &'a CrawlObra) -> BoxFuture<'a, Option<WorkNames>>;
}

/// Invalidação da lista de streams de UMA obra. `false` = não invalidou (o
/// chamador loga; o TS é fail-open aqui).
pub trait StreamInvalidator: Send + Sync {
    fn invalidate<'a>(&'a self, imdb_id: &'a str) -> BoxFuture<'a, bool>;
}

/// Invalidação no MESMO processo (`adom-server`/teste). No sidecar use a ponte
/// admin: escrever o `streams.db` direto não invalida a cópia em memória do
/// gateway.
#[derive(Clone)]
pub struct StreamsInvalidator {
    store: Arc<StreamsStore>,
}

impl StreamsInvalidator {
    pub fn new(store: Arc<StreamsStore>) -> Self {
        Self { store }
    }
}

impl StreamInvalidator for StreamsInvalidator {
    fn invalidate<'a>(&'a self, imdb_id: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move { self.store.invalidate_for_obra(imdb_id).is_ok() })
    }
}
