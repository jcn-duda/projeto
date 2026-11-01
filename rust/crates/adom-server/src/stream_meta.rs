//! Montagem da fonte de metadados do `/stream` nativo (C5).
//!
//! O nativo (`adom-sources`) é SEMPRE a fonte primária: clientes puros de
//! Cinemeta/TMDB + coleção/data, com o `cache.db` do Node como store — os
//! valores são gravados no MESMO formato (`meta:`, `tmdb:`, `tmdbc:`, `tmdbh:`),
//! então reinício/queda não esfriam metadados nem mudam o que o Node lê.
//!
//! Com rotas internas o Node entrava como FALLBACK (rede fora/título não
//! resolvido). O fallback saiu no passo 2 do corte de 2026-10-31
//! (`docs/superpowers/plans/2026-10-31-corte-fallback-meta.md`): não há camada
//! nenhuma aqui — [`native_source`] devolve o nativo ou `None`.

use std::sync::Arc;

use adom_search::orchestrator::{MetaSource, NativeMetaSource};
use adom_sources::{MemoryMetaStore, MetaSources, MetaStore, SourcesConfig};
use adom_store::MetaCacheStore;

/// Fonte de produção do `/stream`. `None` = os clientes não montaram (o
/// `Orchestrator` mantém o `IdOnlyMeta`, que nunca inventa consulta).
pub fn native_source() -> Option<Arc<dyn MetaSource>> {
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
