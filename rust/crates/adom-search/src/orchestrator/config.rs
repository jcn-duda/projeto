//! Configuração e dependências do orquestrador do `/stream`.
//!
//! Dois blocos, de propósito separados: [`OrchestratorConfig`] carrega NÚMEROS
//! e defaults do operador (o `.env` do Node, injetado pelo caller — nunca lido
//! aqui), e as TRAITS de borda ([`DebridFactory`], `Collector`, `MetaSource`,
//! `TailEffects`) são as linhas de I/O que ainda moram no Node.
//!
//! Invariante que atravessa o arquivo: a preferência do usuário chega no
//! `encoded`/`options` da requisição; nada daqui vem de `config.*` no caminho
//! de busca. [`OrchestratorConfig::default`] só existe para testes — produção
//! passa os valores do operador.

use adom_core::StreamDisplayConfig;
use serde_json::Value;
use std::sync::Arc;

use crate::collection_window::CollectBudgets;
use crate::debrid_seam::{AdapterDebridCheck, HoldsFeed};
use crate::list_builder::{BuildOptions, DebridAnswer, DebridCheck};
use adom_core::RankingStream;

pub use super::config_options::build_options_from;
/// Defaults do operador (`src/config/*.ts`) que governam a resposta.
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// Orçamentos da coleta (prazo, reserva de debrid, graça BR, total BR).
    pub budgets: CollectBudgets,
    /// `REPLY_DEADLINE_MS` (Stremio aborta em 10 s).
    pub stremio_reply_ms: u64,
    /// `APP_REPLY_DEADLINE_MS` (app Power Movie, UA `Dart/`).
    pub app_reply_ms: u64,
    /// `CACHE_TTL` — `cacheMaxAge` da resposta completa e TTL da entrada.
    pub cache_ttl: i64,
    /// `FALLBACK_STREAMS_TTL` — TTL da entrada com reserva.
    pub fallback_streams_ttl: i64,
    /// `STREAM_STALE_GRACE_SECONDS` — graça do SWR.
    pub stale_grace_seconds: u64,
    /// `defaults()` do operador: base do decode da config e da chave de cache.
    /// A ORDEM das chaves importa (`JSON.stringify`), por isso é um `Value` e
    /// não um struct.
    pub defaults: Value,
    /// `RESOLVE_SECRET` — precedência sobre a chave de debrid no HMAC.
    pub resolve_secret: String,
    /// `DEBRID_RESOLVE_UNCACHED` — entra na chave (muda a `url` de cada stream).
    pub resolve_uncached: bool,
    /// Números do build que vêm do OPERADOR (o resto vem das opções do usuário).
    pub build: BuildOptions,
    /// `STREAM_NAME_STYLE`/`STREAM_NAME_SHOW_SOURCE`.
    pub display: StreamDisplayConfig,
    /// Indexers selecionados (`opts().jackettIndexers` ?? config do operador).
    pub selected_indexers: Vec<String>,
    /// Indexers que indexam por título pt-BR (`JACKETT_PT_BR_INDEXERS`).
    pub pt_br_indexers: Vec<String>,
    /// Indexers lentos isolados em tarefa própria (`JACKETT_SLOW_INDEXERS`).
    pub isolate_indexers: Vec<String>,
    /// Index-only: fora do caminho da resposta (`JACKETT_INDEX_ONLY_INDEXERS`).
    pub index_only_indexers: Vec<String>,
    /// `JACKETT_PT_SWEEP_GLOBAL`: varredura pt-BR nos globais ligada.
    pub sweep_enabled: bool,
    /// `SEARCH_STREAM_TRACE`: captura/serialização do ledger.
    pub trace_enabled: bool,
    /// `SEARCH_INDEX_RESCUE_MIN_MS`: resgate de coleta ao vivo se resposta do índice/acervo não tiver tocável.
    pub search_index_rescue_min_ms: i64,
    /// `SEARCH_TAIL_COLLECT_MS`: prazo da coleta ao vivo que roda no tail da
    /// via rápida. O tail do TS não tem prazo (só o timeout de cada indexer);
    /// a rota interna exige um, e o da RESPOSTA cortava os globais lentos — a
    /// foto deles nunca perdia o 📦 na promoção.
    pub tail_collect_ms: i64,
    /// `SEARCH_PACK_TAIL`: série busca o pack da temporada no tail e mescla
    /// os hashes novos (o `packTail` do TS).
    pub pack_tail: bool,
    /// `EFFECTS_RUST`: o orquestrador nativo EMITE os efeitos de cauda
    /// (dub_audit/warmer/colhedor/chave de temporada) por
    /// `POST /internal/search/effects`. Default ON no `from_env`; o Node só
    /// EXECUTA as filas e `EFFECTS_RUST=off` é o rollback.
    pub effects_enabled: bool,
    /// `MICO_DEFAULT`: o card virtual `mico` entra no `ji` default do operador.
    /// Só vale quando a request não traz `jackettIndexers` (a seleção da URL
    /// vence); alimenta o `wants("mico")` do `CollectJob`.
    pub mico_default: bool,
    /// `DEBRID_INVENTORY_SOURCE` (default ligado, como no Node): sem ele a
    /// conta não é fonte.
    pub account_inventory_source: bool,
    /// `ACCOUNT_FAST_PATH` (default ligado): lote da conta suficiente responde
    /// na hora.
    pub account_fast_path: bool,
    /// `ACCOUNT_FAST_MIN_RELEASES` (default 2).
    pub account_fast_min_releases: usize,
    /// Piso de seeders do `poolCovered` do fast-path. O Node usa
    /// `autoFetchLive.effective().autoFetchMinSeeders` (default 3), não o
    /// `MIN_SEEDERS` do build.
    pub account_fast_min_seeders: f64,
    /// `DEBRID_INVENTORY_TIMEOUT_MS` (default 1500).
    pub account_inventory_timeout_ms: i64,
    /// `DEBRID_INVENTORY_MAX` (default 3000).
    pub account_inventory_max: usize,
    /// `DEBRID_INVENTORY_TTL` em segundos (default 300).
    pub account_inventory_ttl_s: i64,
    /// `ACCOUNT_FAST_WAIT_MS` (default 450): teto da conta na via do índice.
    pub account_fast_wait_ms: i64,
    /// `RELEASE_INDEX`/`RELEASE_INDEX_TTL`/`RELEASE_INDEX_MAX_RELEASES`.
    pub release_index_enabled: bool,
    pub release_index_ttl: u64,
    pub release_index_max_releases: usize,
    /// `MAGNET_BANK` (liga o acervo) e o kill-switch da via instantânea.
    pub magnet_bank_enabled: bool,
    pub magnet_bank_instant_enabled: bool,
    pub magnet_bank_fallback_enabled: bool,
    /// `MAGNET_BANK_FALLBACK_MAX`/`_GLOBAL_MAX` (clamp 1..40 / 1..500).
    pub magnet_bank_fallback_max_per_indexer: i64,
    pub magnet_bank_fallback_global_max: i64,
    /// Janela adaptativa da instantânea (`MAGNET_BANK_INSTANT_*`).
    pub magnet_bank_instant_min_ms: i64,
    pub magnet_bank_instant_max_ms: i64,
    pub magnet_bank_instant_fresh_max_ms: i64,
    /// `DEBRID_AUTO_FETCH_MIN_SEEDERS` (default 3): piso do `poolCovered` do
    /// índice/instantânea, o mesmo que o Node lê do autofetch.
    pub auto_fetch_min_seeders: f64,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        OrchestratorConfig {
            budgets: CollectBudgets::default(),
            stremio_reply_ms: 9200,
            app_reply_ms: 15_000,
            cache_ttl: 900,
            fallback_streams_ttl: 120,
            stale_grace_seconds: 300,
            defaults: BuildOptions::default().to_schema_defaults(),
            resolve_secret: String::new(),
            resolve_uncached: false,
            build: BuildOptions::default(),
            display: StreamDisplayConfig::default(),
            selected_indexers: Vec::new(),
            pt_br_indexers: Vec::new(),
            isolate_indexers: Vec::new(),
            index_only_indexers: Vec::new(),
            sweep_enabled: true,
            trace_enabled: true,
            search_index_rescue_min_ms: 2500,
            tail_collect_ms: 25_000,
            pack_tail: true,
            // Default = testes (sem emissão); produção (`from_env`) nasce ON.
            effects_enabled: false,
            mico_default: false,
            account_inventory_source: true,
            account_fast_path: true,
            account_fast_min_releases: 2,
            account_fast_min_seeders: 3.0,
            account_inventory_timeout_ms: 1_500,
            account_inventory_max: 3_000,
            account_inventory_ttl_s: 300,
            account_fast_wait_ms: 450,
            release_index_enabled: true,
            release_index_ttl: 30 * 24 * 3600,
            release_index_max_releases: 60,
            magnet_bank_enabled: true,
            magnet_bank_instant_enabled: true,
            magnet_bank_fallback_enabled: true,
            magnet_bank_fallback_max_per_indexer: 40,
            magnet_bank_fallback_global_max: 40,
            magnet_bank_instant_min_ms: 7 * 86_400_000,
            magnet_bank_instant_max_ms: 7 * 86_400_000,
            magnet_bank_instant_fresh_max_ms: 2 * 3_600_000,
            auto_fetch_min_seeders: 3.0,
        }
    }
}

