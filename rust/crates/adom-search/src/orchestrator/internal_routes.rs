//! As quatro rotas internas que o orquestrador consome, atrás de uma trait.
//!
//! Em produção o adaptador é [`NodeRoutes`], sobre o `InternalSearchClient`
//! (loopback + `X-Indexer-Test-Token` + `encoded` no corpo). Em teste é um
//! stub que devolve metadados/coleta/escrita gravados — nenhuma chamada de
//! rede, nenhum servidor.
//!
//! Por que uma trait e não o cliente direto: os testes do orquestrador não
//! podem depender de um Node no ar, e a fronteira do strangler é justamente
//! esta — enquanto a coleta não migra, o "lado Node" é substituível.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::internal_client::InternalSearchClient;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse,
};

/// Futuro das rotas internas (boxed: trait object estável sem `async_trait`).
pub type RouteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// `POST /internal/search/*` do Node.
pub trait InternalRoutes: Send + Sync {
    fn meta<'a>(&'a self, req: MetaRequest) -> RouteFuture<'a, MetaResponse>;
    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse>;
    fn index_write<'a>(&'a self, req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse>;
    fn effects<'a>(&'a self, req: EffectsRequest) -> RouteFuture<'a, EffectsResponse>;
}

/// Produção: o cliente HTTP já portado (`internal_client`).
#[derive(Clone)]
pub struct NodeRoutes {
    client: Arc<InternalSearchClient>,
}

impl NodeRoutes {
    pub fn new(client: InternalSearchClient) -> Self {
        NodeRoutes {
            client: Arc::new(client),
        }
    }

    /// `INTERNAL_SEARCH_URL` + `JACKETT_TEST_TOKEN` do ambiente. `None` sem
    /// token — sem ele o Node responde 503 de qualquer forma.
    pub fn from_env() -> Option<Self> {
        InternalSearchClient::from_env().map(Self::new)
    }
}

impl InternalRoutes for NodeRoutes {
    fn meta<'a>(&'a self, req: MetaRequest) -> RouteFuture<'a, MetaResponse> {
        Box::pin(async move { self.client.meta(&req).await })
    }

    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse> {
        Box::pin(async move { self.client.collect(&req).await })
    }

    fn index_write<'a>(&'a self, req: IndexWriteRequest) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async move { self.client.index_write(&req).await })
    }

    fn effects<'a>(&'a self, req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move { self.client.effects(&req).await })
    }
}
