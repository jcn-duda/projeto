//! Ingestão nativa da raspagem (T3-L3): as TRÊS escritas do recorder.
//!
//! Porte fiel de `createCrawlRecorder().record` (`src/providers/crawl-recorder.ts`):
//! com a página já identificada, para CADA locação (temporada/episódio):
//!
//! 1. **banco vivo** (`capture_items` + `mark_filter_outcome` do T2-L1);
//! 2. **índice de releases** (`ReleaseIndexStore::record`, `idx:v14`);
//! 3. **transição BR** (`adom_core::br_gap`) e invalidação dos streams da obra.
//!
//! O que veio do TS sem mudança: `partial`/`keep_partial` (a raspagem cobre UMA
//! página, nunca a obra inteira), contexto SÓ do catálogo (sem nomes →
//! [`IngestError::CatalogNoNames`], retentável), a cerca do passo
//! ([`IngestOptions::should_abort`]) antes de CADA escrita e a barreira de
//! persistência (sem confirmação → [`IngestError::FlushFailed`], nada avança).
//!
//! O que é adaptação consciente:
//!
//! - **invalidação UMA vez por obra e por página**: o TS enfileirava uma
//!   invalidação por locação de grupo; aqui o [`Ingest::apply_page`] compartilha
//!   o conjunto de obras já invalidadas e a segunda locação não repete a chamada
//!   (o efeito é o mesmo — o cache é por obra);
//! - **sem `metrics.count`**: os contadores viraram campos de [`RecordReport`] /
//!   [`PageReport`] e variantes de erro, que o chamador loga;
//! - **a invalidação é uma costura** ([`StreamInvalidator`]): o sidecar é outro
//!   processo e o `streams.db` do gateway só pode ser mexido pela ponte admin em
//!   loopback (`POST /streams/invalidate`). O [`StreamsInvalidator`] serve para
//!   quem já tem o `StreamsStore` no processo (gateway/teste);
//! - **a identificação também é uma costura** ([`ObraCatalog`]): o `identify`
//!   nativo do `adom-sources` ainda não é alcançável de fora do crate (módulo
//!   `tmdb` privado), então o adaptador de TMDB mora na fiação. O contrato é o
//!   mesmo dos quatro vereditos (`identified|unidentified|ambiguous|unavailable`).
//!
//! Caminho de uma página: [`Ingest::apply_page`] resolve a obra (IMDb declarado
//! ou `identify`), monta as locações com [`page_locations`] (grupos primeiro,
//! depois as releases avulsas na raiz; `unlocated` NÃO é gravado) e grava cada
//! locação pelo MESMO caminho de [`Ingest::record`] (filtro → banco vivo →
//! barreira → índice → transição BR).

mod catalog;
mod locate;
// Adaptadores de produção das costuras: TMDB nativo e a ponte admin do
// `streams.db` do gateway (o sidecar é outro processo).
mod native;
// O laço da página (`apply*`) e o SQL dos bancos ficaram em módulos próprios
// pela catraca de 400 linhas.
mod page;
mod record;
mod store;

#[cfg(test)]
#[path = "native_tests.rs"]
mod native_tests;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
#[cfg(test)]
#[path = "tests_harness.rs"]
mod tests_harness;

use std::fmt;

use adom_core::WorkTarget;

pub use adom_core::BrTransition;
pub use adom_search::RawItem;
pub use adom_store::{IndexedRelease, WorkCtx};

pub use catalog::{
    BoxFuture, IdentifyRequest, IdentifyVerdict, ObraCatalog, PageVerdict, StreamInvalidator,
    StreamsInvalidator, WorkKind, WorkNames,
};
pub use locate::{page_locations, parse_size_bytes, raw_item, raw_items, PageLocation};
pub use native::{AdminStreamInvalidator, TmdbCatalog};
pub use record::Ingest;
pub use store::{IngestStore, NativeStore};

/// Obra de uma página já identificada (o motor não grava obra sem IMDb).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrawlObra {
    pub imdb: String,
    pub title: String,
    pub year: Option<i64>,
    pub kind: WorkKind,
}

/// Cerca do passo: `true` = o passo estourou o prazo e não pode mais gravar.
///
/// `Send + Sync` porque o futuro da página roda dentro de `tokio::spawn` no
/// motor: sem os bounds, o `Ingest::apply_page` deixaria de ser `Send` e o
/// passo não poderia ser despachado em paralelo.
pub type AbortCheck<'a> = &'a (dyn Fn() -> bool + Send + Sync);

/// O `options` do `record` do TS (`{ shouldAbort }`).
///
/// O nome não é `RecordOptions` para não colidir com o `RecordOptions` do
/// `adom-store` (as opções do índice, usadas internamente).
#[derive(Clone, Copy, Default)]
pub struct IngestOptions<'a> {
    pub should_abort: Option<AbortCheck<'a>>,
}

