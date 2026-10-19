//! MONTAGEM do orquestrador do `GET /:encoded/stream/:type/:id.json`.
//!
//! A ordem é a de `src/providers/search-cache.ts` + `search-orchestrator.ts`:
//!
//! 1. **identidade** — config do `encoded` (URL), chave SWR `streams:v21`,
//!    prazo por User-Agent (Stremio × app `Dart/`);
//! 2. **SWR** — hit completo serve na hora; hit na graça serve E revalida em
//!    fundo (mapa `refreshing` separado do `inFlight`); incompleto é miss;
//! 3. **coalescing** — buscas idênticas simultâneas dividem UMA computação;
//! 4. **busca** — metadados → plano (`search_plan`) → janela
//!    (`collect_within_window`) com a coleta INJETADA (trait [`Collector`]),
//!    orçamento = prazo − reserva de debrid, graça para a 1ª fonte BR;
//! 5. **build** — `build_stream_list` com o `DebridCheck` injetado; a URL de
//!    `/resolve` (HMAC) é materializada AQUI, porque o segredo/prefixo são da
//!    requisição;
//! 6. **fim** — `search_finish` do núcleo (`commit_decision` / promoção
//!    tardia), `cacheMaxAge`, e o host só na resposta (`apply_notice_origin`);
//! 7. **fila tardia** — `tokio::spawn` com o lote completo, index-write,
//!    refresh do debrid e varredura pt-BR (efeitos por [`TailEffects`]).
//!
//! Corte EXTERNO: a busca corre numa task própria; o cliente espera
//! `reply_ms` e, se o prazo vencer, recebe `partial` com o aviso
//! "Procurando fontes — reabra em instantes" e `cacheMaxAge: 0`. A task NÃO é
//! cancelada: quando a coleta estabiliza, o passe tardio regrava o cache
//! (mesmo cache ≤ 60 s e host fora dele). Nunca 500: falha de collector vira
//! lista vazia + aviso, como o handler do Node (`stream.ts`).

mod bludv_collector;
mod collect;
mod composite_collector;
mod config;
mod fast_path;
mod finish;
mod internal_routes;
mod jackett_collector;
mod late;
mod live_state;
mod meta;
mod meta_load;
mod mico_collector;
mod pack;
mod prowlarr_collector;
mod respond;
mod search;
mod sources_rust;
mod tail;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
mod torrentio_collector;
mod trace;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::cache::{swr_lookup, SwrLookup, SwrStore};
use crate::coalesce::InFlight;
use crate::contract::StreamResponse;
use crate::request::{encoded_for_internal, reply_deadline_ms, request_cache_key};

use finish::SearchInput;
use respond::{as_ms, empty_response, now_ms};

pub use bludv_collector::{
    sources_rust_includes_bludv, try_bludv_collector_from_env, BludvCollector,
};
pub use collect::{plan_jobs, CollectBatch, CollectJob, Collector, NodeCollector};
pub use composite_collector::CompositeCollector;
pub use config::{
    build_options_from, AdapterDebridFactory, DebridContext, DebridFactory, NoDebridCheck,
    NoDebridFactory, OrchestratorConfig,
};
pub use internal_routes::{InternalRoutes, NodeRoutes, RouteFuture};
pub use jackett_collector::{
    plan_jackett_searches, sources_rust_includes_jackett, try_jackett_collector_from_env,
    JackettCollector, PlannedJackettSearch,
};
pub use live_state::{
    live_state_snapshot, merge_states, shared_live_state, LiveAllState, LiveBatchState,
    SharedLiveState,
};
pub use meta::{meta_from_response, MetaQuery, MetaSource, NodeMetaSource, SearchMeta};
pub use mico_collector::{sources_rust_includes_mico, try_mico_collector_from_env, MicoCollector};
pub use prowlarr_collector::{
    sources_rust_includes_prowlarr, try_prowlarr_collector_from_env, ProwlarrCollector,
};
pub use respond::{SearchOutcome, StreamRequest, NOTICE_SEARCHING};
pub use sources_rust::{
    sources_rust_csv_includes, sources_rust_csv_winner, sources_rust_includes,
    try_sources_rust_collector_from_env, try_sources_rust_collectors_from_env,
    try_sources_rust_native_from_env,
};
pub use tail::{
    EffectsBatch, IndexBatch, NodeTailEffects, NoopTailEffects, TailEffects, TailJob, TailPlan,
};
pub use torrentio_collector::{
    sources_rust_includes_torrentio, try_torrentio_collector_from_env, TorrentioCollector,
};
pub use trace::{new_trace, TraceInput, TraceRecord, TraceResponseFacts};

