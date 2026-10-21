//! Montagem da fonte de metadados do `/stream` nativo (C5).
//!
//! Default: `NodeMetaSource` (rota interna), como antes. `META_RUST` troca a
//! fonte pela implementação pura de `adom-sources`, com o Node como FALLBACK
//! (rede fora/título não resolvido) e o `cache.db` do Node como store — os
//! valores são gravados no MESMO formato (`meta:`, `tmdb:`, `tmdbc:`, `tmdbh:`),
//! então reinício/queda não esfriam metadados nem mudam o que o Node lê.
//!
//! Rollback: `META_RUST=` (vazio/OFF) volta ao Node. A flag não altera o
//! caminho Node default nem a rota interna `/internal/search/meta`.

use std::sync::Arc;

use adom_search::orchestrator::{
    meta_rust_enabled, FallbackMetaSource, InternalRoutes, MetaSource, NativeMetaSource,
    NodeMetaSource,
};
use adom_sources::{MemoryMetaStore, MetaSources, MetaStore, SourcesConfig};
use adom_store::MetaCacheStore;

/// Fonte de produção do `/stream`.
///
/// `None` = nem Node nem nativo (o `Orchestrator` mantém o `IdOnlyMeta`, que
/// nunca inventa consulta).
pub fn meta_source(routes: Option<Arc<dyn InternalRoutes>>) -> Option<Arc<dyn MetaSource>> {
    let node: Option<Arc<dyn MetaSource>> = routes
        .clone()
        .map(|routes| Arc::new(NodeMetaSource::new(routes)) as Arc<dyn MetaSource>);
    if !meta_rust_enabled() {
        return node;
    }

    let Some(native) = native_source() else {
        eprintln!("[gateway] META_RUST ligado, mas a fonte nativa não montou; usando Node");
        return node;
    };
    let Some(node) = node else {
        // Sem rotas internas o nativo é a única fonte (o caminho de metadados
        // passa a funcionar em instalação sem Node).
        return Some(native);
    };
    Some(Arc::new(FallbackMetaSource::new(native, node)))
}

/// Clientes puros de Cinemeta/TMDB. Falha ao abrir o SQLite cai em memória — o
/// caminho vivo perde a persistência, mas NUNCA a busca.
fn native_source() -> Option<Arc<dyn MetaSource>> {
    let config = SourcesConfig::from_env();
    let store: Arc<dyn MetaStore> = match MetaCacheStore::from_env() {
        Ok(store) => {
            eprintln!("[gateway] metadados nativos no cache.db do Node");
            Arc::new(store)
        }
        Err(err) => {
            eprintln!("[gateway] cache.db de metadados indisponível ({err}); memória");
            Arc::new(MemoryMetaStore::new())
        }
    };
    match MetaSources::new(config, store) {
        Ok(sources) => Some(Arc::new(NativeMetaSource::new(Arc::new(sources)))),
        Err(err) => {
            eprintln!("[gateway] clientes de metadados nativos não montaram: {err}");
            None
        }
    }
}
