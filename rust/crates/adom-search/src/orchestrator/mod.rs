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
//! 7. **fila tardia** — `tokio::spawn` com o lote completo, escrita no
//!    índice NATIVO, refresh do debrid e varredura pt-BR (efeitos por
//!    [`TailEffects`]).
//!
//! Corte EXTERNO: a busca corre numa task própria; o cliente espera
//! `reply_ms` e, se o prazo vencer, recebe `partial` com o aviso
//! "Procurando fontes — reabra em instantes" e `cacheMaxAge: 0`. A task NÃO é
//! cancelada: quando a coleta estabiliza, o passe tardio regrava o cache
//! (mesmo cache ≤ 60 s e host fora dele). Nunca 500: falha de collector vira
//! lista vazia + aviso, como o handler do Node (`stream.ts`).

mod account; // Inventário nativo da conta (F3): fonte, filtro, memo e fast-path.
mod account_metrics;
mod bludv_collect;
mod bludv_collector;
mod collect;
mod composite_collector;
mod config;
mod config_options;
// Métricas da checagem AllDebrid nativa: `debrid.al.*`.
pub(crate) mod debrid_al_metrics;
// Payloads dos efeitos de cauda (`EFFECTS_RUST`); a seleção mora no build.
mod effects;
mod fallback;
mod fast_path;
mod file_evidence; // Prova de arquivo `idx:v14:file:<hash>` (o `applyFileEvidence` do Node).
mod file_sizes; // Fonte nativa `fsz`/`tsz` por hash: o `💾` de pack sai da lista de arquivos.
mod finish;
mod finish_build;
// Reuso da coleta/gravação de índice FORA do `/stream` (colhedor de fundo do
// `adom-server`): Jackett → `RawItem`, entrada do índice e `record` + marca do
// filtro — sem orquestrador e sem rota HTTP interna.
pub mod harvest_support;
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
mod meta_build;
mod meta_helpers;
mod meta_load;
mod meta_metrics; // `meta.*`: metadados nativos × fallback Node (Fase 2).
mod meta_native;
mod mico_collector;
mod native_index;
mod native_index_instant;
mod native_index_wire;
mod pack;
mod proven_quality; // `provenQuality`: resolução pelo nome do arquivo do torrent.
mod prowlarr_collector;
mod refresh;
mod respond;
mod route;
mod search;
mod search_collect;
mod sources_rust;
// Contadores `stream.cache.*` do cache de streams no caminho do usuário.
// Módulo PÚBLICO: a rota `/streams/stats` do gateway lê as chaves e o
// hit-rate, não só o snapshot reexportado abaixo.
pub mod stream_cache_metrics;
mod tail;
#[cfg(test)]
#[path = "tests.rs"]
mod tests;
// T1-C2: commit/promoção só gravam com a geração da obra capturada na leitura.
#[cfg(test)]
#[path = "fence_tests.rs"]
mod fence_tests;
// Gate de paridade congelada do `/stream` (`docs/stream-frozen-gate.md`): o
// alvo de integração `tests/stream_frozen_parity.rs` chama `run_all()` daqui,
// então o módulo NÃO é `cfg(test)` — `doc(hidden)` só evita que ele apareça
// como API do crate. O comando do gate é sem `--features`.
#[doc(hidden)]
pub mod frozen_gate;
mod torrentio_collector;
mod trace;

use adom_core::DebridFile;
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};

