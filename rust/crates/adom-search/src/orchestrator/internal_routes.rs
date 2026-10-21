//! As rotas internas que o orquestrador ainda consome, atrás de uma trait.
//!
//! Em produção o adaptador é [`NodeRoutes`], sobre o `InternalSearchClient`
//! (loopback + `X-Indexer-Test-Token` + `encoded` no corpo). Em teste é um
//! stub que devolve metadados/coleta/efeitos gravados — nenhuma chamada de
//! rede, nenhum servidor.
//!
//! Índice de releases e banco de magnets NÃO passam mais por aqui (R4): são
//! nativos (`IdxStore`/`MagnetBankStore`). O único resíduo do Node é o replay
//! congelado (`fallback_injected`), que injeta o RESULTADO gravado do caso.
//!
//! Por que uma trait e não o cliente direto: os testes do orquestrador não
//! podem depender de um Node no ar, e a fronteira do strangler é justamente
//! esta — enquanto a coleta não migra, o "lado Node" é substituível.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::internal_client::InternalSearchClient;
use crate::internal_types::{
    CollectRequest, CollectResponse, EffectsRequest, EffectsResponse, MetaRequest, MetaResponse,
};

/// Futuro das rotas internas (boxed: trait object estável sem `async_trait`).
pub type RouteFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

/// `POST /internal/search/*` do Node.
pub trait InternalRoutes: Send + Sync {
    fn meta<'a>(&'a self, req: MetaRequest) -> RouteFuture<'a, MetaResponse>;
    fn collect<'a>(&'a self, req: CollectRequest) -> RouteFuture<'a, CollectResponse>;
    fn effects<'a>(&'a self, req: EffectsRequest) -> RouteFuture<'a, EffectsResponse>;

    /// Itens da reserva 📦 JÁ CALCULADOS pelo Node (`collectFallbackForBuild`).
    ///
    /// `None` = sem atalho (produção e dublês): o núcleo decide a reserva a
    /// partir do banco NATIVO. O replay congelado usa `Some(items)` porque o
    /// caso grava o RESULTADO (`inputs/fallback.json`), não as linhas do banco
    /// — sem isto a reserva some da lista e todo item dela perde o selo 📦
    /// (medido: dragon-ball-z, dahmer, naruto).
    fn fallback_injected<'a>(&'a self) -> RouteFuture<'a, Option<Vec<serde_json::Value>>> {
        Box::pin(async { Ok(None) })
    }
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

    fn effects<'a>(&'a self, req: EffectsRequest) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move { self.client.effects(&req).await })
    }
}
