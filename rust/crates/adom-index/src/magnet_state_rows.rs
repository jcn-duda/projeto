//! Helpers de linha do `mag:v1` sobre uma conexão já travada: leitura com
//! precedência, marca viva, upsert e remoção. Saíram de `magnet_state.rs` só
//! pelo teto de 400 linhas; o caminho público continua `crate::magnet_state::*`.

use rusqlite::{params, Connection, OptionalExtension};

use super::{magnet_key, MagnetState, MARK_VALUE};

pub(super) fn state_in(
    conn: &Connection,
    adapter: &str,
    api_key: &str,
    hash: &str,
    now_ms: i64,
) -> Result<Option<MagnetState>, String> {
    // Ordem = precedência: a evidência mais específica manda.
    for state in [MagnetState::Bad, MagnetState::Lie, MagnetState::Alive] {
        let key = magnet_key(state.field(), adapter, api_key, hash);
        if live_flag(conn, &key, now_ms)? {
            return Ok(Some(state));
        }
    }
    Ok(None)
}

/// A chave existe e o valor diz "marca". Vencida NÃO é apagada aqui: quem
/// apaga e contabiliza é o `sweep`. Apagar na leitura sumia com a linha sem
/// baixa no agregado durável do Node (o decremento só existe nos `counts` da
/// poda) — o contador ficava inflado para sempre, e a leitura mais banal
/// (`state`) bastava para criar o vazamento.
pub(super) fn live_flag(conn: &Connection, key: &str, now_ms: i64) -> Result<bool, String> {
    let Some((raw, expires_at)) = read_row(conn, key)? else {
        return Ok(false);
    };
    if is_expired(expires_at, now_ms) {
        return Ok(false);
    }
    Ok(is_mark_value(&raw))
}

/// Aceita o `"1"` gravado por nós e o `"true"`/`1` crus de escritas antigas.
pub(crate) fn is_mark_value(raw: &str) -> bool {
    let value = raw.trim();
    value == "1" || value.eq_ignore_ascii_case("true")
}

/// `ttl <= 0` = janela desligada: NÃO grava (mesmo contrato do `cache.setMany`).
pub(super) fn expires_at_for(ttl_seconds: i64, now_ms: i64) -> Option<i64> {
    if ttl_seconds <= 0 {
        return None;
    }
    Some(now_ms.saturating_add(ttl_seconds.saturating_mul(1_000)))
}

/// `expires_at = 0`/ausente = sem expiração; positivo e vencido = expirado.
pub(crate) fn is_expired(expires_at: Option<i64>, now_ms: i64) -> bool {
    matches!(expires_at, Some(ts) if ts > 0 && ts <= now_ms)
}

pub(super) fn upsert(conn: &Connection, key: &str, expires_at: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
        params![key, MARK_VALUE, expires_at],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn forget(conn: &Connection, key: &str) -> Result<usize, String> {
    conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
        .map_err(|err| err.to_string())
}

pub(super) fn row_exists(conn: &Connection, key: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare("SELECT 1 FROM cache WHERE key = ?1")
        .map_err(|err| err.to_string())?;
    let found = stmt
        .query_row(params![key], |row| row.get::<_, i64>(0))
        .optional()
        .map_err(|err| err.to_string())?;
    Ok(found.is_some())
}

pub(crate) fn read_row(
    conn: &Connection,
    key: &str,
) -> Result<Option<(String, Option<i64>)>, String> {
    let mut stmt = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| err.to_string())?;
    stmt.query_row(params![key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
    })
    .optional()
    .map_err(|err| err.to_string())
}
