//! Adaptadores de stores/efeitos auxiliares usados pelo builder do orquestrador.

use std::sync::Arc;

use adom_debrid::holds_feed::holds_feed_enabled;
use adom_debrid::HttpClient;
use adom_search::HoldsFeed;

use crate::al_cleanup_facts::NativeHoldsFeed;

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

/// Feed de holds do autofetch, lido do KV do próprio gateway. Sem
/// `DEBRID_AL_HOLDS=on` não há feed e a AllDebrid segue read-only.
pub(super) fn holds_feed() -> Option<Arc<dyn HoldsFeed>> {
    if !holds_feed_enabled() {
        return None;
    }
    let client = HttpClient::new().ok()?;
    eprintln!(
        "[gateway] feed de holds do autofetch: nativo (KV do processo; \
         a limpeza só age com DEBRID_AL_CLEANUP=on)"
    );
    Some(Arc::new(NativeHoldsFeed::new(client)))
}