/// Resultado de UMA locação (o `RecordReport` do TS).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordReport {
    /// Releases que sobreviveram ao filtro (as que foram ao índice).
    pub kept: usize,
    /// Hashes NOVOS que ficaram no índice (pós-corte protegido).
    pub added: usize,
    pub transition: BrTransition,
    pub invalidated: bool,
}

impl Default for RecordReport {
    fn default() -> Self {
        Self {
            kept: 0,
            added: 0,
            transition: BrTransition::None,
            invalidated: false,
        }
    }
}

/// Nota do que a página virou quando NÃO houve gravação.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageMark {
    /// Status `error` do motor: a página falhou antes de haver obra para gravar.
    Error,
    /// Status `no-work` do motor: já marcado no `crawl.db`, nada a gravar.
    NoWork,
    /// Sem IMDb e sem release nenhuma a gravar: o TMDB não é consultado.
    NoImdb,
    /// Homônimo: DUAS ou mais obras casaram — terminal por segurança.
    Ambiguous,
    /// Decisão autoritativa do catálogo: não identificou — terminal.
    Unidentified,
    /// Catálogo fora/timeout: retentável, NÃO é veredito.
    Unavailable,
}

impl PageMark {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::NoWork => "no-work",
            Self::NoImdb => "no-imdb",
            Self::Ambiguous => "ambiguous",
            Self::Unidentified => "unidentified",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Resultado de UMA página (o corpo do `200` da rota do Node).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageReport {
    /// Obras identificadas e gravadas (0 ou 1 por página).
    pub works: usize,
    /// Soma de `kept` das locações.
    pub releases: usize,
    /// Soma de `added` das locações.
    pub index_rows: usize,
    pub mark: Option<PageMark>,
    /// Motivo curto do veredito do catálogo (painel/log).
    pub reason: Option<String>,
    /// `true` só para falha transitória (`unavailable`, store, prazo).
    pub retryable: bool,
    pub imdb: Option<String>,
}

/// Config do processo que o filtro de título lê (o `config.search` do Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestConfig {
    /// `TITLE_PRECISION_TAIL_CUT` (default `true`; só `"false"` desliga).
    pub title_precision_tail_cut: bool,
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            title_precision_tail_cut: true,
        }
    }
}

impl IngestConfig {
    /// Lê a MESMA env do coletor da busca (`adom-search`), default `true`.
    pub fn from_env() -> Self {
        Self {
            title_precision_tail_cut: std::env::var("TITLE_PRECISION_TAIL_CUT")
                .map(|value| value.trim() != "false")
                .unwrap_or(true),
        }
    }
}

/// Falha da ingestão. `retryable()` espelha as respostas do Node: `500` para o
/// que o motor reentrega com backoff, `200` para o que é veredito terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestError {
    /// Passo fora do prazo (`shouldAbort`): não inicia nem continua escrita.
    Aborted,
    /// O catálogo não devolveu nomes: filtro sem contexto é chute.
    CatalogNoNames,
    /// Fila do banco vivo cheia: nada entrou (sem half-write).
    QueueDropped,
    /// Barreira de persistência: o lote do banco vivo não efetivou.
    FlushFailed,
    /// I/O de SQLite (captura, índice ou leitura).
    Store(String),
}

impl IngestError {
    /// Rótulo estável (o `error` do log/relatório).
    pub fn as_str(&self) -> &str {
        match self {
            Self::Aborted => "crawl-abortado: passo fora do prazo",
            Self::CatalogNoNames => "catalogo-sem-nomes",
            Self::QueueDropped => "magnetbank-queue-dropped",
            Self::FlushFailed => "magnetbank-flush-falhou",
            Self::Store(err) => err,
        }
    }

    /// Só o passo abortado é terminal; todo o resto merece reentrega.
    pub fn retryable(&self) -> bool {
        !matches!(self, Self::Aborted)
    }
}

impl fmt::Display for IngestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::error::Error for IngestError {}

/// `WorkTarget` da locação a partir dos campos crus do grupo (u32 do motor).
pub(crate) fn location_target(season: Option<u32>, episode: Option<u32>) -> WorkTarget {
    WorkTarget {
        season: season.map(i64::from),
        episode: episode.map(i64::from),
    }
}

/// Cerca do passo: o `checkAbort` do TS, chamado ANTES de cada escrita.
pub(crate) fn check_abort(options: &IngestOptions<'_>) -> Result<(), IngestError> {
    match options.should_abort {
        Some(should_abort) if should_abort() => Err(IngestError::Aborted),
        _ => Ok(()),
    }
}