/// O orquestrador. Clonável e barato: tudo atrás de `Arc`.
#[derive(Clone)]
pub struct Orchestrator {
    config: Arc<OrchestratorConfig>,
    store: Arc<dyn SwrStore>,
    collector: Arc<dyn Collector>,
    meta: Arc<dyn MetaSource>,
    debrid: Arc<dyn DebridFactory>,
    tail: Arc<dyn TailEffects>,
    in_flight: Arc<InFlight<Arc<SearchOutcome>>>,
    refreshing: Arc<Mutex<HashSet<String>>>,
    /// `true` = sombra §9.1: sem debrid, sem gravar SWR, sem fila tardia /
    /// index-write / effects / refresh em fundo. Só produz corpo para comparar.
    shadow_mode: bool,
    /// Rotas internas do Node (`/internal/search/*`), para leitura de metadados,
    /// índice de releases e banco instantâneo.
    routes: Option<Arc<dyn InternalRoutes>>,
}

/// Collector que falha sempre: default do crate até a integração injetar o
/// `NodeCollector`. A busca responde lista vazia + aviso — nunca 500.
struct UnavailableCollector;

impl Collector for UnavailableCollector {
    fn collect<'a>(
        &'a self,
        _job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async { Err("collector não configurado".to_string()) })
    }
}

/// `MetaSource` mínimo: deriva do id (sem rede). É o default do crate e o
/// fallback de quem não injetou o Node.
struct IdOnlyMeta;

impl MetaSource for IdOnlyMeta {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move { Ok(SearchMeta::from_id(&req.id)) })
    }
}

impl Orchestrator {
    /// Só a config e o store SWR são obrigatórios; o resto degrada para um
    /// stub que NÃO inventa resultado (collector erra, meta lê o id, debrid
    /// não responde, efeitos não são entregues).
    pub fn new(config: OrchestratorConfig, store: Arc<dyn SwrStore>) -> Self {
        Orchestrator {
            config: Arc::new(config),
            store,
            collector: Arc::new(UnavailableCollector),
            meta: Arc::new(IdOnlyMeta),
            debrid: Arc::new(AdapterDebridFactory::default()),
            tail: Arc::new(NoopTailEffects),
            in_flight: Arc::new(InFlight::new()),
            refreshing: Arc::new(Mutex::new(HashSet::new())),
            shadow_mode: false,
            routes: None,
        }
    }

    pub fn with_collector(mut self, collector: Arc<dyn Collector>) -> Self {
        self.collector = collector;
        self
    }

    pub fn with_meta(mut self, meta: Arc<dyn MetaSource>) -> Self {
        self.meta = meta;
        self
    }

    pub fn with_debrid(mut self, debrid: Arc<dyn DebridFactory>) -> Self {
        self.debrid = debrid;
        self
    }

    pub fn with_tail(mut self, tail: Arc<dyn TailEffects>) -> Self {
        self.tail = tail;
        self
    }

    /// Liga o modo sombra (§9.1): compare-only — sem efeitos colaterais.
    pub fn with_shadow_mode(mut self, enabled: bool) -> Self {
        self.shadow_mode = enabled;
        self
    }

    /// Liga coleta/metadados/efeitos no cliente HTTP das rotas internas.
    pub fn with_routes(mut self, routes: Arc<dyn InternalRoutes>) -> Self {
        self.collector = Arc::new(NodeCollector::new(routes.clone()));
        self.meta = Arc::new(NodeMetaSource::new(routes.clone()));
        self.tail = Arc::new(NodeTailEffects::new(routes.clone()));
        self.routes = Some(routes);
        self
    }

    /// Injeta explicitamente as rotas internas (ex.: quando collector é composto).
    pub fn with_internal_routes(mut self, routes: Arc<dyn InternalRoutes>) -> Self {
        self.routes = Some(routes);
        self
    }

