//! `HarvestDrainAsync` real: metadados nativos → Jackett → régua → índice.
//!
//! Nada aqui inventa régua nova:
//!
//! - queries saem de [`meta_from_lookup`], a MESMA montagem do `/stream`
//!   (`query` + `pt_query` + `original_query`); a forma por indexer passa por
//!   [`shape_search_query`], como no cliente;
//! - relevância é [`filter_relevant_raw`] com os campos do plano de build do
//!   orquestrador (`pre_home_release_cut`, margem e cauda de precisão);
//! - gravação é `harvest_support::{release_entry_for, record_release}`.
//!
//! **Sem índice nativo** o drain não gasta cota: devolve `ok` com 0 consultas
//! e loga uma vez (`[harvest] sem índice nativo; colheita descartada`). Sem
//! Jackett configurado a obra falha (`failed`), como no Node quando a fonte
//! não responde.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use adom_core::{filter_relevant_raw, RelevanceQuery, RelevanceSettings};
use adom_harvest::{
    BrProbe, DrainOutcome, HarvestDrainAsync, HarvestEntry, HarvestMediaType, ProbeConfig,
};
use adom_search::orchestrator::harvest_support::{
    raw_items_from_jackett, record_release, release_entry_for,
};
use adom_search::orchestrator::{meta_from_lookup, Orchestrator, RawItem, SharedBank, SharedIndex};
use adom_sources::{
    now_ms, shape_search_query, JackettClient, JackettConfig, JackettMediaType, JackettRawItem,
    LookupOptions, MediaType, MemoryMetaStore, MetaSources, MetaStore, SearchOptions,
    SourcesConfig,
};
use adom_store::MetaCacheStore;

use super::config::HarvestConfig;
use super::drain_shape::{entry_meta_query, live_exempt_indexers, relevance_items};

/// Prazo do lookup de metadados. O colhedor não tem prazo de usuário, mas não
/// pode pendurar o ciclo para sempre.
const LOOKUP_TIMEOUT_MS: i64 = 4_000;

/// Fatia do orquestrador que o drain precisa (nada de estado vivo do `/stream`).
struct DrainSettings {
    indexers: Vec<String>,
    index_only: Vec<String>,
    delay_ms: u64,
    index_only_timeout_ms: u64,
    pre_home_release_cut: bool,
    pre_home_release_margin_ms: i64,
    title_precision_tail_cut: bool,
}

/// Drain de produção, montado uma vez na thread do colhedor.
pub(crate) struct NetworkDrain {
    meta: Option<MetaSources>,
    jackett: Option<JackettClient>,
    jackett_config: JackettConfig,
    index: Option<SharedIndex>,
    bank: Option<SharedBank>,
    settings: DrainSettings,
    /// Interseção dirigida (index-only ∩ pt-BR − isentos): a régua é a do
    /// crate, montada uma vez com as listas do processo.
    probe: BrProbe,
    /// Evidência BR viável da última obra — o desfecho da sonda lê e zera.
    last_found: bool,
    warned_no_index: bool,
    warned_no_meta: bool,
    warned_no_jackett: bool,
}

impl NetworkDrain {
    pub(crate) fn new(orch: &Orchestrator, harvest: &HarvestConfig) -> Self {
        let store: Arc<dyn MetaStore> = match MetaCacheStore::from_env() {
            Ok(store) => Arc::new(store),
            Err(err) => {
                eprintln!("[harvest] cache.db de metadados indisponível ({err}); memória");
                Arc::new(MemoryMetaStore::new())
            }
        };
        let meta = match MetaSources::new(SourcesConfig::from_env(), store) {
            Ok(meta) => Some(meta),
            Err(err) => {
                eprintln!("[harvest] metadados nativos não montaram: {err}");
                None
            }
        };
        let jackett_config = JackettConfig::from_env();
        let jackett = match JackettClient::from_env() {
            Ok(client) => Some(client),
            Err(err) => {
                eprintln!("[harvest] Jackett indisponível: {err}");
                None
            }
        };
        let build = &orch.config().build;
        let probe = BrProbe::new(ProbeConfig {
            index_only_indexers: orch.config().index_only_indexers.clone(),
            pt_br_indexers: jackett_config.pt_br_indexers.clone(),
            live_exempt_indexers: live_exempt_indexers(),
            ..ProbeConfig::default()
        });
        Self {
            meta,
            jackett,
            jackett_config,
            probe,
            index: orch.index_source().cloned(),
            bank: orch.bank_source().cloned(),
            settings: DrainSettings {
                indexers: orch.config().selected_indexers.clone(),
                index_only: orch.config().index_only_indexers.clone(),
                delay_ms: harvest.indexer_delay_ms,
                index_only_timeout_ms: harvest.index_only_harvest_timeout_ms,
                pre_home_release_cut: build.pre_home_release_cut,
                pre_home_release_margin_ms: build.pre_home_release_margin_ms,
                title_precision_tail_cut: build.title_precision_tail_cut,
            },
            last_found: false,
            warned_no_index: false,
            warned_no_meta: false,
            warned_no_jackett: false,
        }
    }

