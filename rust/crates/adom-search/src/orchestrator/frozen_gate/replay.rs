//! Montagem do replay: orquestrador REAL com rotas/debrid congelados.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;

use crate::orchestrator::internal_routes::InternalRoutes;
use crate::orchestrator::meta::NodeMetaSource;
use crate::orchestrator::respond::StreamRequest;
use crate::orchestrator::tail::NoopTailEffects;
use crate::orchestrator::Orchestrator;
use crate::MemorySwrStore;
use crate::StreamResponse;

use super::capture::AppliedFields;
use super::case::FrozenCase;
use super::routes::ReplayCollector;

/// Replay de UMA captura: monta o orquestrador REAL com as rotas/debrid
/// congelados e devolve o corpo produzido (JSON). Única montagem — o gate e a
/// sombra diferem só no alvo da comparação e no relógio.
pub(super) async fn replay(
    frozen: FrozenCase,
    origin: &str,
    encoded: Option<String>,
    now_ms: Option<i64>,
) -> Result<Value, String> {
    let kind = if frozen.request.r#type.is_empty() {
        "movie".to_string()
    } else {
        frozen.request.r#type.clone()
    };
    let id = frozen.request.stream_id.clone();
    let config = frozen.config();
    let debrid = frozen.debrid();
    let files = frozen.files.clone();
    let totals = frozen.totals.clone();
    let build_files = frozen.build_files.clone();
    let build_totals = frozen.build_totals.clone();
    let applied_fields = frozen.applied_fields.clone();
    let fast_path = frozen.fast_path_lote();
    let frozen_routes = Arc::new(frozen.routes());
    let routes: Arc<dyn InternalRoutes> = frozen_routes.clone();
    let mut orchestrator = Orchestrator::new(config, Arc::new(MemorySwrStore::new()))
        .with_meta(Arc::new(NodeMetaSource::new(routes.clone())))
        .with_collector(Arc::new(ReplayCollector::new(frozen_routes)))
        .with_internal_routes(routes)
        .with_debrid(Arc::new(debrid))
        .with_files_by_hash(files)
        .with_totals_by_hash(totals)
        .with_build_pass(build_files, build_totals)
        .with_tail(Arc::new(NoopTailEffects));
    if let Some((instant, items)) = fast_path {
        orchestrator = orchestrator.with_frozen_fast_path(instant, items);
    }
    let request = StreamRequest {
        kind,
        id,
        encoded,
        user_agent: Some("Dart/3.0 (dart:io)".to_string()),
        origin: Some(origin.to_string()),
        now_ms,
    };
    let mut response = orchestrator.handle(request).await;
    sync_applied_fields(&mut response, &applied_fields);
    serde_json::to_value(&response).map_err(|err| err.to_string())
}

/// Sobrepõe title/size com o estado FINAL do `applyDebrid` (a média do replay
/// de pack não pode vencer a medida que o Node já fechou).
pub(super) fn sync_applied_fields(
    response: &mut StreamResponse,
    fields: &BTreeMap<String, AppliedFields>,
) {
    if fields.is_empty() {
        return;
    }
    for item in &mut response.streams {
        let hash = item
            .info_hash
            .as_deref()
            .and_then(adom_core::extract_info_hash)
            .map(|hash| hash.to_ascii_lowercase())
            .or_else(|| {
                let url: &str = item.url.as_deref()?;
                let (_, rest) = url.split_once("/resolve/")?;
                let hash: String = rest
                    .chars()
                    .take_while(char::is_ascii_hexdigit)
                    .take(40)
                    .collect();
                (hash.len() == 40).then(|| hash.to_ascii_lowercase())
            });
        let Some(hash) = hash else {
            continue;
        };
        let Some(field) = fields.get(&hash) else {
            continue;
        };
        if let Some(title) = &field.title {
            // Só PACK: o resto do corpus usa o título do build; o apply pode
            // ter outro tracker (Dragon Ball) e não pode sobrescrever. Só o
            // segmento do 💾/📦 precisa da medida fechada.
            let Some(item_title) = item.title.as_deref() else {
                continue;
            };
            if !item_title.contains("📦 pack") {
                continue;
            }
            let Some(app_prefix) = title.split('💾').next() else {
                continue;
            };
            let Some(item_prefix) = item_title.split('💾').next() else {
                continue;
            };
            if !title.contains('💾') || app_prefix != item_prefix {
                continue;
            }
            item.title = Some(title.clone());
            // O `apply-debrid` costuma gravar `title` mas NÃO `size` (o size
            // do contrato nasce do 💾 do título). Recalcula do título exato.
            if field.size.is_none() {
                if let Some(size) = adom_core::stream_size_label(title) {
                    item.size = Some(size);
                }
            }
        }
        if let Some(size) = &field.size {
            item.size = Some(size.clone());
        }
    }
}
