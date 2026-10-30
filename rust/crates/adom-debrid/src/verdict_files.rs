//! Leitura da lista de arquivos (`fsz`) dos magnets PRONTOS pedidos pelo build,
//! em fundo, ANTES da limpeza da AllDebrid.
//!
//! Por que a ordem importa: a limpeza apaga o magnet pronto, e depois disso o
//! `/magnet/status` dele deixa de responder — a árvore precisa ser lida antes.
//! Por isso é UMA task só: lê (no máximo 3 em paralelo) e só então roda o
//! `CleanupPlan`. A resposta da busca nunca espera essa task.
//!
//! Falha de leitura é por magnet: um erro ou prazo estourado só loga e não
//! derruba os outros. Sem nada para ler e sem plano, nada é agendado.

use std::collections::HashSet;
use std::time::Duration;

use adom_core::DebridFile;
use tokio::task::JoinSet;

use crate::alldebrid::{AllDebrid, SweepFile, CHECK_TIMEOUT};
use crate::alldebrid_cleanup::CleanupPlan;
use crate::file_sizes;

/// Default de `DEBRID_PACK_FILES_PER_CHECK` (o mesmo do TS).
const DEFAULT_PACK_FILES_PER_CHECK: usize = 6;

/// Leituras simultâneas: o `/magnet/status` da conta é compartilhado com o
/// resto do debrid e o teto de 3 é o que o Node já usava.
const READ_PARALLEL: usize = 3;

/// Teto de magnets lidos por checagem. `0` desliga; valor inválido cai no
/// default em vez de ligar a leitura por engano.
pub(crate) fn pack_files_max_from_env() -> usize {
    std::env::var("DEBRID_PACK_FILES_PER_CHECK")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_PACK_FILES_PER_CHECK)
}

/// Hashes pedidos em minúsculas e sem vazios: é a forma que o `fold` compara.
pub(crate) fn wanted_hashes(file_hashes: &[String]) -> HashSet<String> {
    file_hashes
        .iter()
        .map(|hash| hash.trim().to_lowercase())
        .filter(|hash| !hash.is_empty())
        .collect()
}

/// `SweepFile` (árvore do magnet) para o formato da gravação `fsz`. Descarta
/// caminho vazio e tamanho não finito ou não positivo; o que é vídeo, amostra
/// ou anúncio fica a cargo de `file_sizes::record_files`, que é quem grava.
pub(crate) fn sweep_files_to_debrid(files: Vec<SweepFile>) -> Vec<DebridFile> {
    files
        .into_iter()
        .filter(|file| !file.path.is_empty() && file.size.is_finite() && file.size > 0.0)
        .map(|file| DebridFile {
            path: file.path,
            size: file.size,
        })
        .collect()
}

/// Agenda, em UMA task de fundo: leitura dos magnets pedidos e, depois, o plano
/// de limpeza. Não agenda nada quando não há leitura nem plano (comportamento
/// idêntico ao de antes). Sem runtime tokio, descarta e loga.
pub(crate) fn spawn_reads_then_cleanup(
    ad: &AllDebrid,
    api_key: &str,
    reads: Vec<(String, String)>,
    plan: Option<CleanupPlan>,
    timeout: Option<Duration>,
) {
    let plan = plan.filter(|plan| !plan.is_empty());
    if reads.is_empty() && plan.is_none() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        eprintln!("[alldebrid] leitura/limpeza nativa sem runtime; plano descartado");
        return;
    };
    let ad = ad.clone();
    let key = api_key.to_string();
    // Prazo próprio por leitura: o mesmo da checagem; o `call` interno já tem
    // o seu (`CALL_TIMEOUT`), e o menor dos dois vence.
    let limit = timeout.unwrap_or(CHECK_TIMEOUT);
    handle.spawn(async move {
        let rows = read_all(&ad, &key, &reads, limit).await;
        // Gravação em `spawn_blocking` (SQLite síncrono), fail-open.
        file_sizes::spawn_record(rows, Vec::new());
        if let Some(plan) = plan {
            let _ = plan.run(&ad, &key).await;
        }
    });
}

/// Lê as árvores em grupos de [`READ_PARALLEL`]. Cada grupo espera o anterior,
/// então nunca há mais de 3 chamadas ao mesmo tempo.
async fn read_all(
    ad: &AllDebrid,
    key: &str,
    reads: &[(String, String)],
    limit: Duration,
) -> Vec<(String, Vec<DebridFile>)> {
    let mut rows = Vec::new();
    for group in reads.chunks(READ_PARALLEL) {
        let mut set = JoinSet::new();
        for (hash, id) in group.iter().cloned() {
            let ad = ad.clone();
            let key = key.to_string();
            set.spawn(async move {
                let read = read_one(&ad, &key, &id, limit).await;
                (hash, id, read)
            });
        }
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((hash, _, Ok(files))) if !files.is_empty() => rows.push((hash, files)),
                Ok((_, id, Ok(_))) => {
                    eprintln!("[alldebrid] magnet {id} sem arquivos de vídeo para gravar");
                }
                Ok((_, id, Err(err))) => {
                    eprintln!("[alldebrid] leitura de arquivos do magnet {id} falhou: {err}");
                }
                Err(_) => eprintln!("[alldebrid] leitura de arquivos abortou"),
            }
        }
    }
    rows
}

async fn read_one(
    ad: &AllDebrid,
    key: &str,
    id: &str,
    limit: Duration,
) -> Result<Vec<DebridFile>, String> {
    match tokio::time::timeout(limit, ad.sweep_magnet_files(key, id)).await {
        Ok(Ok(files)) => Ok(sweep_files_to_debrid(files)),
        Ok(Err(err)) => Err(err.message().to_string()),
        Err(_) => Err("prazo estourado".to_string()),
    }
}

#[cfg(test)]
#[path = "verdict_files_tests.rs"]
mod verdict_files_tests;
