//! Lista de arquivos (`fsz`) dos itens EM CACHE na Premiumize que o build
//! pediu (`want_files`: pack de coleção, pack de temporada, item sem 💾 ou sem
//! resolução), lida em fundo por `/transfer/directdl`.
//!
//! O `/cache/check` só diz sim/não e o total do torrent (`tsz`): sem a lista,
//! o pack de coleção mostrava o tamanho da coleção inteira (22 GB) em vez do
//! filme pedido. O Node fazia isso (`premiumize-files.ts`, 2 por checagem) e a
//! peça se perdeu quando a checagem virou nativa. Conferido em produção na
//! época: o `directdl` de item em cache não cria transferência na conta.
//!
//! A resposta da busca nunca espera: a lista vale a partir da próxima.

use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use adom_core::DebridFile;

use crate::file_sizes;
use crate::http::HttpClient;
use crate::premiumize::{ContentFile, Premiumize, FILE_LIST_CAP};
use crate::verdict::verdict_files::{pack_files_max_from_env, wanted_hashes};

/// Hashes com leitura em voo: duas buscas seguidas da mesma obra não pedem a
/// mesma lista duas vezes.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// Teto por checagem: o da Premiumize (2), limitado pelo
/// `DEBRID_PACK_FILES_PER_CHECK` (`0` desliga a leitura).
fn reads_max() -> usize {
    FILE_LIST_CAP.min(pack_files_max_from_env())
}

/// Escolhe os hashes (em cache E pedidos, fora dos que já estão em voo) e
/// agenda a leitura. Sem runtime tokio ou sem nada a ler, não faz nada.
pub(crate) fn spawn_reads(
    client: HttpClient,
    api_key: &str,
    cached: &[String],
    file_hashes: &[String],
    timeout: Option<Duration>,
) {
    let wanted = wanted_hashes(file_hashes);
    if wanted.is_empty() {
        return;
    }
    let reads = {
        let Ok(mut flying) = IN_FLIGHT.lock() else {
            return;
        };
        let picked = Premiumize::select_file_list_hashes(
            cached,
            &wanted,
            &HashSet::new(),
            &flying,
            reads_max(),
        );
        flying.extend(picked.iter().cloned());
        picked
    };
    if reads.is_empty() {
        return;
    }
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        release(&reads);
        return;
    };
    let key = api_key.to_string();
    handle.spawn(async move {
        let pm = Premiumize::new(client);
        let mut rows = Vec::new();
        for hash in &reads {
            match pm.file_list(&key, hash, timeout, None).await {
                Ok(files) => {
                    let files = content_to_debrid(files);
                    if files.is_empty() {
                        eprintln!("[premiumize] {hash} sem arquivos para gravar");
                    } else {
                        rows.push((hash.clone(), files));
                    }
                }
                Err(err) => {
                    eprintln!("[premiumize] lista de arquivos de {hash} falhou: {}", err.message());
                }
            }
        }
        release(&reads);
        file_sizes::spawn_record(rows, Vec::new());
    });
}

fn release(hashes: &[String]) {
    if let Ok(mut flying) = IN_FLIGHT.lock() {
        for hash in hashes {
            flying.remove(hash);
        }
    }
}

/// `content[]` do `directdl` para o formato da gravação `fsz`. Vídeo, amostra
/// e anúncio ficam a cargo de `file_sizes::record_files`.
pub(crate) fn content_to_debrid(files: Vec<ContentFile>) -> Vec<DebridFile> {
    files
        .into_iter()
        .filter(|file| !file.path.is_empty() && file.size > 0)
        .map(|file| DebridFile {
            path: file.path,
            size: file.size as f64,
        })
        .collect()
}

#[cfg(test)]
#[path = "premiumize_files_tests.rs"]
mod tests;