/// Fatos da requisição que a checagem de debrid precisa (nunca credencial em
/// log: `api_key` fica só no adaptador).
#[derive(Debug, Clone, Default)]
pub struct DebridContext {
    pub service: String,
    pub api_key: String,
    /// Segmento de config do usuário — corpo da reserva Node.
    pub encoded: Option<String>,
    /// Prazo absoluto da busca; `None` no passe tardio (orçamento completo).
    pub deadline_at: Option<i64>,
}

impl DebridContext {
    /// Há debrid utilizável? Serviço **e** chave (sem um dos dois o Node não
    /// tem adaptador — `debrid.current()` é nulo).
    pub fn is_active(&self) -> bool {
        !self.service.is_empty() && !self.api_key.is_empty()
    }
}

/// Constrói o `DebridCheck` de UMA busca (o memo do lote é por busca, nunca
/// global). A implementação de produção é `AdapterDebridFactory`; testes
/// injetam stub.
pub trait DebridFactory: Send + Sync {
    fn make(&self, ctx: &DebridContext) -> Box<dyn DebridCheck + Send>;
}

/// `DebridCheck` sem debrid: tudo `Unknown` (ninguém perguntou). O orquestrador
/// trata a entrada como `debridKnown: true` quando o debrid não está ativo —
/// é o mesmo que o TS faz ao nem chamar o `applyDebrid` (`known` fica
/// `undefined` → `!needsDebridRefresh`).
pub struct NoDebridCheck;

