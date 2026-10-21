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
// Inventário nativo da conta (F3): fonte, filtro, memo e fast-path.
mod account;
mod account_metrics;
mod account_shadow;
mod collect;
mod composite_collector;
mod config;
// Sombra/flag da checagem AllDebrid (F4.6): métricas `debrid.al.*`.
pub(crate) mod debrid_al_metrics;
pub(crate) mod debrid_shadow;
// Payloads dos efeitos de cauda (`EFFECTS_RUST`); a seleção mora no build.
mod effects;
mod fallback;
mod fast_path;
mod finish;
mod index_effects;
mod index_metrics;
mod index_source;
mod internal_routes;
mod jackett_collector;
mod jackett_live;
mod known_broken;
mod late;
mod live_state;
mod meta;
mod meta_load;
mod meta_native;
mod meta_shadow;
mod mico_collector;
mod native_index;
mod pack;
mod prowlarr_collector;
mod refresh;
mod respond;
mod search;
mod source_shadow;
mod sources_rust;
mod tail;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
// Gate de paridade congelada do `/stream` (`docs/stream-frozen-gate.md`): o
// alvo de integração `tests/stream_frozen_parity.rs` chama `run_all()` daqui,
// então o módulo NÃO é `cfg(test)` — `doc(hidden)` só evita que ele apareça
// como API do crate. O comando do gate é sem `--features`.
#[doc(hidden)]
pub mod frozen_gate;
mod torrentio_collector;
mod trace;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::DebridFile;

use serde_json::Value;

use crate::cache::{swr_lookup, SwrLookup, SwrStore};
use crate::coalesce::InFlight;
use crate::contract::StreamResponse;
use crate::request::{encoded_for_internal, reply_deadline_ms, request_cache_key};

use finish::SearchInput;
use respond::{as_ms, empty_response, now_ms};

