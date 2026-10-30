//! KV nativo de PRODUÇÃO do adom-debrid: uma conexão por processo sobre o
//! `data/cache.db` compartilhado com o Node e o gateway (tabela `cache`).
//!
//! Compartilhado pelos módulos que gravam direto no KV (`marks_feed` para a
//! posse `adsub`, `file_sizes` para `fsz`/`tsz`). Abrir um segundo `NativeKv`
//! no mesmo arquivo concorre com o `PRAGMA journal_mode = WAL` do schema, por
//! isso a conexão é única e guardada aqui.

use std::path::Path;
use std::sync::OnceLock;

use adom_index::NativeKv;

/// KV de produção, aberto UMA vez por processo.
static KV: OnceLock<NativeKv> = OnceLock::new();

/// Só a abertura BEM-SUCEDIDA fica guardada: uma falha transitória (lock no
/// boot) não pode desligar a gravação pelo resto da vida do processo — a
/// próxima chamada tenta abrir de novo. Falha só loga (fail-open).
pub fn production_kv() -> Option<&'static NativeKv> {
    if let Some(kv) = KV.get() {
        return Some(kv);
    }
    match NativeKv::open(Path::new(&cache_db_path())) {
        Ok(kv) => {
            // Corrida entre dois lotes: o perdedor descarta a própria conexão.
            let _ = KV.set(kv);
            KV.get()
        }
        Err(err) => {
            eprintln!("[debrid] KV nativo indisponível: {err}");
            None
        }
    }
}

/// Mesmo default do processo Node (`data/cache.db`, relativo ao cwd).
#[cfg(not(test))]
fn cache_db_path() -> String {
    std::env::var(crate::alldebrid_cleanup::CACHE_DB_ENV)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| "data/cache.db".to_string())
}

/// Nos testes o KV é sempre um arquivo temporário do processo: o `OnceLock`
/// prende o primeiro caminho aberto, então nenhum teste pode gravar no
/// `data/cache.db` do checkout.
#[cfg(test)]
fn cache_db_path() -> String {
    test_db_path().to_string_lossy().into_owned()
}

/// Arquivo do KV de teste (único por processo).
#[cfg(test)]
pub(crate) fn test_db_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!("adom-marks-test-{}.db", std::process::id()))
}

/// KV de produção do processo, para os testes lerem o que o `spawn` gravou.
/// Reusa a MESMA conexão (ver o cabeçalho do módulo).
#[cfg(test)]
pub(crate) fn test_kv() -> Option<&'static NativeKv> {
    production_kv()
}
