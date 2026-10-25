//! `HarvestDrainAsync` real: metadados nativos → Jackett → (FULL) BLUDV →
//! régua → índice.
//!
//! Nada aqui inventa régua nova:
//!
//! - queries saem de [`meta_from_lookup`], a MESMA montagem do `/stream`
//!   (`query` + `pt_query` + `original_query`); a forma por indexer passa por
//!   `shape_search_query`, como no cliente;
//! - relevância é `filter_relevant_raw` com os campos do plano de build do
//!   orquestrador (`pre_home_release_cut`, margem e cauda de precisão);
//! - gravação é `harvest_support::{release_entry_for, record_release}`.
//!
//! BLUDV é complemento opcional do FULL: não entra na sonda, não debita o
//! contador Jackett e nunca certifica `jackett_complete`.
//!
//! **Sem índice nativo** o drain falha com 0 consultas e loga uma vez
//! (`[harvest] sem índice nativo; colheita falhou sem consultar`). Sem
//! Jackett configurado a obra falha (`failed`), como no Node quando a fonte
//! não responde.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use adom_core::RelevanceSettings;
use adom_harvest::{BrProbe, DrainOutcome, HarvestDrainAsync, HarvestEntry, ProbeConfig};
use adom_search::orchestrator::{meta_from_lookup, Orchestrator, SharedBank, SharedIndex};
use adom_sources::{
    now_ms, BludvClient, JackettClient, JackettConfig, LookupOptions, MediaType, MemoryMetaStore,
    MetaSources, MetaStore, SourcesConfig,
};
use adom_store::{MetaCacheStore, StreamsStore};

use super::config::HarvestConfig;
use super::drain_record::{record_collected, retry_invalidations, RecordArgs};
use super::drain_shape::{entry_meta_query, jackett_targets_complete, live_exempt_indexers};
use super::drain_sources::{source_plan, SourcePlan};

/// Prazo do lookup de metadados. O colhedor não tem prazo de usuário, mas não
/// pode pendurar o ciclo para sempre.
const LOOKUP_TIMEOUT_MS: i64 = 4_000;

/// Fatia do orquestrador que o drain precisa (nada de estado vivo do `/stream`).
pub(super) struct DrainSettings {
    pub(super) indexers: Vec<String>,
    pub(super) index_only: Vec<String>,
    pub(super) delay_ms: u64,
    pub(super) index_only_timeout_ms: u64,
    pre_home_release_cut: bool,
    pre_home_release_margin_ms: i64,
    title_precision_tail_cut: bool,
}

/// Drain de produção, montado uma vez na thread do colhedor.
pub(crate) struct NetworkDrain {
    meta: Option<MetaSources>,
    jackett: Option<JackettClient>,
    pub(super) jackett_config: JackettConfig,
    index: Option<SharedIndex>,
    bank: Option<SharedBank>,
    pub(super) settings: DrainSettings,
    /// Interseção dirigida (index-only ∩ pt-BR − isentos): a régua é a do
    /// crate, montada uma vez com as listas do processo.
    probe: BrProbe,
    /// Cliente BLUDV montado uma vez; default desligado. Falha de raw degrada.
    pub(super) bludv: Option<BludvClient>,
    /// Evidência BR viável da última obra — o desfecho da sonda lê e zera.
    last_found: bool,
    streams: Option<Arc<StreamsStore>>,
    pending_invalidate: HashSet<String>,
    warned_no_index: bool,
    warned_no_meta: bool,
    warned_no_jackett: bool,
}

