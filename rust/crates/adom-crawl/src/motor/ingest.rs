//! Costura da INGESTÃO NATIVA no motor (T3-L3).
//!
//! O passo de uma página tem duas metades: a engine lê/parseia (prazo duro) e a
//! ingestão grava (banco vivo → índice → invalidação). O motor não conhece o
//! [`Ingest`] concreto — conhece [`PageIngest`] — para o teste provar a chamada
//! sem abrir SQLite nem tocar rede, e para a composição de produção injetar o
//! objeto já montado (`NativeStore` + TMDB + ponte admin).
//!
//! Sem ingestão o tick NÃO reivindica URL (`ingest-pendente`): cada
//! `mark_result` consome `tries`, e entregar página sem quem grave a queimaria.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::ingest::{
    Ingest, IngestError, IngestOptions, IngestStore, ObraCatalog, PageReport, StreamInvalidator,
};
use crate::motor::r#loop::CrawlMotor;
use crate::motor::types::CrawlWorkResult;

/// Futuro boxed de UMA página ingestada (mesma régua do `PageFuture`).
pub type IngestFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PageReport, IngestError>> + Send + 'a>>;

/// Quem grava a página concluída. `Send + Sync` porque roda em `tokio::spawn`.
pub trait PageIngest: Send + Sync {
    fn apply_page<'a>(
        &'a self,
        site: &'a str,
        page: &'a CrawlWorkResult,
        now_ms: i64,
        options: IngestOptions<'a>,
    ) -> IngestFuture<'a>;
}

/// O `Ingest` de produção (e os de teste) entram no motor por esta porta.
impl<S, C, I> PageIngest for Ingest<S, C, I>
where
    S: IngestStore,
    C: ObraCatalog,
    I: StreamInvalidator,
{
    fn apply_page<'a>(
        &'a self,
        site: &'a str,
        page: &'a CrawlWorkResult,
        now_ms: i64,
        options: IngestOptions<'a>,
    ) -> IngestFuture<'a> {
        Box::pin(async move {
            // Método INERENTE do `Ingest` (a trait só repassa o mesmo contrato).
            self.apply_page(site, page, now_ms, options).await
        })
    }
}

impl CrawlMotor {
    /// Liga a ingestão nativa, montada UMA vez pela fiação (nada de abrir
    /// banco por página). Sem isto o tick devolve `ingest-pendente`.
    pub fn with_ingest(mut self, ingest: Arc<dyn PageIngest>) -> Self {
        self.ingest = Some(ingest);
        self
    }

    /// A ingestão está plugada? Diagnóstico do painel/testes.
    pub fn ingest_ready(&self) -> bool {
        self.ingest.is_some()
    }
}

/// `PageIngest` de mentira para os testes do motor: conta chamadas, avalia a
/// cerca do passo e devolve o relatório pedido. Sem banco, sem rede.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    use crate::ingest::{IngestError, IngestOptions, PageMark, PageReport};
    use crate::motor::types::CrawlWorkResult;

    use super::{IngestFuture, PageIngest};

    pub(crate) struct FakeIngest {
        resultado: Mutex<Result<PageReport, IngestError>>,
        calls: AtomicUsize,
        abort_present: AtomicBool,
        abort_at_call: AtomicBool,
    }

    impl FakeIngest {
        fn novo(resultado: Result<PageReport, IngestError>) -> Self {
            Self {
                resultado: Mutex::new(resultado),
                calls: AtomicUsize::new(0),
                abort_present: AtomicBool::new(false),
                abort_at_call: AtomicBool::new(false),
            }
        }

        /// Veredito aceito: a linha fecha (ou volta com backoff pelo status).
        pub(crate) fn delivered() -> Self {
            Self::novo(Ok(PageReport::default()))
        }

        /// Catálogo fora: `retryable`, como o 500 que o Node devolvia.
        pub(crate) fn retryable() -> Self {
            Self::novo(Ok(PageReport {
                mark: Some(PageMark::Unavailable),
                reason: Some("tmdb-indisponivel".to_string()),
                retryable: true,
                ..PageReport::default()
            }))
        }

        /// Erro de store/catálogo: mesmo efeito do 500 (reentrega).
        pub(crate) fn failing() -> Self {
            Self::novo(Err(IngestError::Store("sqlite quebrado".to_string())))
        }

        pub(crate) fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        pub(crate) fn abort_present(&self) -> bool {
            self.abort_present.load(Ordering::SeqCst)
        }

        /// Valor da cerca NO MOMENTO da chamada (`true` = passo já estourou).
        pub(crate) fn abort_at_call(&self) -> bool {
            self.abort_at_call.load(Ordering::SeqCst)
        }
    }

    impl PageIngest for FakeIngest {
        fn apply_page<'a>(
            &'a self,
            _site: &'a str,
            _page: &'a CrawlWorkResult,
            _now_ms: i64,
            options: IngestOptions<'a>,
        ) -> IngestFuture<'a> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            match options.should_abort {
                Some(should_abort) => {
                    self.abort_present.store(true, Ordering::SeqCst);
                    self.abort_at_call.store(should_abort(), Ordering::SeqCst);
                }
                None => self.abort_present.store(false, Ordering::SeqCst),
            }
            let resultado = self
                .resultado
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .clone();
            Box::pin(async move { resultado })
        }
    }
}
