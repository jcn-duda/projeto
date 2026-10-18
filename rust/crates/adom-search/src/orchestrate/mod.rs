//! Orquestração da busca nativa — liga meta → state? → collect → build
//! sem abrir rota HTTP.
//!
//! Sequência: SWR → inFlight? → meta → state? → collect(`deadline_at`) →
//! build → index-write/effects (opt-in) → `commit_decision`.
//! Meta em falha → `Err`; collect em falha → parcial honesto. Nunca panic.

mod backend;
mod run;

pub use backend::{BoxFut, SearchBackend};

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use adom_core::{commit_decision, CommitFacts, RankingStream, StreamDisplayConfig};
use serde_json::json;

use crate::cache::{
    has_playable_stream, swr_lookup, to_cacheable_entry, StreamsEntry, SwrLookup, SwrStore,
    STREAM_STALE_GRACE_SECONDS,
};
use crate::coalesce::InFlight;
use crate::contract::{StreamItem, StreamResponse};
use crate::list_builder::{
    apply_notice_origin, BuildOptions, BuiltList, BuiltStream, DebridAnswer, DebridCheck,
};
use crate::request::{decode_user_config, request_cache_key, StreamTarget};
use run::run_live;

/// Entrada da orquestração (alvo + prazo + opções de build).
#[derive(Debug, Clone)]
pub struct OrchestrateInput {
    pub target: StreamTarget,
    /// Segmento de config no corpo das rotas internas (nunca do `.env`).
    pub encoded: String,
    pub user_agent: Option<String>,
    pub stremio_ms: u64,
    pub app_ms: u64,
    pub build: BuildOptions,
    pub display: StreamDisplayConfig,
    /// Origin da requisição (`apply_notice_origin`); sem host = relativo.
    pub origin: Option<String>,
    /// Prefixo `/{encoded}` na URL do aviso/configure.
    pub config_prefix: String,
    pub cache_ttl: i64,
    pub fallback_streams_ttl: i64,
}

impl Default for OrchestrateInput {
    fn default() -> Self {
        Self {
            target: StreamTarget {
                kind: "movie".into(),
                id: "tt0".into(),
                encoded: None,
            },
            encoded: "e30".into(),
            user_agent: None,
            stremio_ms: 9200,
            app_ms: 15_000,
            build: BuildOptions::default(),
            display: StreamDisplayConfig::default(),
            origin: None,
            config_prefix: String::new(),
            cache_ttl: 900,
            fallback_streams_ttl: 60,
        }
    }
}

/// Dependências injetáveis (clientes + cache opcional).
pub struct OrchestrateDeps<'a> {
    pub backend: Arc<dyn SearchBackend>,
    pub debrid: Option<&'a mut dyn DebridCheck>,
    pub store: Option<&'a dyn SwrStore>,
    pub in_flight: Option<&'a InFlight<Result<OrchestrateResult, String>>>,
    pub fetch_state: bool,
    pub side_effects: bool,
    pub now_ms: Option<i64>,
}

/// Resultado pronto para o handler HTTP montar a resposta.
#[derive(Debug, Clone)]
pub struct OrchestrateResult {
    pub built: BuiltList,
    pub response: StreamResponse,
    pub partial: bool,
    pub cache_max_age: u32,
    pub revalidate: bool,
    pub from_cache: bool,
}

struct UnknownDebrid;

impl DebridCheck for UnknownDebrid {
    fn check(&mut self, _stream: &RankingStream) -> DebridAnswer {
        DebridAnswer::Unknown
    }
}