    pub fn config(&self) -> &OrchestratorConfig {
        &self.config
    }

    /// `true` quando montado para sombra compare-only (§9.1).
    pub fn shadow_mode(&self) -> bool {
        self.shadow_mode
    }

    /// Quantas buscas estão coalescendo agora (snapshot do painel).
    pub fn searches_in_flight(&self) -> usize {
        self.in_flight.len()
    }

    /// A rota: devolve SEMPRE `StreamResponse` (o `/stream` quase não usa
    /// status de erro — não-200 é "addon quebrado" para o Stremio).
    pub async fn handle(&self, req: StreamRequest) -> StreamResponse {
        let now = req.now_ms.unwrap_or_else(now_ms);
        if !req.id.starts_with("tt") {
            return empty_response();
        }
        let prefix = req.prefix();
        let options = self.resolve_options(&req.encoded);
        let key = request_cache_key(&req.kind, &req.id, &self.key_options(&options));
        let reply_ms = reply_deadline_ms(
            req.user_agent.as_deref(),
            self.config.stremio_reply_ms,
            self.config.app_reply_ms,
        );
        let deadline_at = Some(now.saturating_add(reply_ms as i64));

        // SWR: `getWithStale` (não `get`) — a entrada expirada DENTRO da graça
        // é justamente a que o SWR quer servir enquanto revalida.
        let hit = self
            .store
            .get_with_stale(&key, self.config.stale_grace_seconds, as_ms(now));
        match swr_lookup(hit) {
            SwrLookup::Serve { entry, revalidate } => {
                // Sombra não revalida em fundo (não grava cache / não CHAMa debrid).
                if revalidate && !self.shadow_mode {
                    self.spawn_stale_refresh(key.clone(), req.clone(), options.clone());
                }
                return self.respond_entry(&entry, &req);
            }
            SwrLookup::Miss => {}
        }

        let input = SearchInput {
            kind: req.kind.clone(),
            id: req.id.clone(),
            encoded: Some(encoded_for_internal(req.encoded.as_deref())),
            prefix: prefix.clone(),
            options,
            key: key.clone(),
            now_ms: now,
            deadline_at,
        };
        // A busca corre numa TASK própria: o `timeout` abaixo corta só a
        // ESPERA. Se o prazo vencer, a task continua e o passe tardio grava.
        let task = tokio::spawn({
            let this = self.clone();
            let in_flight = self.in_flight.clone();
            let key = key.clone();
            async move {
                in_flight
                    .coalesce(&key, || async move { this.run_search(input).await })
                    .await
            }
        });
        let outcome = match tokio::time::timeout(Duration::from_millis(reply_ms), task).await {
            Ok(Ok(outcome)) => outcome,
            // Corrida perdida (prazo) ou task que panicou: o cliente recebe o
            // estado parcial do Node — aviso + cacheMaxAge 0.
            Ok(Err(_)) | Err(_) => {
                eprintln!(
                    "[search] prazo de {reply_ms}ms atingido para {}; segue em background",
                    req.id
                );
                return self.respond_notice(&req, NOTICE_SEARCHING);
            }
        };
        self.respond_outcome(&outcome, &req)
    }

    /// Config do usuário: overlay do segmento sobre os defaults do operador.
    /// Sem segmento, os defaults; config inválida cai nos defaults (o 404 de
    /// config inválida é do roteador HTTP, não deste crate).
    fn resolve_options(&self, encoded: &Option<String>) -> Value {
        match encoded {
            Some(segment) => adom_core::decode_config(
                segment,
                &self.config.defaults,
                &self.config.resolve_secret,
            )
            .unwrap_or_else(|| self.config.defaults.clone()),
            None => self.config.defaults.clone(),
        }
    }

    /// Opções que entram na CHAVE: as do usuário + `resolveUncached` do
    /// operador (muda a `url` de cada stream). Nunca o host.
    fn key_options(&self, options: &Value) -> Value {
        let mut out = options.clone();
        if let Some(map) = out.as_object_mut() {
            map.insert(
                "resolveUncached".to_string(),
                Value::Bool(self.config.resolve_uncached),
            );
        }
        out
    }
}
