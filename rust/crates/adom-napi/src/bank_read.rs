//! Leituras do banco de magnets vivo (`data/magnets.db`) para o Node.
//!
//! O gateway Rust é o ÚNICO escritor do acervo; daqui sai só a LEITURA direta
//! que o Node ainda precisa no caminho do play e do índice: `bankLookupUri`
//! (porte do `lookup` de `magnet-bank-read.ts`) e `bankRowsForMediaSource`
//! (linhas planas do acervo que o `record` do índice consome).
//!
//! Conexão POR CHAMADA: não há handle global. O caller passa o caminho do
//! banco (o `config.magnetBank.dbPath` do Node) e o store abre, lê e é
//! descartado; sem argumento vale a resolução `MAGNET_BANK_DB_PATH` →
//! `data/magnets.db` do próprio store (`from_env`). Erro de SQLite é `Err` —
//! quem chama no TS é fail-open e devolve null/vazio sem derrubar o play.

use std::path::Path;

use adom_store::MagnetBankStore;
use napi::Error;
use napi_derive::napi;

use crate::release_index_media::BankRowNapi;

fn erro(err: String) -> Error {
    Error::from_reason(err)
}

/// Abre o banco POR CHAMADA. Caminho vazio/ausente cai no `from_env` (a mesma
/// resolução do store que o gateway usa em produção).
fn open_bank(db_path: Option<String>) -> Result<MagnetBankStore, String> {
    match db_path.filter(|raw| !raw.trim().is_empty()) {
        Some(path) => MagnetBankStore::open(Path::new(&path)),
        None => MagnetBankStore::from_env(),
    }
}

// A linha do acervo é o MESMO `BankRowNapi` (`release_index_media.rs`) que o
// merge já recebe — reexportado pelo glob de `lib.rs`, não há tipo novo na
// superfície napi.
/// URI gravada do magnet por hash (`None` = hash fora do banco). Porte fiel do
/// `lookup` do TS: PK em minúsculas e a URI sai TAL COMO foi gravada — o
/// dn/tracker rico já foi resolvido no WRITE do gateway.
#[napi(catch_unwind)]
pub fn bank_lookup_uri(
    db_path: Option<String>,
    hash: String,
    now_ms: i64,
) -> napi::Result<Option<String>> {
    open_bank(db_path)
        .and_then(|store| store.bank_lookup_uri(&hash, now_ms))
        .map_err(erro)
}

/// Linhas do acervo por hash (`bankRowsForMediaSource` do TS): o que ainda não
/// tem dn= no item é buscado aqui, em lote, para o merge do índice.
#[napi(catch_unwind)]
pub fn bank_rows_for_media_source(
    db_path: Option<String>,
    hashes: Vec<String>,
) -> napi::Result<Vec<BankRowNapi>> {
    let rows = open_bank(db_path)
        .and_then(|store| store.bank_rows_many(&hashes))
        .map_err(erro)?;
    Ok(rows
        .into_iter()
        .map(|row| BankRowNapi {
            hash: row.hash,
            uri: row.uri,
            title: row.title,
        })
        .collect())
}