impl DebridCheck for NoDebridCheck {
    fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
        DebridAnswer::Unknown
    }
}

/// Fábrica que nunca pergunta ao debrid (testes sem rede).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoDebridFactory;

impl DebridFactory for NoDebridFactory {
    fn make(&self, _ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        Box::new(NoDebridCheck)
    }
}

/// Fábrica de produção: os adaptadores do `adom-debrid` + o feed de holds.
///
/// Default = sem store/feed: a fábrica funciona e responde `Unknown`
/// quando o serviço não tem despacho local — degradação honesta. A produção
/// liga os dois com [`AdapterDebridFactory::new`].
#[derive(Default)]
pub struct AdapterDebridFactory {
    /// Ledger do RD (`rdc:v2`); `None` deixa todo hash `Unknown`.
    pub store: Option<Arc<adom_debrid::Store>>,
    /// Feed dos holds do autofetch (`DEBRID_AL_HOLDS`, default OFF no código e
    /// ON no compose): leva `holdsComplete`/`knownBefore` à limpeza nativa da
    /// AllDebrid. Sem feed a nativa é read-only.
    pub holds: Option<Arc<dyn HoldsFeed>>,
}

impl AdapterDebridFactory {
    pub fn new(store: Option<Arc<adom_debrid::Store>>) -> Self {
        AdapterDebridFactory { store, holds: None }
    }

    /// Liga o feed de holds (produção: `adom-server::al_cleanup_facts::NativeHoldsFeed`).
    pub fn with_holds(mut self, holds: Option<Arc<dyn HoldsFeed>>) -> Self {
        self.holds = holds;
        self
    }
}

