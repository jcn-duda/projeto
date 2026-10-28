//! Boot do worker nativo: abre o `cache.db`, monta a fábrica de produção e
//! devolve o handle.
//!
//! # Ordem e dono do handle
//!
//! `proxy::run` chama `autofetch::spawn()` ANTES do orquestrador porque o tail
//! é construído junto com ele. O handle devolvido é UM só (`Clone` sobre
//! `Arc<Inner>`): o clone vai para o tail (`NativeWorkQueue`) e o original para
//! a admin `127.0.0.1:8711`. Nada aqui cria um segundo ciclo.
//!
//! # Trava
//!
//! Sem `AUTOFETCH_WORKER=on` este módulo abre o KV e para: nenhuma fábrica,
//! nenhum cliente HTTP, `phase: "prepared"`. Com a trava, a fábrica cobre os
//! cinco serviços e o gate RD nasce UMA vez (ver [`super::build`]).

use std::path::Path;
use std::sync::{Arc, OnceLock};

use adom_index::NativeKv;

use super::build::Build;
use super::ports::DebridFactory;
use super::vault::Vault;
use super::worker::AutofetchHandle;
use super::{worker_enabled, Policy};

/// Abre o `cache.db` do processo. `None` = sem controle: worker ausente.
pub(crate) fn open_kv(path: &Path) -> Option<Arc<NativeKv>> {
    match NativeKv::open(path) {
        Ok(kv) => Some(Arc::new(kv)),
        Err(err) => {
            eprintln!(
                "[autofetch] controle indisponível ({}): {err}; worker permanece ausente",
                path.display()
            );
            None
        }
    }
}

/// Fábrica de produção. Só existe com a trava ligada E o cofre do processo:
/// sem `AUTOFETCH_WORKER=on` o boot fica idêntico ao de antes do flip.
pub(crate) fn production_factory(
    kv: &Arc<NativeKv>,
    cache_db: &Path,
    vault: Option<&Arc<Vault>>,
) -> Option<DebridFactory> {
    if !worker_enabled() {
        return None;
    }
    let Some(vault) = vault else {
        eprintln!("[autofetch] sem cofre do processo; worker fica prepared");
        return None;
    };
    let build = Arc::new(Build::new(Arc::clone(kv), cache_db)?);
    eprintln!("[autofetch] fábrica de produção ligada (5 serviços; gate RD único)");
    Some(build.factory(Arc::clone(vault)))
}

/// Porta de invalidação do Preenchimento de temporada: o `cache.forgetMany` do
/// Node é o `StreamsStore` do `streams.db` — OUTRO SQLite (o KV do worker é o
/// `cache.db`), com WAL e `busy_timeout` no schema, então a conexão do worker
/// convive com a do orquestrador.
///
/// Abre na PRIMEIRA invalidação: boot sem pack pronto não paga `quick_check`, e
/// nenhum teste toca disco (o sink só existe com o worker ligado).
pub(crate) fn streams_sink() -> super::season_fill::SeasonFillSink {
    let store: Arc<OnceLock<Option<Arc<adom_store::StreamsStore>>>> = Arc::new(OnceLock::new());
    Arc::new(move |keys: &[String]| {
        let store = store.get_or_init(|| {
            let path = crate::stream::streams_db_path();
            match adom_store::StreamsStore::open(&path) {
                Ok(store) => Some(Arc::new(store)),
                Err(err) => {
                    eprintln!(
                        "[autofetch] streams.db indisponível ({}): {err}; pack pronto não invalidou",
                        path.display()
                    );
                    None
                }
            }
        });
        let Some(store) = store else {
            // `Err` mantém o índice vivo: a passagem seguinte tenta de novo.
            return Err("streams.db indisponível".to_string());
        };
        for key in keys {
            store.forget(key)?;
        }
        Ok(())
    })
}

/// Boot com injeção: `Some(factory)` = fábrica pronta (teste/leva futura),
/// `None` = monta a de produção quando a trava está ligada.
pub(crate) fn spawn_at(
    cache_db: &Path,
    vault: Option<Arc<Vault>>,
    debrid: Option<DebridFactory>,
) -> Option<AutofetchHandle> {
    let kv = open_kv(cache_db)?;
    let debrid = match debrid {
        Some(factory) => Some(factory),
        None => production_factory(&kv, cache_db, vault.as_ref()),
    };
    // A represa (`autofetch:v3:sup:`) drena com a MESMA fábrica do laço: sem
    // este registro `POST /autofetch/suppressed-drain` e o dreno da passagem
    // respondem `factory-unavailable` e o Node segue dono do passo.
    if let Some(factory) = debrid.as_ref() {
        super::suppressed_step::register_factory(factory.clone());
    }
    // Preenchimento de temporada: o cache a invalidar é o `streams.db`, não o KV
    // do worker — a porta é registrada UMA vez, aqui.
    super::season_fill::register(streams_sink());
    // Registro do aceite do Chupim no índice (`source:autofetch`): escritor
    // PRÓPRIO (canal + thread), fora do caminho da resposta. Índice desligado
    // (`RELEASE_INDEX=false`/TTL 0) devolve `None` e o aceite não grava nada.
    if let Some(sink) = super::index_record::spawn(cache_db) {
        super::index_record::register(sink);
    }
    Some(AutofetchHandle::build(
        kv,
        &Policy::from_env(),
        vault,
        debrid,
    ))
}

#[cfg(test)]
#[path = "boot_tests.rs"]
mod tests;
