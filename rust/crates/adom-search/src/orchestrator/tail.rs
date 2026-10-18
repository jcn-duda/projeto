//! Fila tardia: o trabalho que NÃO entra na resposta.
//!
//! Estrutura (e só a estrutura) do `enqueueTail` do TS: uma fila SERIAL por
//! busca, disparada em `tokio::spawn` depois que a resposta já foi montada.
//! Os três trabalhos do TS estão nomeados:
//!
//! - **enriquecimento do índice** — o que a coleta provou vai para
//!   `POST /internal/search/index-write` (release index + marca no banco de
//!   magnets). É o único que roda em TODA busca;
//! - **refresh do debrid** — quando a checagem saiu `Unknown`, reconstrói a
//!   lista sem prazo de cliente (`finish` de novo) e reescreve o cache;
//! - **varredura pt-BR** nos globais — quando a coleta foi PARCIAL (o inline
//!   da janela já rodou a varredura quando ela terminou).
//!
//! Os EFEITOS em si (autofetch, warmer, auditoria de áudio, sonda BR,
//! colhedor, chave de temporada) são entregues por [`TailEffects`]; em
//! produção [`NodeTailEffects`] chama `POST /internal/search/effects`
//! (fire-and-forget, 202). Nesta fatia o orquestrador ainda NÃO DECIDE efeitos
//! (a decisão mora no pipeline de debrid, que continua no Node): o lote sai
//! vazio e a interface fica pronta para a fatia que os ligar.
//!
//! Regra que a fila carrega do TS: um trabalho que falha não derruba os
//! outros e nunca afeta quem já recebeu a lista.

use std::sync::Arc;

use crate::internal_types::{
    EffectEntry, EffectsRequest, EffectsResponse, IndexWriteRequest, IndexWriteResponse,
    ReleaseEntry,
};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};
use crate::orchestrator::meta::SearchMeta;

/// Lote de escrita do índice (uma ou mais obras/episódios).
#[derive(Debug, Clone)]
pub struct IndexBatch {
    pub encoded: String,
    pub releases: Vec<ReleaseEntry>,
}

/// Lote de efeitos (fire-and-forget).
#[derive(Debug, Clone)]
pub struct EffectsBatch {
    pub encoded: String,
    pub effects: Vec<EffectEntry>,
}

/// Efeitos tardios do Node. Produção: [`NodeTailEffects`]; teste: gravador.
pub trait TailEffects: Send + Sync {
    fn index_write<'a>(&'a self, batch: IndexBatch) -> RouteFuture<'a, IndexWriteResponse>;
    fn effects<'a>(&'a self, batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse>;
}

/// Produção: `index-write` + `effects` pelas rotas internas.
pub struct NodeTailEffects {
    routes: Arc<dyn InternalRoutes>,
}

impl NodeTailEffects {
    pub fn new(routes: Arc<dyn InternalRoutes>) -> Self {
        NodeTailEffects { routes }
    }
}

impl TailEffects for NodeTailEffects {
    fn index_write<'a>(&'a self, batch: IndexBatch) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async move {
            self.routes
                .index_write(IndexWriteRequest {
                    encoded: batch.encoded,
                    releases: batch.releases,
                })
                .await
        })
    }

    fn effects<'a>(&'a self, batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async move {
            self.routes
                .effects(EffectsRequest {
                    encoded: batch.encoded,
                    effects: batch.effects,
                })
                .await
        })
    }
}

/// Sem efeitos: o orquestrador funciona (resposta e cache) e nada é entregue ao
/// Node. É o default do crate até a integração escolher `NodeTailEffects`.
pub struct NoopTailEffects;

impl TailEffects for NoopTailEffects {
    fn index_write<'a>(&'a self, _batch: IndexBatch) -> RouteFuture<'a, IndexWriteResponse> {
        Box::pin(async {
            Ok(IndexWriteResponse {
                ok: true,
                recorded: 0,
                entries: 0,
                bank_marked: 0,
                failed: 0,
            })
        })
    }

    fn effects<'a>(&'a self, _batch: EffectsBatch) -> RouteFuture<'a, EffectsResponse> {
        Box::pin(async {
            Ok(EffectsResponse {
                ok: true,
                accepted: 0,
                rejected: 0,
            })
        })
    }
}

/// Um trabalho tardio. A ordem de execução é a da lista.
#[derive(Debug, Clone)]
pub enum TailJob {
    /// Grava o lote pós-filtro no índice de releases.
    IndexEnrich { releases: Vec<ReleaseEntry> },
    /// Refaz a checagem do debrid sem prazo de cliente e regrava o cache.
    DebridRefresh,
    /// Varredura pt-BR nos globais (só quando a coleta foi parcial).
    PtSweep {
        /// Prazo absoluto do passe tardio (sem deadline de cliente).
        deadline_at: i64,
    },
}

/// Tudo que o trabalho tardio precisa, já estabilizado (nada de referência à
/// requisição que morreu). O LOTE completo chega pelo `completion` da janela.
#[derive(Debug, Clone)]
pub struct TailPlan {
    pub encoded: String,
    pub meta: SearchMeta,
    pub jobs: Vec<TailJob>,
}

impl TailPlan {
    pub fn is_empty(&self) -> bool {
        self.jobs.is_empty()
    }
}
