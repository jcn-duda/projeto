//! Adaptadores de stores/efeitos auxiliares usados pelo builder do orquestrador.

use std::sync::Arc;

use adom_search::{HoldsFeed, NodeHoldsFeed};

/// Store do ledger `rdc:v2` no `cache.db`, aberto somente para leitura.
pub(super) fn rd_ledger_store() -> Option<Arc<adom_debrid::Store>> {
    let path = adom_store::default_cache_db_path();
    match adom_debrid::Store::open_cache_db(&path) {
        Ok(store) => {
            eprintln!(
                "[gateway] ledger RD (rdc:v2) lido do cache.db: {}",
                path.display()
            );
            Some(Arc::new(store))
        }
        Err(err) => {
            eprintln!("[gateway] rdc:v2 indisponível ({err}); RD segue unknown");
            None
        }
    }
}

/// Feed de holds do autofetch; sem configuração segura, AllDebrid segue read-only.
pub(super) fn holds_feed() -> Option<Arc<dyn HoldsFeed>> {
    let feed = NodeHoldsFeed::from_env()?;
    eprintln!(
        "[gateway] feed de holds do autofetch: DEBRID_AL_HOLDS=on \
         (/internal/debrid/holds; a limpeza nativa só age com DEBRID_AL_CLEANUP=on)"
    );
    Some(Arc::new(feed))
}
