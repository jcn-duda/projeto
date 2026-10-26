//! Geração por obra e escrita com fence (T1-C1).
//!
//! A outbox (T1-B2) propaga a invalidação, mas uma busca que **começou antes**
//! da invalidação pode gravar a lista velha depois dela. A fence fecha esse
//! intervalo: o orquestrador captura [`Fence`] antes de coletar e grava com
//! [`StreamsStore::set_fenced`], que descarta a escrita quando a invalidação já
//! passou.
//!
//! Os contadores moram em `streams_meta`, FORA da tabela `cache`, para o
//! `clear_all` não apagar o próprio contador que ele incrementa.

use adom_search::StreamsEntry;
use rusqlite::{params, Connection, OptionalExtension};

use crate::streams::{enforce_quota, is_imdb_id, is_streams_key, streams_prefix, StreamsStore};

/// Chave do contador global (limpeza de instalação, hash, sufixo).
pub const EPOCH_KEY: &str = "gen:epoch";

/// Gerações observadas por uma busca antes de coletar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Fence {
    /// Geração da obra (tipo + imdbId) da chave.
    pub obra: u64,
    /// Geração global, andada por toda limpeza (`clear_all`, hash, sufixo).
    pub epoch: u64,
}

/// Contador de obra da chave de cache (`gen:obra:<tipo>:<tt…>`).
///
/// A geração é por **tipo + imdbId**, não por chave inteira: o escopo (config
/// serializada + conta) fica no fim da chave e muda a cada instalação, então
/// incluí-lo partiria a mesma obra em contadores que a invalidação não alcança.
/// Fora do formato (`movie`/`series` + `tt…`) → `None`: não há geração a andar.
pub(crate) fn gen_key_for(cache_key: &str) -> Option<String> {
    let rest = cache_key.strip_prefix(streams_prefix())?;
    let (kind, after) = rest.split_once(':')?;
    if kind != "movie" && kind != "series" {
        return None;
    }
    let id = after.split(':').next()?;
    is_imdb_id(id).then(|| format!("gen:obra:{kind}:{id}"))
}

fn bump(conn: &Connection, key: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO streams_meta (key, value) VALUES (?1, 1)
         ON CONFLICT(key) DO UPDATE SET value = value + 1",
        params![key],
    )
    .map_err(|err| format!("geração {key}: {err}"))?;
    Ok(())
}

fn read_value(conn: &Connection, key: &str) -> Result<u64, String> {
    let raw: Option<i64> = conn
        .query_row(
            "SELECT value FROM streams_meta WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("ler geração {key}: {err}"))?;
    Ok(raw.unwrap_or(0).max(0) as u64)
}

/// Incrementa os contadores das DUAS formas da obra (filme e série).
///
/// `invalidate_for_obra` recebe só o imdbId: o tipo não está no chamador e a
/// chave pode **ainda não existir** — é justamente a busca em voo que vai
/// criá-la. Andar as duas gerações é o único caminho fail-safe; o custo é
/// descartar uma escrita do outro tipo da mesma obra, que apenas refaz a busca.
pub(crate) fn bump_obra(conn: &Connection, imdb_id: &str) -> Result<(), String> {
    bump(conn, &format!("gen:obra:movie:{imdb_id}"))?;
    bump(conn, &format!("gen:obra:series:{imdb_id}"))
}

/// Incrementa o epoch global (toda limpeza que não é de uma obra só).
pub(crate) fn bump_epoch(conn: &Connection) -> Result<(), String> {
    bump(conn, EPOCH_KEY)
}

fn read(conn: &Connection, cache_key: &str) -> Result<Fence, String> {
    let obra = match gen_key_for(cache_key) {
        Some(key) => read_value(conn, &key)?,
        None => 0,
    };
    Ok(Fence {
        obra,
        epoch: read_value(conn, EPOCH_KEY)?,
    })
}

impl StreamsStore {
    /// Geração corrente da obra da chave — capturada ANTES de coletar.
    pub fn fence_for_key(&self, key: &str) -> Result<Fence, String> {
        read(&self.lock(), key)
    }

    /// Grava só se a [`Fence`] capturada antes da busca ainda vale.
    ///
    /// `Ok(false)` = uma invalidação passou no meio; a escrita é descartada
    /// **sem gravar** (a transação cai no rollback do drop). Erro continua sendo
    /// erro: I/O e corrupção não podem virar "lista velha" silenciosa.
    pub fn set_fenced(
        &self,
        key: &str,
        value: &StreamsEntry,
        ttl_seconds: u64,
        now_ms: u64,
        fence: &Fence,
    ) -> Result<bool, String> {
        if !is_streams_key(key) {
            return Err(format!(
                "chave fora do namespace streams: {key} (esperado prefixo {})",
                streams_prefix()
            ));
        }
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let atual = read(&tx, key)?;
        if fence.epoch < atual.epoch || fence.obra < atual.obra {
            return Ok(false);
        }
        let expires_at = now_ms.saturating_add(ttl_seconds.saturating_mul(1000)) as i64;
        let encoded = serde_json::to_string(value).map_err(|err| err.to_string())?;
        tx.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
            params![key, encoded, expires_at],
        )
        .map_err(|err| err.to_string())?;
        enforce_quota(&tx, streams_prefix(), self.quota(), now_ms as i64)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(true)
    }
}

#[cfg(test)]
#[path = "streams_fence_tests.rs"]
mod tests;
