//! Passo vivo: meta → state? → collect → build → efeitos opcionais.

use std::collections::HashMap;
use std::sync::Arc;

use adom_core::{
    build_search_query, commit_decision, parse_stremio_id, resolve_search_names, CommitFacts,
};
use serde_json::{json, Map, Value};

use super::backend::SearchBackend;
use super::{OrchestrateInput, OrchestrateResult};
use crate::cache::has_playable_stream;
use crate::contract::StreamResponse;
use crate::internal_types::{
    CollectRequest, EffectEntry, EffectsRequest, IndexWriteRequest, MetaRequest, ReleaseEntry,
    StateRequest, TaskScope,
};
use crate::list_builder::{apply_notice_origin, build_stream_list, BuildContext, DebridCheck};
use crate::raw_item::{raw_item_from_value, RawItem};
use crate::request::reply_deadline_ms;

pub(super) async fn run_live(
    input: &OrchestrateInput,
    backend: Arc<dyn SearchBackend>,
    debrid: &mut dyn DebridCheck,
    fetch_state: bool,
    side_effects: bool,
    now: i64,
) -> Result<OrchestrateResult, String> {
    let reply_ms =
        reply_deadline_ms(input.user_agent.as_deref(), input.stremio_ms, input.app_ms);
    let deadline_at = now.saturating_add(reply_ms as i64);

    let parsed = parse_stremio_id(&input.target.id);
    let imdb = parsed
        .get("imdbId")
        .and_then(Value::as_str)
        .unwrap_or(&input.target.id)
        .to_string();
    let season = parsed.get("season").and_then(Value::as_i64);
    let episode = parsed.get("episode").and_then(Value::as_i64);

    let meta = backend
        .meta(&MetaRequest {
            encoded: input.encoded.clone(),
            media_type: input.target.kind.clone(),
            id: input.target.id.clone(),
            include_multiwork: None,
            include_home_release: None,
        })
        .await?;

    let mut first_seen: HashMap<String, f64> = HashMap::new();
    if fetch_state {
        if let Ok(state) = backend
            .state(&StateRequest {
                encoded: input.encoded.clone(),
                obra_keys: vec![imdb.clone()],
                hashes: Vec::new(),
            })
            .await
        {
            for (hash, ms) in state.first_seen {
                first_seen.insert(hash, ms as f64);
            }
        }
    }

    let search_meta = resolve_search_names(&json!({
        "meta": meta.meta.clone().unwrap_or(Value::Null),
        "titles": meta.titles.clone().unwrap_or(Value::Null),
        "imdbId": imdb,
    }));
    let query = build_search_query(
        &search_meta,
        &json!({ "season": season, "episode": episode }),
    );
    let names: Vec<String> = search_meta
        .get("names")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let year = search_meta
        .get("year")
        .map(|y| match y {
            Value::Null => String::new(),
            other => other
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| other.to_string()),
        })
        .unwrap_or_default();
    let alt_year = search_meta
        .get("altYear")
        .and_then(Value::as_i64)
        .map(|y| y.to_string());

    let pt_query = meta
        .titles
        .as_ref()
        .and_then(|t| t.get("pt").and_then(Value::as_str))
        .filter(|pt| {
            let original = meta
                .titles
                .as_ref()
                .and_then(|t| t.get("original").and_then(Value::as_str));
            Some(*pt) != original
        })
        .map(|pt| {
            build_search_query(
                &json!({ "name": pt, "year": search_meta.get("year") }),
                &json!({ "season": season, "episode": episode }),
            )
        });

    let (items_json, collect_partial) = match backend
        .collect(&CollectRequest {
            encoded: input.encoded.clone(),
            query: query.clone(),
            media_type: input.target.kind.clone(),
            imdb: imdb.clone(),
            deadline_at,
            task_scope: Some(TaskScope::All),
            pt_query,
            season,
            episode,
            year: search_meta.get("year").cloned(),
            names: Some(names.clone()),
            sweep_query: None,
            original_query: None,
            multi_work_query: None,
        })
        .await
    {
        Ok(resp) => (resp.items, resp.partial),
        Err(_) => (Vec::new(), true),
    };

    let raw: Vec<RawItem> = items_json.iter().map(raw_item_from_value).collect();
    let ctx = BuildContext {
        names,
        year,
        alt_year,
        season: season.or(meta.season),
        episode: episode.or(meta.episode),
        first_seen_ms: first_seen,
        now_ms: now,
        debrid_available: false,
        ..BuildContext::default()
    };

    let built = build_stream_list(&raw, &ctx, &input.build, debrid, &input.display);
    let prefix = if input.config_prefix.is_empty() {
        String::new()
    } else if input.config_prefix.starts_with('/') {
        input.config_prefix.clone()
    } else {
        format!("/{}", input.config_prefix)
    };
    let streams = apply_notice_origin(&built.streams, input.origin.as_deref(), &prefix);

    // Index-write usa o lote filtrado (`filtered_raw`), não o cru.
    if side_effects && !built.filtered_raw.is_empty() {
        let backend = Arc::clone(&backend);
        let encoded = input.encoded.clone();
        let items_for_index: Vec<Value> = built
            .filtered_raw
            .iter()
            .map(|r| {
                json!({
                    "title": r.title,
                    "infoHash": r.info_hash,
                    "magnet": r.magnet,
                    "indexer": r.indexer,
                    "isBr": r.is_br,
                })
            })
            .collect();
        let releases = vec![ReleaseEntry {
            imdb: imdb.clone(),
            season,
            episode,
            items: items_for_index,
            entered: None,
            survivors: None,
            source: Some("orchestrate".into()),
        }];
        tokio::spawn(async move {
            let _ = backend
                .index_write(&IndexWriteRequest {
                    encoded: encoded.clone(),
                    releases,
                })
                .await;
            let _ = backend
                .effects(&EffectsRequest {
                    encoded,
                    effects: vec![EffectEntry {
                        kind: "search-done".into(),
                        payload: Map::new(),
                    }],
                })
                .await;
        });
    }

    let playable = has_playable_stream(&streams);
    let decision = commit_decision(&CommitFacts {
        playable,
        partial: collect_partial,
        debrid_known: if built.debrid_known {
            Some(true)
        } else if built.needs_debrid_refresh {
            Some(false)
        } else {
            None
        },
        needs_debrid_refresh: built.needs_debrid_refresh,
        has_fallback: false,
        cache_ttl: input.cache_ttl,
        fallback_streams_ttl: input.fallback_streams_ttl,
    });

    Ok(OrchestrateResult {
        built,
        response: StreamResponse {
            streams,
            cache_max_age: decision.ttl.max(0) as u32,
        },
        partial: decision.partial,
        cache_max_age: decision.ttl.max(0) as u32,
        revalidate: false,
        from_cache: false,
    })
}