use crate::cache::SwrStore;
use crate::coalesce::InFlight;
#[cfg(test)]
pub(crate) use crate::request::request_cache_key;
pub use account::{
    account_raw_items, br_origin_only, fast_path_decision, signals_of, try_native_account_source,
    AccountInventorySource, AccountRequest, AccountSignals, FastPathDecision, NativeAccountConfig,
    NativeAccountSource, FAST_PATH_ENV as ACCOUNT_FAST_PATH_ENV,
    FAST_PATH_MIN_ENV as ACCOUNT_FAST_MIN_ENV,
};
pub use account_metrics::account_metrics_snapshot;
pub use bludv_collector::{
    try_bludv_collector_from_env, try_bludv_collector_from_env_with_store, BludvCollector,
};
pub use collect::{plan_jobs, CollectBatch, CollectJob, Collector, RequestSelection};
pub use composite_collector::CompositeCollector;
pub use config::{
    build_options_from, AdapterDebridFactory, DebridContext, DebridFactory, NoDebridCheck,
    NoDebridFactory, OrchestratorConfig,
};
pub use stream_cache_metrics::stream_cache_metrics_snapshot;
// Tipos que o consumidor de `harvest_support` recebe/entrega, no MESMO caminho
// dos módulos do orquestrador.
pub use crate::internal_types::ReleaseEntry;
pub use crate::raw_item::RawItem;
pub use debrid_al_metrics::debrid_al_metrics_snapshot;
pub use file_evidence::{FileEvidenceSource, ProvenFile};
pub use file_sizes::FileSizesSource;
pub use index_effects::{FollowUpKind, FollowUpPlan};
pub use index_metrics::index_metrics_snapshot;
pub use index_source::{
    allowed_source_indexer, bank_limits, bank_read_window, obra_targets, BankFilterCtx, BankLookup,
    IndexedReleaseWire, MagnetBankSource, ReleaseIndexSource, SharedBank, SharedIndex,
};
pub use internal_routes::{InternalRoutes, NodeRoutes, RouteFuture};
pub use jackett_collector::{
    plan_jackett_searches, try_jackett_collector_from_env, JackettCollector, PlannedJackettSearch,
};
// PONTE DE PARIDADE (`doc(hidden)`): o teste de `harvest/drain_shape.rs` do
// `adom-server` compara a régua das envs daqui com a cópia de lá — a mesma
// regra em dois crates e nenhum lado comparava com o outro.
#[doc(hidden)]
pub use jackett_collector::env::env_parity_probe;
pub use known_broken::KnownBroken;
pub use live_state::{
    live_state_snapshot, merge_states, shared_live_state, LiveAllState, LiveBatchState,
    SharedLiveState,
};
pub use meta::{meta_from_response, MetaQuery, MetaSource, NodeMetaSource, SearchMeta};
pub use meta_metrics::{meta_metrics_snapshot, MetaMetrics};
pub use meta_native::{
    meta_from_lookup, FallbackMetaSource, NativeMetaSource, DEFAULT_LOOKUP_TIMEOUT_MS,
};
pub use mico_collector::{try_mico_collector_from_env, MicoCollector};
pub use prowlarr_collector::{try_prowlarr_collector_from_env, ProwlarrCollector};
pub use respond::{SearchOutcome, StreamRequest, NOTICE_SEARCHING};
pub use sources_rust::try_native_collectors_with_bludv_store;
pub use tail::{
    EffectsBatch, IndexBatch, NodeTailEffects, NoopTailEffects, TailEffects, TailJob, TailPlan,
};
pub use torrentio_collector::{try_torrentio_collector_from_env, TorrentioCollector};
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
    /// Rotas internas do Node (`/internal/search/*`), para metadados e
    /// efeitos. Coleta, índice e banco são NATIVOS: não há rota Node.
    routes: Option<Arc<dyn InternalRoutes>>,
    /// Lista de arquivos por hash injetada ESTATICAMENTE: só o replay
    /// congelado (`inputs/files.json`) usa. Produção lê por hash na fonte
    /// `file_sizes`, a cada build, e só preenche o que aqui não existe.
    files_by_hash: Arc<BTreeMap<String, Vec<DebridFile>>>,
    /// Total do torrent (`tsz`) por hash injetado estaticamente (replay).
    /// Produção: `file_sizes`, como `files_by_hash`.
    totals_by_hash: Arc<BTreeMap<String, f64>>,
    /// Fonte nativa de `fsz`/`tsz` por hash (KV do gateway). `None` = sem
    /// fonte: o build segue só com o que foi injetado acima.
    file_sizes: Option<Arc<dyn FileSizesSource>>,
    /// Prova de arquivo por hash (índice nativo). `None` = itens sem prova.
    file_evidence: Option<Arc<dyn FileEvidenceSource>>,
    /// Estado do memo `fsz`/`tsz` na passada PRÉ-debrid (o Node anota duas
    /// vezes). `None` = captura sem o arquivo: a 1ª passada segue a régua
    /// anterior.
    files_at_build: Option<Arc<BTreeMap<String, Vec<DebridFile>>>>,
    totals_at_build: Option<Arc<BTreeMap<String, f64>>>,
    /// Fonte do inventário da conta. `None` = fonte não injetada (a conta
    /// fica fora da busca; nunca há tarefa Node).
    account: Option<Arc<dyn AccountInventorySource>>,
    /// Índice de releases nativo (`idx:v14`); `None` = sem store (a busca
    /// degrada sem via rápida, log `[search]`). SEMPRE nativo desde o R4.
    index: Option<SharedIndex>,
    /// Banco de magnets nativo (`magnets.db`); `None` = sem store (degradação
    /// sem instantânea/reserva). SEMPRE nativo desde o R4.
    bank: Option<SharedBank>,
    /// Evidência `bad`/`lie` do banco de magnets da conta (fonte do gateway);
    /// `None` = sem fonte (build igual ao de antes do F4.4a).
    known_broken: Option<Arc<dyn KnownBroken>>,
    /// Lote da via rápida já decidido FORA do processo — só o replay congelado
    /// (`frozen_gate`) usa. Substituiu a rota Node `search/index`: sem ela, o
    /// gate injeta o lote capturado VERBATIM (com as anotações do build) em vez
    /// de re-derivá-lo das fontes nativas. `None` em produção.
    frozen_fast_path: Option<fast_path::FastPath>,
}