impl NetworkDrain {
    pub(crate) fn new(
        orch: &Orchestrator,
        harvest: &HarvestConfig,
        streams: Option<Arc<StreamsStore>>,
    ) -> Self {
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
        let bludv = match BludvClient::from_env() {
            Ok(client) => Some(match adom_store::raw_store_from_env() {
                Ok(store) => client.with_raw_store(Arc::new(store)),
                Err(err) => {
                    eprintln!("[harvest] raw:v1 do BLUDV indisponível ({err}); cliente sem cache");
                    client
                }
            }),
            Err(err) => {
                eprintln!("[harvest] BLUDV indisponível: {err}");
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
            bludv,
            streams,
            pending_invalidate: HashSet::new(),
            warned_no_index: false,
            warned_no_meta: false,
            warned_no_jackett: false,
        }
    }

    /// Pausa entre indexers (`harvestIndexerDelayMs` do painel).
    pub(crate) fn set_indexer_delay(&mut self, delay_ms: u64) {
        self.settings.delay_ms = delay_ms;
    }

    /// Evidência BR viável da última obra (consumida pelo desfecho da sonda).
    pub(crate) fn take_found(&mut self) -> bool {
        std::mem::take(&mut self.last_found)
    }

    /// Drain com clientes injetados (metadados/Jackett/BLUDV locais).
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(super) fn for_test(
        meta: MetaSources,
        jackett: JackettClient,
        jackett_config: JackettConfig,
        index: SharedIndex,
        streams: Option<Arc<StreamsStore>>,
        bludv: Option<BludvClient>,
        indexers: Vec<String>,
        index_only: Vec<String>,
        delay_ms: u64,
    ) -> Self {
        let probe = BrProbe::new(ProbeConfig {
            index_only_indexers: index_only.clone(),
            pt_br_indexers: jackett_config.pt_br_indexers.clone(),
            live_exempt_indexers: live_exempt_indexers(),
            ..ProbeConfig::default()
        });
        Self {
            meta: Some(meta),
            jackett: Some(jackett),
            jackett_config,
            probe,
            index: Some(index),
            bank: None,
            settings: DrainSettings {
                indexers,
                index_only,
                delay_ms,
                index_only_timeout_ms: 5_000,
                pre_home_release_cut: false,
                pre_home_release_margin_ms: 0,
                title_precision_tail_cut: false,
            },
            last_found: false,
            bludv,
            streams,
            pending_invalidate: HashSet::new(),
            warned_no_index: false,
            warned_no_meta: false,
            warned_no_jackett: false,
        }
    }

    /// Subset dirigido da sonda: a MESMA interseção de `BrProbe::probe_indexers`
    /// (index-only ∩ pt-BR − isentos da busca viva).
    pub(super) fn probe_targets(&self) -> Vec<String> {
        self.probe
            .probe_indexers()
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    /// Uma obra: metadados, consultas espaçadas, régua e gravação.
    ///
    /// `queries_left` é o teto rígido da hora corrente: os alvos Jackett
    /// param no saldo, e o que ficou sem consultar torna a gravação
    /// suplementar (registro parcial) em vez de falhar a entrada.
    async fn run(&mut self, entry: &HarvestEntry, queries_left: u32) -> DrainOutcome {
        self.last_found = false;
        retry_invalidations(self.streams.as_ref(), &mut self.pending_invalidate);
        let Some(index) = self.index.clone() else {
            if !self.warned_no_index {
                self.warned_no_index = true;
                eprintln!("[harvest] sem índice nativo; colheita falhou sem consultar");
            }
            return DrainOutcome::failed();
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

        let batch = self.search(jackett, entry, &search, queries_left).await;
        // Cortou alvos ⇒ registro parcial: `jackett_complete` exige TODOS os
        // alvos planejados consultados e respondidos.
        let jackett_complete = batch.remaining_targets == 0
            && jackett_targets_complete(batch.attempted, batch.answered);
        match source_plan(batch.answered, !batch.items.is_empty()) {
            SourcePlan::FailNoWrite => {
                // Consultas Jackett já tentadas continuam debitadas.
                DrainOutcome {
                    ok: false,
                    queries: batch.attempted,
                }
            }
            SourcePlan::OkNoWrite => {
                // Nada a gravar: entrada vazia apagaria o que o `/stream` já provou.
                DrainOutcome::ok_with_queries(batch.attempted)
            }
            SourcePlan::Write { ok: succeed } => {
                let year = search.year_text();
                let recorded = record_collected(RecordArgs {
                    index: index.as_ref(),
                    bank: self.bank.as_ref(),
                    streams: self.streams.as_ref(),
                    pending_invalidate: &mut self.pending_invalidate,
                    entry,
                    items: batch.items,
                    attempted: batch.attempted,
                    jackett_complete,
                    settings: RelevanceSettings {
                        now_ms: now,
                        pre_home_release_cut: self.settings.pre_home_release_cut,
                        pre_home_release_margin_ms: self.settings.pre_home_release_margin_ms,
                        title_precision_tail_cut: self.settings.title_precision_tail_cut,
                    },
                    names: &search.names,
                    year: &year,
                    alt_year: search.alt_year.as_deref(),
                    multi_work_root: search.multi_work_root.as_deref(),
                    home_release_at: search.home_release_at,
                    now_ms: now,
                });
                self.last_found = recorded.found;
                if succeed {
                    recorded.outcome
                } else {
                    DrainOutcome {
                        ok: false,
                        queries: batch.attempted,
                    }
                }
            }
        }
    }
}

impl HarvestDrainAsync for NetworkDrain {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
        queries_left: u32,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        Box::pin(self.run(entry, queries_left))
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod network_tests;
