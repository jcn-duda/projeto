//! Handle do `crawl.db` e acesso fora da thread do runtime.
//!
//! Separado do `loop.rs` pela catraca de 400 linhas: o tick, as tasks do lote e
//! a lane own_pace compartilham o MESMO banco por este tipo.

use std::sync::{Arc, Mutex as StdMutex};

use super::r#loop::MotorError;
use crate::store::ops::{CrawlStore, StoreError};

/// Store compartilhado entre o tick e as tasks: `rusqlite::Connection` é `Send`
/// (não `Sync`), então o `Mutex` padrão é o que permite o `spawn_blocking`.
pub(in crate::motor) type StoreHandle = Arc<StdMutex<Option<CrawlStore>>>;

/// Roda uma operação de SQLite fora da thread do runtime async.
pub(in crate::motor) async fn with_store<T, F>(store: StoreHandle, f: F) -> Result<T, MotorError>
where
    T: Send + 'static,
    F: FnOnce(&CrawlStore) -> Result<T, StoreError> + Send + 'static,
{
    let dentro = tokio::task::spawn_blocking(move || -> Result<T, MotorError> {
        let guard = store
            .lock()
            .map_err(|e| MotorError::StoreError(format!("lock do store: {e}")))?;
        let db = guard
            .as_ref()
            .ok_or_else(|| MotorError::StoreError("crawl.db não está aberto".into()))?;
        f(db).map_err(|e| MotorError::StoreError(e.to_string()))
    })
    .await
    .map_err(|e| MotorError::StoreError(format!("spawn_blocking: {e}")))?;
    dentro
}
