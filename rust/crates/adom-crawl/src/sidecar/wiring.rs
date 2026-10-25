//! Composição de PRODUÇÃO da ingestão nativa (T3-L3).
//!
//! A ingestão é montada UMA vez no boot do sidecar (`NativeStore` +
//! `TmdbCatalog` + ponte admin) e injetada no motor com
//! [`CrawlMotor::with_ingest`](crate::motor::CrawlMotor::with_ingest) — nada de
//! abrir banco por página. Sem esta fiação o tick devolve
//! `Skipped("ingest-pendente")` e não reivindica URL nenhuma.
//!
//! As três costuras têm default de produção, mas duas delas dependem de
//! ambiente: sem `TMDB_API_KEY` não há identificação NEM nomes (o `record`
//! falharia em toda página e queimaria `tries`), e sem os bancos nativos não há
//! onde gravar. Nesses casos devolvemos `None` com um log ALTO: o motor fica
//! parado de forma visível, em vez de gastar fila.
//!
//! Nenhum token vai para log — nem o do header da ponte, nem o do sidecar.

use std::sync::Arc;

use crate::ingest::{AdminStreamInvalidator, Ingest, NativeStore, TmdbCatalog};
use crate::motor::PageIngest;

/// Monta o `Ingest` de produção. `None` = falta ambiente para ingerir com
/// segurança (TMDB sem chave ou bancos nativos indisponíveis).
pub fn production_ingest() -> Option<Arc<dyn PageIngest>> {
    let catalog = match TmdbCatalog::from_env() {
        Ok(catalog) => catalog,
        Err(err) => {
            eprintln!(
                "[adom-sidecar] ingestão desligada: cliente TMDB não montou \
                 (TMDB_API_KEY/TMDB_BASE_URL): {err}"
            );
            return None;
        }
    };
    if !catalog.has_api_key() {
        eprintln!(
            "[adom-sidecar] ingestão desligada: TMDB_API_KEY ausente — o tick fica em \
             `ingest-pendente` e nenhuma URL é reivindicada"
        );
        return None;
    }
    let store = match NativeStore::from_env() {
        Ok(store) => store,
        Err(err) => {
            eprintln!(
                "[adom-sidecar] ingestão desligada: bancos nativos indisponíveis \
                 (MAGNET_BANK_DB_PATH/CACHE_DB_PATH/CACHE_PERSIST): {err}"
            );
            return None;
        }
    };
    let invalidator = AdminStreamInvalidator::from_env();
    // Endpoint sem credencial: só o alvo da ponte.
    eprintln!(
        "[adom-sidecar] ingestão ligada: bancos nativos + TMDB, invalidação em {}",
        invalidator.endpoint()
    );
    Some(Arc::new(Ingest::new(store, catalog, invalidator)))
}