/// Collector que falha sempre: default do crate até a integração (`adom-server`)
/// injetar os coletores nativos. A busca responde lista vazia + aviso — nunca 500.
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
            file_sizes: None,
            file_evidence: None,
            files_at_build: None,
            totals_at_build: None,
            account: None,
            index: None,
            bank: None,
            known_broken: None,
            frozen_fast_path: None,
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

    /// Injeta a fonte nativa de `fsz`/`tsz` por hash. Lida a cada build, só
    /// para hashes que o mapa estático não cobre (ver `file_sizes.rs`).
    pub fn with_file_sizes(mut self, source: Arc<dyn FileSizesSource>) -> Self {
        self.file_sizes = Some(source);
        self
    }

    /// Injeta a prova de arquivo por hash, aplicada aos itens a cada build.
    pub fn with_file_evidence(mut self, source: Arc<dyn FileEvidenceSource>) -> Self {
        self.file_evidence = Some(source);
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

    /// Injeta explicitamente as rotas internas (metadados/efeitos/tail).
    pub fn with_internal_routes(mut self, routes: Arc<dyn InternalRoutes>) -> Self {
        self.routes = Some(routes);
        self
    }

    /// Injeta a fonte do inventário da conta (teste ou integração própria).
    pub fn with_account_source(mut self, source: Arc<dyn AccountInventorySource>) -> Self {
        self.account = Some(source);
        self
    }

    /// Monta a fonte NATIVA do inventário. É a única fonte da conta; sem ela
    /// (não chamado) a conta fica fora da busca.
    pub fn with_native_account(mut self) -> Self {
        self.account = try_native_account_source(&self.config);
        self
    }

    /// Fonte atual do inventário (`None` = sem injeção).
    pub fn account_source(&self) -> Option<&Arc<dyn AccountInventorySource>> {
        self.account.as_ref()
    }

    /// Injeta o índice de releases nativo.
    pub fn with_index_source(mut self, index: SharedIndex) -> Self {
        self.index = Some(index);
        self
    }

    /// Injeta o banco de magnets nativo.
    pub fn with_bank_source(mut self, bank: SharedBank) -> Self {
        self.bank = Some(bank);
        self
    }

    /// O índice nativo injetado, quando houver.
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
}
