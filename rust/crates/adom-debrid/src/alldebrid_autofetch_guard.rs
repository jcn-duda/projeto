//! Leitura explícita da guarda `adrm` para o futuro worker.
//! Isolada da checagem atual: sem mutação, sem envio e sem fallback em erro.
use std::path::Path;
use std::time::Duration;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use super::ReuploadEvidence;
use crate::alldebrid_cleanup::adrm_key;

/// `Ok(true)` é uma marca viva; `Ok(false)` prova ausência ou expiração.
/// Banco ausente, tabela ilegível, linha malformada e conta/hash vazios
/// devolvem erro: o chamador NÃO pode convertê-lo para marca ausente.
/// A flag operacional é responsabilidade do chamador; esta função sempre lê.
pub fn read_adrm_block(
    path: &Path,
    account: &str,
    hash: &str,
    now_ms: i64,
) -> Result<bool, String> {
    if account.trim().is_empty() || hash.trim().is_empty() {
        return Err("conta ou hash vazio na guarda adrm".into());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("não foi possível abrir guarda adrm: {e}"))?;
    conn.busy_timeout(Duration::from_millis(200))
        .map_err(|e| format!("não foi possível configurar guarda adrm: {e}"))?;
    let expiry: Option<i64> = conn
        .query_row(
            "SELECT expires_at FROM cache WHERE key = ?1",
            params![adrm_key(account, hash)],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("não foi possível consultar guarda adrm: {e}"))?;
    Ok(expiry.is_some_and(|at| at > now_ms))
}

/// Traduz a leitura crua da guarda `adrm` na EVIDÊNCIA que a decisão de
/// enqueue consome. Só traduz fatos: não envia o magnet, não limpa a marca e
/// não faz rede. Erro de leitura vira `Unavailable` — nunca `Clear`, senão
/// um banco indisponível autorizaria o upload que a guarda existe para barrar.
/// `inventory_ready` só é consultado com marca viva: sem marca não há o que
/// liberar, e com marca sem inventário o worker continua bloqueado.
pub fn guard_evidence(
    path: &Path,
    account: &str,
    hash: &str,
    inventory_ready: bool,
    now_ms: i64,
) -> ReuploadEvidence {
    match read_adrm_block(path, account, hash, now_ms) {
        Err(_) => ReuploadEvidence::Unavailable,
        Ok(true) if inventory_ready => ReuploadEvidence::BlockedButInventoryReady,
        Ok(true) => ReuploadEvidence::Blocked,
        Ok(false) => ReuploadEvidence::Clear,
    }
}

#[cfg(test)]
#[path = "alldebrid_autofetch_guard_tests.rs"]
mod tests;