pub use account::{
    account_raw_items, br_origin_only, fast_path_decision, sampled, signals_of,
    try_native_account_source, AccountInventorySource, AccountMode, AccountRequest, AccountSignals,
    FastPathDecision, NativeAccountConfig, NativeAccountSource, ENV as ACCOUNT_RUST_ENV,
    FAST_PATH_ENV as ACCOUNT_FAST_PATH_ENV, FAST_PATH_MIN_ENV as ACCOUNT_FAST_MIN_ENV,
    SHADOW_SAMPLE_ENV as ACCOUNT_SHADOW_SAMPLE_ENV,
};
pub use account_metrics::account_metrics_snapshot;
pub use account_shadow::spawn_shadow_compare;
pub use bludv_collector::{
    sources_rust_includes_bludv, try_bludv_collector_from_env,
    try_bludv_collector_from_env_with_store, BludvCollector,
};
pub use collect::{
    plan_jobs, CollectBatch, CollectJob, Collector, NodeCollector, RequestSelection,
};
pub use composite_collector::CompositeCollector;
pub use config::{
    build_options_from, AdapterDebridFactory, DebridContext, DebridFactory, NoDebridCheck,
    NoDebridFactory, OrchestratorConfig,
};
pub use debrid_shadow::debrid_al_metrics_snapshot;
pub use index_effects::{FollowUpKind, FollowUpPlan};
pub use index_metrics::index_metrics_snapshot;
pub use index_source::{
    allowed_source_indexer, bank_limits, bank_read_window, obra_targets, BankFilterCtx, BankLookup,
    IndexMode, IndexedReleaseWire, MagnetBankSource, ReleaseIndexSource, SharedBank, SharedIndex,
};
pub use internal_routes::{InternalRoutes, NodeRoutes, RouteFuture};
pub use jackett_collector::{
    plan_jackett_searches, sources_rust_includes_jackett, try_jackett_collector_from_env,
    JackettCollector, PlannedJackettSearch,
};
pub use known_broken::KnownBroken;
pub use live_state::{
    live_state_snapshot, merge_states, shared_live_state, LiveAllState, LiveBatchState,
    SharedLiveState,
};
pub use meta::{meta_from_response, MetaQuery, MetaSource, NodeMetaSource, SearchMeta};
pub use meta_native::{
    flag_enabled, meta_from_lookup, meta_rust_enabled, FallbackMetaSource, NativeMetaSource,
    DEFAULT_LOOKUP_TIMEOUT_MS, META_RUST_ENV,
};
pub use meta_shadow::{
    compare_meta, meta_shadow_enabled, meta_shadow_metrics_snapshot, meta_shadow_percent_from,
    meta_shadow_timeout_ms_from, sample_includes, wrap_meta_with_shadow, MetaComparison,
    MetaShadowMetrics, META_SHADOW_ENV, META_SHADOW_PERCENT_ENV, META_SHADOW_TIMEOUT_ENV,
};
pub use mico_collector::{sources_rust_includes_mico, try_mico_collector_from_env, MicoCollector};
pub use prowlarr_collector::{
    sources_rust_includes_prowlarr, try_prowlarr_collector_from_env, ProwlarrCollector,
};
pub use respond::{SearchOutcome, StreamRequest, NOTICE_SEARCHING};
pub use source_shadow::{
    source_shadow_metrics_snapshot, wrap_collector_with_source_shadow, SourceShadowMetrics,
};
pub use sources_rust::{
    sources_rust_csv_includes, sources_rust_csv_winner, sources_rust_includes,
    try_sources_rust_collector_from_env, try_sources_rust_collectors_from_env,
    try_sources_rust_native_from_env, try_sources_rust_native_from_env_with_bludv_store,
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
    /// Rotas internas do Node (`/internal/search/*`), para leitura de metadados,
    /// índice de releases e banco instantâneo.
    routes: Option<Arc<dyn InternalRoutes>>,
    /// Lista de arquivos por hash (o memo `fsz` do Node): o `💾` de pack/item
    /// que o tracker não publicou e o fill pós-debrid saem daqui. O Node lê o
    /// cache `fsz`; o núcleo não tem esse cache, então o caller injeta (na
    /// captura congelada vem de `inputs/files.json`).
    files_by_hash: Arc<BTreeMap<String, Vec<DebridFile>>>,
    /// Total do torrent (`tsz`) por hash — o `💾` de quem veio sem tamanho.
    /// Só o replay congelado injeta hoje (`inputs/totals.json`); em produção o
    /// Node preenche no build e o gateway ainda não o busca (gap de contrato).
    totals_by_hash: Arc<BTreeMap<String, f64>>,
    /// Estado do memo `fsz`/`tsz` na passada PRÉ-debrid (o Node anota duas
    /// vezes). `None` = captura sem o arquivo: a 1ª passada segue a régua
    /// anterior.
    files_at_build: Option<Arc<BTreeMap<String, Vec<DebridFile>>>>,
    totals_at_build: Option<Arc<BTreeMap<String, f64>>>,
    /// Fonte do inventário da conta (`ACCOUNT_RUST=on`/`shadow`). `None` =
    /// modo desligado ou fonte não injetada (o caminho Node segue igual).
    account: Option<Arc<dyn AccountInventorySource>>,
    /// Índice de releases nativo (`INDEX_RUST=on`/`shadow`); `None` = caminho
    /// Node (a leitura segue em `POST /internal/search/index`).
    index: Option<SharedIndex>,
    /// Banco de magnets nativo (`BANK_RUST=on`/`shadow`); `None` = Node.
    bank: Option<SharedBank>,
    /// Evidência `bad`/`lie` do banco de magnets da conta (`STREAM_BAD_RUST`);
    /// `None` = sem fonte (build igual ao de antes do F4.4a).
    known_broken: Option<Arc<dyn KnownBroken>>,
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
            routes: None,
            files_by_hash: Arc::new(BTreeMap::new()),
            totals_by_hash: Arc::new(BTreeMap::new()),
            files_at_build: None,
            totals_at_build: None,
            account: None,
            index: None,
            bank: None,
            known_broken: None,
        }
    }

    /// Injeta a lista de arquivos por hash (memo `fsz` do Node). Sem ela o
    /// build não inventa tamanho: item sem `💾` do tracker segue sem `💾`.
    pub fn with_files_by_hash(mut self, files: BTreeMap<String, Vec<DebridFile>>) -> Self {
        self.files_by_hash = Arc::new(files);
        self
    }

    /// Injeta o total do torrent por hash (memo `tsz` do Node). Sem ele o item
    /// que o tracker publicou sem tamanho fica sem `💾` quando não há lista de
    /// arquivos (o Node preenche com o total).
    pub fn with_totals_by_hash(mut self, totals: BTreeMap<String, f64>) -> Self {
        self.totals_by_hash = Arc::new(totals);
        self
    }

    /// Injeta o estado do memo na passada PRÉ-debrid (o Node anota duas vezes e
    /// o `📦 pack` depende do que a 1ª passada preencheu). Só o replay congela
    /// isto (`inputs/files-build.json`); produção segue com `None`.
    pub fn with_build_pass(
        mut self,
        files: Option<BTreeMap<String, Vec<DebridFile>>>,
        totals: Option<BTreeMap<String, f64>>,
    ) -> Self {
        self.files_at_build = files.map(Arc::new);
        self.totals_at_build = totals.map(Arc::new);
        self
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

    /// Liga coleta/metadados/efeitos no cliente HTTP das rotas internas.
    pub fn with_routes(mut self, routes: Arc<dyn InternalRoutes>) -> Self {
        self.collector = Arc::new(NodeCollector::new(routes.clone()).with_skip_account(true));
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

    /// Injeta a fonte do inventário da conta (teste ou integração própria).
    pub fn with_account_source(mut self, source: Arc<dyn AccountInventorySource>) -> Self {
        self.account = Some(source);
        self
    }

    /// Monta a fonte NATIVA do inventário quando `ACCOUNT_RUST` pede
    /// (`on`/`shadow`). `off` mantém `None` — o caminho Node fica intacto.
    pub fn with_native_account(mut self) -> Self {
        self.account = try_native_account_source(&self.config);
        self
    }

    /// Fonte atual do inventário (`None` = modo desligado/sem injeção).
    pub fn account_source(&self) -> Option<&Arc<dyn AccountInventorySource>> {
        self.account.as_ref()
    }

    /// Injeta o índice de releases nativo (`INDEX_RUST`).
    pub fn with_index_source(mut self, index: SharedIndex) -> Self {
        self.index = Some(index);
        self
    }

    /// Injeta o banco de magnets nativo (`BANK_RUST`).
    pub fn with_bank_source(mut self, bank: SharedBank) -> Self {
        self.bank = Some(bank);
        self
    }

    /// `true` quando o índice nativo foi injetado (diagnóstico/sombra).
    pub fn index_source(&self) -> Option<&SharedIndex> {
        self.index.as_ref()
    }

    /// `true` quando o banco nativo foi injetado.
    pub fn bank_source(&self) -> Option<&SharedBank> {
        self.bank.as_ref()
    }

    /// Injeta a evidência `bad`/`lie` da conta (o `cache.db` do Node lido pelo
    /// gateway). `None` mantém o build sem poda — o caminho Node continua
    /// marcando `broken` nos itens que ELE coleta.
    pub fn with_known_broken(mut self, source: Arc<dyn KnownBroken>) -> Self {
        self.known_broken = Some(source);
        self
    }

    /// `true` quando a poda `bad`/`lie` nativa está ativa (diagnóstico).
    pub fn known_broken_source(&self) -> Option<&Arc<dyn KnownBroken>> {
        self.known_broken.as_ref()
    }

    pub fn config(&self) -> &OrchestratorConfig {
        &self.config
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
        // ANTES do SWR, como o `findStreams` do Node (`search-cache.ts:66-72`).
        self.emit_season_key(&req, &options, &key);
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
                if revalidate {
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

    /// `registerSeasonSearchKey` (`search-cache.ts:66-72`): série com debrid
    /// registra a chave da lista por temporada ANTES de olhar o cache — o hit
    /// do SWR também registra. Fire-and-forget: a resposta nunca espera.
    fn emit_season_key(&self, req: &StreamRequest, options: &Value, key: &str) {
        if !self.config.effects_enabled || req.kind != "series" {
            return;
        }
        let parsed = adom_core::parse_stremio_id(&req.id);
        let imdb = parsed.get("imdbId").and_then(Value::as_str).unwrap_or("");
        let season = parsed.get("season").and_then(Value::as_i64).unwrap_or(0);
        let effect = effects::season_key(
            &finish::str_of(options, "debridService"),
            &finish::str_of(options, "debridApiKey"),
            imdb,
            season,
            key,
        );
        let Some(effect) = effect else {
            return;
        };
        let tail = self.tail.clone();
        let encoded = encoded_for_internal(req.encoded.as_deref());
        tokio::spawn(async move {
            if let Err(err) = tail
                .effects(tail::EffectsBatch {
                    encoded,
                    effects: vec![effect],
                })
                .await
            {
                eprintln!("[search] effects (season_key) falhou: {err}");
            }
        });
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