    /// Evidência BR viável da última obra (consumida pelo desfecho da sonda).
    pub(crate) fn take_found(&mut self) -> bool {
        std::mem::take(&mut self.last_found)
    }

    /// Subset dirigido da sonda: a MESMA interseção de `BrProbe::probe_indexers`
    /// (index-only ∩ pt-BR − isentos da busca viva).
    fn probe_targets(&self) -> Vec<String> {
        self.probe
            .probe_indexers()
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    /// Uma obra: metadados, consultas espaçadas, régua e gravação.
    async fn run(&mut self, entry: &HarvestEntry) -> DrainOutcome {
        let Some(index) = self.index.clone() else {
            if !self.warned_no_index {
                self.warned_no_index = true;
                eprintln!("[harvest] sem índice nativo; colheita descartada");
            }
            return DrainOutcome::ok_with_queries(0);
        };
        let Some(meta) = self.meta.as_ref() else {
            if !self.warned_no_meta {
                self.warned_no_meta = true;
                eprintln!("[harvest] sem metadados nativos; colheita falhou");
            }
            return DrainOutcome::failed();
        };
        let Some(jackett) = self.jackett.as_ref() else {
            if !self.warned_no_jackett {
                self.warned_no_jackett = true;
                eprintln!("[harvest] sem Jackett configurado; colheita falhou");
            }
            return DrainOutcome::failed();
        };

        let now = now_ms();
        let deadline = now.saturating_add(LOOKUP_TIMEOUT_MS);
        let Some(media_type) = MediaType::parse(entry.media_type.as_str()) else {
            return DrainOutcome::failed();
        };
        let lookup = meta
            .lookup(
                &entry.imdb_id,
                media_type,
                deadline,
                &LookupOptions::default(),
            )
            .await;
        let search = meta_from_lookup(&lookup, &entry_meta_query(entry, deadline));
        if search.name.trim().is_empty() {
            return DrainOutcome::failed();
        }

        let (items, attempted, responded) = self.search(jackett, entry, &search).await;
        if responded == 0 {
            // As consultas ACONTECERAM: a cota tem que ser debitada mesmo sem
            // resposta válida, senão o teto horário não segura o indexer morto.
            return DrainOutcome {
                ok: false,
                queries: attempted,
            };
        }
        if items.is_empty() {
            // Nada a gravar: entrada vazia apagaria o que o `/stream` já provou.
            return DrainOutcome::ok_with_queries(attempted);
        }

        let year = search.year_text();
        let relevance = relevance_items(&items);
        let settings = RelevanceSettings {
            now_ms: now,
            pre_home_release_cut: self.settings.pre_home_release_cut,
            pre_home_release_margin_ms: self.settings.pre_home_release_margin_ms,
            title_precision_tail_cut: self.settings.title_precision_tail_cut,
        };
        let query = RelevanceQuery {
            names: &search.names,
            year: &year,
            alt_year: search.alt_year.as_deref(),
            is_series: entry.media_type == HarvestMediaType::Series,
            season: entry.season.map(i64::from),
            episode: entry.episode.map(i64::from),
            multi_work_root: search.multi_work_root.as_deref(),
            home_release_at: search.home_release_at,
        };
        let kept = filter_relevant_raw(&relevance, &query, &settings).kept;
        let entered = raw_items_from_jackett(items);
        let survivors: Vec<RawItem> = kept
            .iter()
            .filter_map(|index| entered.get(*index).cloned())
            .collect();
        // Evidência BR viável desta passada: é o `found` da sonda dirigida.
        self.last_found = survivors
            .iter()
            .any(|item| item.is_br && item.seeders.unwrap_or(0.0) > 0.0);
        let release = release_entry_for(
            &entry.imdb_id,
            entry.media_type.as_str(),
            entry.season.map(i64::from),
            entry.episode.map(i64::from),
            Some(year.as_str()).filter(|year| !year.is_empty()),
            &entered,
            &survivors,
        );
        match record_release(index.as_ref(), &release, self.bank.as_deref(), now) {
            Ok(written) => {
                eprintln!(
                    "[harvest] {} {}: {} release(s) no índice ({} consulta(s))",
                    entry.imdb_id,
                    entry.media_type.as_str(),
                    written,
                    attempted
                );
                DrainOutcome::ok_with_queries(attempted)
            }
            Err(err) => {
                eprintln!(
                    "[harvest] {}: gravação no índice falhou: {err}",
                    entry.imdb_id
                );
                // As consultas ACONTECERAM: a cota tem que ser debitada mesmo
                // com a gravação quebrada.
                DrainOutcome {
                    ok: false,
                    queries: attempted,
                }
            }
        }
    }

    /// Consulta cada indexer (ou o agregado `/all`), com o gap entre eles.
    async fn search(
        &self,
        jackett: &JackettClient,
        entry: &HarvestEntry,
        search: &adom_search::orchestrator::SearchMeta,
    ) -> (Vec<JackettRawItem>, u32, u32) {
        let media = JackettMediaType::parse(entry.media_type.as_str());
        // Sonda dirigida: SÓ a interseção index-only∩pt-BR (~3 consultas), em
        // vez da varredura completa — é o que permite colher sob tráfego.
        // Interseção vazia não vira `/all`: a sonda não tem alvo e o desfecho
        // sai `failed` sem consultar nada.
        let targets_source: Vec<String> = if entry.br_probe {
            let probe = self.probe_targets();
            if probe.is_empty() {
                return (Vec::new(), 0, 0);
            }
            probe
        } else {
            self.settings.indexers.clone()
        };
        // Lista vazia = ramo agregado `/all` (um outcome `*all*`).
        let targets: Vec<Option<&str>> = if targets_source.is_empty() {
            vec![None]
        } else {
            targets_source.iter().map(|id| Some(id.as_str())).collect()
        };
        let mut items = Vec::new();
        let mut attempted = 0u32;
        let mut responded = 0u32;
        for (position, target) in targets.iter().enumerate() {
            if position > 0 && self.settings.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(self.settings.delay_ms)).await;
            }
            let id = target.unwrap_or(adom_sources::ALL_QUERY_INDEXER);
            let indexers: Vec<String> = target.map(|id| vec![id.to_string()]).unwrap_or_default();
            let options = self.options_for(id, search);
            let outcomes = jackett
                .search_outcomes(&search.query, media, &indexers, &options)
                .await;
            attempted = attempted.saturating_add(1);
            for outcome in outcomes {
                if outcome.source_ok {
                    responded = responded.saturating_add(1);
                }
                items.extend(outcome.items);
            }
        }
        (items, attempted, responded)
    }

    /// `SearchOptions` com as queries do plano e o orçamento index-only.
    fn options_for(
        &self,
        indexer: &str,
        search: &adom_search::orchestrator::SearchMeta,
    ) -> SearchOptions {
        let is_br = self.jackett_config.is_br(indexer);
        let bare = self.jackett_config.is_bare_title(indexer);
        let shaped = shape_search_query(indexer, &search.query, is_br, bare);
        let fallback = search
            .pt_query
            .as_ref()
            .filter(|pt| shape_search_query(indexer, pt, is_br, bare) != shaped);
        let original = search
            .original_query
            .as_ref()
            .filter(|orig| shape_search_query(indexer, orig, is_br, bare) != shaped);
        let index_only = self.settings.index_only.iter().any(|id| id == indexer);
        SearchOptions {
            record_status: Some(false),
            ignore_breaker: false,
            skip_resolve: false,
            timeout_ms: index_only.then_some(self.settings.index_only_timeout_ms),
            fallback_query: fallback.cloned(),
            original_query: original.cloned(),
            ..SearchOptions::default()
        }
    }
}

impl HarvestDrainAsync for NetworkDrain {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        Box::pin(self.run(entry))
    }
}
