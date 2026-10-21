//! Montagem da fonte de metadados do `/stream` nativo (C5).
//!
//! Default: `NodeMetaSource` (rota interna), como antes. `META_RUST` troca a
//! fonte pela implementação pura de `adom-sources`, com o Node como FALLBACK
//! (rede fora/título não resolvido) e o `cache.db` do Node como store — os
//! valores são gravados no MESMO formato (`meta:`, `tmdb:`, `tmdbc:`, `tmdbh:`),
//! então reinício/queda não esfriam metadados nem mudam o que o Node lê.
//!
//! `META_RUST_SHADOW` arma a sombra compare-only (`meta.shadow.*` no
//! `/metrics`). Onde a referência toca o cache, ela é read-only: a sombra nunca
//! altera o que o caminho de resposta lê. Amostragem determinística por
//! `META_RUST_SHADOW_PERCENT`; prazo próprio por `META_RUST_SHADOW_TIMEOUT_MS`.
//!
//! Rollback: `META_RUST=` (vazio/OFF) volta ao Node; `META_RUST_SHADOW=` desliga
//! só a comparação. Nenhuma das flags muda o caminho Node default.

use std::sync::Arc;

use adom_search::orchestrator::{
    meta_rust_enabled, meta_shadow_enabled, meta_shadow_percent_from, meta_shadow_timeout_ms_from,
    wrap_meta_with_shadow, FallbackMetaSource, InternalRoutes, MetaSource, NativeMetaSource,
    NodeMetaSource, META_SHADOW_PERCENT_ENV, META_SHADOW_TIMEOUT_ENV,
};
use adom_sources::{MemoryMetaStore, MetaSources, MetaStore, ReadOnlyMetaStore, SourcesConfig};
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
        let node = node?;
        if !meta_shadow_enabled() {
            return Some(node);
        }
        // Sombra com o Node na resposta: a referência nativa lê o cache do Node
        // (read-only) para não pagar rede duas vezes quando ele está quente.
        let Some(native) = native_source(true) else {
            eprintln!("[meta-shadow] fonte nativa indisponível; sombra desligada");
            return Some(node);
        };
        return Some(arm_shadow(node, native));
    }

    let Some(native) = native_source(false) else {
        eprintln!("[gateway] META_RUST ligado, mas a fonte nativa não montou; usando Node");
        return node;
    };
    let Some(node) = node else {
        // Sem rotas internas o nativo é a única fonte (o caminho de metadados
        // passa a funcionar em instalação sem Node).
        return Some(native);
    };
    let primary: Arc<dyn MetaSource> = Arc::new(FallbackMetaSource::new(native, node.clone()));
    if !meta_shadow_enabled() {
        return Some(primary);
    }
    Some(arm_shadow(primary, node))
}

fn arm_shadow(primary: Arc<dyn MetaSource>, reference: Arc<dyn MetaSource>) -> Arc<dyn MetaSource> {
    let percent = meta_shadow_percent_from(std::env::var(META_SHADOW_PERCENT_ENV).ok().as_deref());
    let timeout =
        meta_shadow_timeout_ms_from(std::env::var(META_SHADOW_TIMEOUT_ENV).ok().as_deref());
    eprintln!("[meta-shadow] armada (compare-only, amostra {percent}%, prazo {timeout}ms)");
    wrap_meta_with_shadow(primary, reference, percent, timeout)
}

/// Clientes puros de Cinemeta/TMDB. `read_only` = sombra (nunca grava; lê o
/// cache quente do Node). Falha ao abrir o SQLite cai em memória — o caminho
/// vivo perde a persistência, mas NUNCA a busca.
fn native_source(read_only: bool) -> Option<Arc<dyn MetaSource>> {
    let config = SourcesConfig::from_env();
    let aberto = if read_only {
        MetaCacheStore::from_env_read_only()
    } else {
        MetaCacheStore::from_env()
    };
    let store: Arc<dyn MetaStore> = match aberto {
        Ok(store) => {
            let store: Arc<dyn MetaStore> = Arc::new(store);
            if read_only {
                eprintln!("[meta-shadow] referência nativa lê o cache.db do Node (read-only)");
                Arc::new(ReadOnlyMetaStore::new(store))
            } else {
                eprintln!("[gateway] metadados nativos no cache.db do Node");
                store
            }
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