/// Orquestra uma busca. Meta em falha → `Err`; collect em falha → parcial.
pub async fn orchestrate(
    input: &OrchestrateInput,
    deps: &mut OrchestrateDeps<'_>,
) -> Result<OrchestrateResult, String> {
    let now = deps.now_ms.unwrap_or_else(now_ms);
    let opts = decode_user_config(&input.encoded).unwrap_or_else(|_| json!({}));
    let cache_key = request_cache_key(&input.target.kind, &input.target.id, &opts);

    if let Some(store) = deps.store {
        let hit = store.get_with_stale(&cache_key, STREAM_STALE_GRACE_SECONDS, now as u64);
        if let SwrLookup::Serve { entry, revalidate } = swr_lookup(hit) {
            let cache_max_age = if revalidate {
                0
            } else {
                input.cache_ttl.max(0) as u32
            };
            // Host nunca no cache: remonta origin+prefix só na resposta
            // (espelha `entry_streams` do orquestrador WIP / `run_live`).
            let streams = entry_streams(&entry, input);
            return Ok(OrchestrateResult {
                built: BuiltList {
                    streams: streams
                        .iter()
                        .cloned()
                        .map(|item| BuiltStream {
                            info_hash: item.info_hash.clone(),
                            item,
                            is_br: false,
                            notice: entry.notice,
                            cached: false,
                            dubbed: false,
                            multi_work_admitted: false,
                        })
                        .collect(),
                    debrid_known: entry.debrid_known.unwrap_or(false),
                    ..BuiltList::default()
                },
                response: StreamResponse {
                    streams,
                    cache_max_age,
                },
                partial: entry.partial,
                cache_max_age,
                revalidate,
                from_cache: true,
            });
        }
    }

    // Com debrid injetado NÃO coalescemos (memo do check é por busca).
    let mut result = if let Some(debrid) = deps.debrid.as_deref_mut() {
        run_live(
            input,
            Arc::clone(&deps.backend),
            debrid,
            deps.fetch_state,
            deps.side_effects,
            now,
        )
        .await?
    } else if let Some(flight) = deps.in_flight {
        let input = input.clone();
        let backend = Arc::clone(&deps.backend);
        let fetch_state = deps.fetch_state;
        let side_effects = deps.side_effects;
        flight
            .coalesce(&cache_key, || async move {
                run_live(
                    &input,
                    backend,
                    &mut UnknownDebrid,
                    fetch_state,
                    side_effects,
                    now,
                )
                .await
            })
            .await?
    } else {
        run_live(
            input,
            Arc::clone(&deps.backend),
            &mut UnknownDebrid,
            deps.fetch_state,
            deps.side_effects,
            now,
        )
        .await?
    };

    if let Some(store) = deps.store {
        if !result.from_cache {
            let playable = has_playable_stream(&result.response.streams);
            let decision = commit_decision(&CommitFacts {
                playable,
                partial: result.partial,
                debrid_known: if result.built.debrid_known {
                    Some(true)
                } else if result.built.needs_debrid_refresh {
                    Some(false)
                } else {
                    None
                },
                needs_debrid_refresh: result.built.needs_debrid_refresh,
                has_fallback: false,
                cache_ttl: input.cache_ttl,
                fallback_streams_ttl: input.fallback_streams_ttl,
            });
            result.partial = decision.partial;
            result.cache_max_age = decision.ttl.max(0) as u32;
            result.response.cache_max_age = result.cache_max_age;
            if decision.write {
                let entry = to_cacheable_entry(&StreamsEntry {
                    streams: result.response.streams.clone(),
                    partial: decision.partial,
                    debrid_known: Some(decision.debrid_known),
                    fallback: false,
                    notice: result.built.streams.iter().all(|s| s.notice),
                    trace: None,
                    search_meta: None,
                });
                store.set(&cache_key, &entry, decision.ttl.max(0) as u64, now as u64);
            }
        }
    }

    Ok(result)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Prefixo `/{encoded}` normalizado (mesma regra do live em `run.rs`).
fn config_prefix(input: &OrchestrateInput) -> String {
    if input.config_prefix.is_empty() {
        String::new()
    } else if input.config_prefix.starts_with('/') {
        input.config_prefix.clone()
    } else {
        format!("/{}", input.config_prefix)
    }
}

/// Streams do hit SWR com host da requisição atual — a entrada guarda só path.
fn entry_streams(entry: &StreamsEntry, input: &OrchestrateInput) -> Vec<StreamItem> {
    let built: Vec<BuiltStream> = entry
        .streams
        .iter()
        .map(|item| BuiltStream {
            item: item.clone(),
            is_br: false,
            // Marca de aviso é da ENTRADA (cache não guarda `notice` por item).
            notice: entry.notice,
            cached: false,
            info_hash: item.info_hash.clone(),
            dubbed: false,
            multi_work_admitted: false,
        })
        .collect();
    apply_notice_origin(&built, input.origin.as_deref(), &config_prefix(input))
}

#[cfg(test)]
#[path = "../orchestrate_tests.rs"]
mod orchestrate_tests;
