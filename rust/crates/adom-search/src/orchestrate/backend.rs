//! Backend injetável das rotas internas (`InternalSearchClient` + stubs).

use std::future::Future;
use std::pin::Pin;

use crate::internal_client::InternalSearchClient;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, IndexWriteRequest,
    IndexWriteResponse, MetaRequest, MetaResponse, StateRequest, StateResponse,
};

/// Future pinada do backend injetável.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Cliente das rotas internas — `InternalSearchClient` e stubs de teste.
pub trait SearchBackend: Send + Sync {
    fn meta<'a>(&'a self, req: &'a MetaRequest) -> BoxFut<'a, Result<MetaResponse, String>>;
    fn state<'a>(&'a self, req: &'a StateRequest) -> BoxFut<'a, Result<StateResponse, String>>;
    fn collect<'a>(
        &'a self,
        req: &'a CollectRequest,
    ) -> BoxFut<'a, Result<CollectResponse, String>>;
    fn index_write<'a>(
        &'a self,
        req: &'a IndexWriteRequest,
    ) -> BoxFut<'a, Result<IndexWriteResponse, String>>;
    fn effects<'a>(
        &'a self,
        req: &'a EffectsRequest,
    ) -> BoxFut<'a, Result<EffectsResponse, String>>;
}

impl SearchBackend for InternalSearchClient {
    fn meta<'a>(&'a self, req: &'a MetaRequest) -> BoxFut<'a, Result<MetaResponse, String>> {
        Box::pin(InternalSearchClient::meta(self, req))
    }
    fn state<'a>(&'a self, req: &'a StateRequest) -> BoxFut<'a, Result<StateResponse, String>> {
        Box::pin(InternalSearchClient::state(self, req))
    }
    fn collect<'a>(
        &'a self,
        req: &'a CollectRequest,
    ) -> BoxFut<'a, Result<CollectResponse, String>> {
        Box::pin(InternalSearchClient::collect(self, req))
    }
    fn index_write<'a>(
        &'a self,
        req: &'a IndexWriteRequest,
    ) -> BoxFut<'a, Result<IndexWriteResponse, String>> {
        Box::pin(InternalSearchClient::index_write(self, req))
    }
    fn effects<'a>(
        &'a self,
        req: &'a EffectsRequest,
    ) -> BoxFut<'a, Result<EffectsResponse, String>> {
        Box::pin(InternalSearchClient::effects(self, req))
    }
}
