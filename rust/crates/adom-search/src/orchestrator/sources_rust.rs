//! Montagem dos coletores NATIVOS do `/stream`.
//!
//! As cinco fontes migradas são tentadas SEMPRE — `jackett`, `prowlarr`,
//! `torrentio`, `bludv`, `mico` — e a lista devolvida é a UNIÃO do que montou.
//! Não há mais env de seleção de fontes: fonte que falha no boot loga e
//! fica fora, e quem chama decide se ainda há coleta possível (lista vazia =
//! boot do gateway falha, sem queda silenciosa).
//!
//! Múltiplas fontes são compostas por [`super::CompositeCollector`], que
//! executa todas em paralelo e combina os lotes.

use std::sync::Arc;

use adom_sources::RawStore;

use super::bludv_collector::try_bludv_collector_from_env_with_store;
use super::collect::Collector;
use super::jackett_collector::try_jackett_collector_from_env;
use super::mico_collector::try_mico_collector_from_env;
use super::prowlarr_collector::try_prowlarr_collector_from_env;
use super::torrentio_collector::try_torrentio_collector_from_env;

/// Coletores nativos que montaram, na ordem fixa das fontes.
///
/// `raw_store` é o `raw:v1` (`cache.db` do Node) injetado só no BLUDV; as
/// outras fontes ignoram o parâmetro. Cada `try_*` loga a própria falha de
/// boot — aqui não há mais token de skip nem seleção por env.
pub fn try_native_collectors_with_bludv_store(
    raw_store: Option<Arc<dyn RawStore>>,
) -> Vec<Arc<dyn Collector>> {
    let mut native: Vec<Arc<dyn Collector>> = Vec::new();
    if let Some(collector) = try_jackett_collector_from_env() {
        native.push(Arc::new(collector));
    }
    if let Some(collector) = try_prowlarr_collector_from_env() {
        native.push(Arc::new(collector));
    }
    if let Some(collector) = try_torrentio_collector_from_env() {
        native.push(Arc::new(collector));
    }
    if let Some(collector) = try_bludv_collector_from_env_with_store(raw_store) {
        native.push(Arc::new(collector));
    }
    if let Some(collector) = try_mico_collector_from_env() {
        native.push(Arc::new(collector));
    }
    native
}