impl DebridFactory for AdapterDebridFactory {
    fn make(&self, ctx: &DebridContext) -> Box<dyn DebridCheck + Send> {
        if !ctx.is_active() {
            return Box::new(NoDebridCheck);
        }
        let mut check = AdapterDebridCheck::new(ctx.service.clone(), ctx.api_key.clone());
        check.store = self.store.clone();
        check.holds = self.holds.clone();
        Box::new(check)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn opcoes_do_usuario_sobrepoem_o_default() {
        let fallback = BuildOptions::default();
        let opts = json!({
            "maxResults": 12,
            "qualities": ["1080p"],
            "preferDubbed": true,
            "max1080p": 5,
            "maxSd": 3,
            "brReservedPerQuality": 2,
            "candidatePoolFactor": 3,
            "indexerLimits": { "bludv": 3 },
            "indexerPriority": ["bludv"],
        });
        let out = build_options_from(&opts, &fallback);
        assert_eq!(out.max_results, 12.0);
        assert_eq!(out.qualities, vec!["1080p".to_string()]);
        assert!(out.prefer_dubbed);
        assert_eq!(out.quality_limits.get("1080p"), Some(&5.0));
        assert_eq!(
            out.quality_limits.get("SD"),
            Some(&3.0),
            "maxSd (SCHEMA), não maxSD"
        );
        assert_eq!(out.br_reserved_per_quality, 2.0);
        assert_eq!(out.candidate_pool_factor, 3.0);
        assert_eq!(out.indexer_limits.get("bludv"), Some(&3.0));
        assert_eq!(out.indexer_priority, vec!["bludv".to_string()]);
        // Campo ausente mantém o default do operador.
        assert_eq!(out.br_first, fallback.br_first);
        assert_eq!(out.br_reserved_slots, 6.0);
    }

    #[test]
    fn defaults_do_operador_carregam_cotas_node_like() {
        let b = BuildOptions::default();
        assert_eq!(b.quality_limits.get("1080p"), Some(&2.0));
        assert_eq!(b.br_reserved_slots, 6.0);
        assert_eq!(b.br_reserved_per_quality, 1.0);
        assert_eq!(b.candidate_pool_factor, 4.0);
        assert_eq!(b.qualities, vec!["2160p", "1080p", "720p"]);
        let schema = b.to_schema_defaults();
        assert_eq!(schema["max1080p"], json!(2.0));
        assert_eq!(schema["brReservedSlots"], json!(6.0));
        assert_eq!(schema["brReservedPerQuality"], json!(1.0));
        assert_eq!(schema["maxSd"], json!(2.0));
        let cfg = OrchestratorConfig::default();
        assert_eq!(cfg.defaults["max1080p"], json!(2.0));
        assert_eq!(cfg.defaults["brReservedSlots"], json!(6.0));
        assert_eq!(cfg.defaults["brReservedPerQuality"], json!(1.0));
        // `dubbedOnly` nasce de `BLUDV_DUBBED_ONLY` (default TRUE) e é o MESMO
        // valor que o coletor BLUDV recebe para filtrar LEGENDADO no scrape.
        assert_eq!(cfg.defaults["dubbedOnly"], json!(true));
        let selection =
            crate::orchestrator::collect::RequestSelection::from_options(&cfg.defaults, false);
        assert!(
            selection.dubbed_only,
            "default do operador chega ao BludvSearchOpts"
        );
        // O `d=false` da URL vence o default (o Node faz o mesmo overlay).
        let off = crate::orchestrator::collect::RequestSelection::from_options(
            &json!({"dubbedOnly": false}),
            false,
        );
        assert!(!off.dubbed_only);
    }

    #[test]
    fn fabrica_sem_chave_nao_liga_debrid() {
        let factory = AdapterDebridFactory::default();
        let ctx = DebridContext {
            service: "alldebrid".into(),
            api_key: String::new(),
            ..DebridContext::default()
        };
        assert!(!ctx.is_active());
        // Sem debrid ativo o check é no-op (Unknown): a entrada conta como
        // `debridKnown` no orquestrador.
        let mut check = factory.make(&ctx);
        assert_eq!(
            check.check(&RankingStream::default()),
            DebridAnswer::Unknown
        );
    }
}
