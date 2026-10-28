//! Contrato de I/O para um futuro worker. Esta interface não executa rede,
//! não escolhe candidatos nem autoriza exclusões; adaptadores são injetados.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use super::QueueCandidate;

pub type DebridFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnqueueEvidence {
    pub accepted: bool,
    pub transfer_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheEvidence {
    /// `false` é desconhecido, não uma lista de misses.
    pub known: bool,
    pub cached: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TorrentEvidence {
    /// `ready`, `dead`, `downloading` ou `unknown`.
    pub state: String,
    pub stalled: bool,
    pub transfer_id: Option<String>,
    /// Verdadeiro quando a identificação foi feita somente pelo id.
    pub via_id: bool,
    pub progress: Option<TorrentProgress>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TorrentProgress {
    pub bytes: Option<f64>,
    pub total: Option<f64>,
    pub speed: Option<f64>,
    pub seeders: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEvidence {
    /// Ocupação desconhecida permanece `None`, nunca zero inferido.
    pub used: Option<u64>,
    pub max: Option<u64>,
}

/// Adaptador vinculado à conta pelo executor; o contrato não passa chave de
/// API no payload nem permite interpretar ausência de resposta como morte.
/// `remove`/`evict` só podem ser chamados após os gates de posse e proteção.
pub trait AutofetchDebrid: Send + Sync {
    type Error: Send;

    fn enqueue<'a>(
        &'a self,
        candidate: &'a QueueCandidate,
    ) -> DebridFuture<'a, EnqueueEvidence, Self::Error>;
    fn status<'a>(
        &'a self,
        hashes: &'a [String],
        transfer_ids: &'a BTreeMap<String, String>,
    ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, Self::Error>;
    fn check<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, CacheEvidence, Self::Error>;
    fn remove<'a>(&'a self, transfer_id: &'a str) -> DebridFuture<'a, bool, Self::Error>;
    fn evict<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, Vec<String>, Self::Error>;
    fn account(&self) -> DebridFuture<'_, AccountEvidence, Self::Error>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::task::{Context, Poll, Waker};

    struct Stub;
    impl AutofetchDebrid for Stub {
        type Error = ();
        fn enqueue<'a>(&'a self, _: &'a QueueCandidate) -> DebridFuture<'a, EnqueueEvidence, ()> {
            Box::pin(async {
                Ok(EnqueueEvidence {
                    accepted: true,
                    transfer_id: Some("42".into()),
                })
            })
        }
        fn status<'a>(
            &'a self,
            _: &'a [String],
            _: &'a BTreeMap<String, String>,
        ) -> DebridFuture<'a, BTreeMap<String, TorrentEvidence>, ()> {
            Box::pin(async { Ok(BTreeMap::new()) })
        }
        fn check<'a>(&'a self, _: &'a [String]) -> DebridFuture<'a, CacheEvidence, ()> {
            Box::pin(async {
                Ok(CacheEvidence {
                    known: false,
                    cached: Vec::new(),
                })
            })
        }
        fn remove<'a>(&'a self, _: &'a str) -> DebridFuture<'a, bool, ()> {
            Box::pin(async { Ok(false) })
        }
        fn evict<'a>(&'a self, _: &'a [String]) -> DebridFuture<'a, Vec<String>, ()> {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn account(&self) -> DebridFuture<'_, AccountEvidence, ()> {
            Box::pin(async {
                Ok(AccountEvidence {
                    used: None,
                    max: None,
                })
            })
        }
    }
    #[test]
    fn contrato_pode_ser_exercitado_com_stub_sem_rede() {
        let mut future = Stub.check(&[]);
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(
            future.as_mut().poll(&mut cx),
            Poll::Ready(Ok(CacheEvidence {
                known: false,
                cached: Vec::new()
            }))
        );
    }
}
