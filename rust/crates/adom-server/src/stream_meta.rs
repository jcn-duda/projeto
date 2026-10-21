//! Montagem da fonte de metadados do `/stream` nativo (C5).
//!
//! O nativo (`adom-sources`) é SEMPRE a fonte primária: clientes puros de
//! Cinemeta/TMDB + coleção/data, com o `cache.db` do Node como store — os
//! valores são gravados no MESMO formato (`meta:`, `tmdb:`, `tmdbc:`, `tmdbh:`),
//! então reinício/queda não esfriam metadados nem mudam o que o Node lê.
//!
//! Com rotas internas o Node entra como FALLBACK (rede fora/título não
//! resolvido) via [`FallbackMetaSource`] — ele fica até haver medida da taxa de
//! fallback. Sem rotas, o nativo responde sozinho.

use std::sync::Arc;

use adom_search::orchestrator::{
    FallbackMetaSource, InternalRoutes, MetaSource, NativeMetaSource, NodeMetaSource,
};
use adom_sources::{MemoryMetaStore, MetaSources, MetaStore, SourcesConfig};
use adom_store::MetaCacheStore;

/// Fonte de produção do `/stream`.
///
/// Nativo primeiro; com rotas internas o Node responde só quando o nativo falha
/// (ou volta sem nome). `None` = nenhuma fonte montou (o `Orchestrator` mantém o
/// `IdOnlyMeta`, que nunca inventa consulta).
pub fn meta_source(routes: Option<Arc<dyn InternalRoutes>>) -> Option<Arc<dyn MetaSource>> {
    let node: Option<Arc<dyn MetaSource>> =
        routes.map(|routes| Arc::new(NodeMetaSource::new(routes)) as Arc<dyn MetaSource>);
    let Some(native) = native_source() else {
        if node.is_some() {
            eprintln!("[gateway] metadados nativos não montaram; usando Node");
        }
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
