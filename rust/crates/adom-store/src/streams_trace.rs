//! Diagnóstico do namespace streams:v21 (/stream-trace.json): leitura de UMA
//! chave dentro da graça SWR e a varredura da obra para escolher a entrada
//! mais recente pelo ledger (finishedAt, senão startedAt).

use adom_search::StreamsEntry;
use rusqlite::{params, Connection};

use super::{decode_entry, read_row, streams_prefix, StreamsStore};

/// Entrada lida PARA DIAGNÓSTICO (`/stream-trace.json`): o valor, se está na
/// graça e o TTL restante em segundos. A `key` é a da linha que venceu — o
/// recompute do trace (`/streams/trace`) dela extrai a instalação (shape +
/// escopo da conta), que o valor em si não carrega.
#[derive(Debug, Clone, PartialEq)]
pub struct TraceHit {
    pub value: StreamsEntry,
    pub stale: bool,
    /// Segundos até o TTL vencer (`0` quando já venceu e está na graça).
    pub remaining_s: u64,
    /// Chave do cache que produziu este hit (a exata pedida ou a mais recente
    /// da obra achada pela varredura).
    pub key: String,
}

impl StreamsStore {
    /// Entrada de UMA chave para o `/stream-trace.json` (admin): `None` além da
    /// graça SWR (e apaga, como o `getWithStale` do Node).
    pub fn trace_entry(
        &self,
        key: &str,
        grace_seconds: u64,
        now_ms: u64,
    ) -> Result<Option<TraceHit>, String> {
        let conn = self.lock();
        trace_hit(&conn, key, grace_seconds, now_ms)
    }

    /// Entrada mais RECENTE da obra em qualquer escopo (a leitura do painel sem
    /// segmento): varre o prefixo `<tipo>:<id>:` e escolhe pelo `finishedAt`
    /// (senão `startedAt`) do ledger — o mesmo critério do
    /// `/stream-trace.json` do Node quando a chave exata não existe.
    pub fn latest_trace(
        &self,
        kind: &str,
        id: &str,
        grace_seconds: u64,
        now_ms: u64,
    ) -> Result<Option<TraceHit>, String> {
        let prefix = format!("{}{}:{}:", streams_prefix(), kind, id);
        let conn = self.lock();
        let mut stmt = conn
            .prepare("SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1")
            .map_err(|err| err.to_string())?;
        let keys: Vec<String> = stmt
            .query_map(params![prefix], |row| row.get::<_, String>(0))
            .map_err(|err| err.to_string())?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        let mut best: Option<(f64, TraceHit)> = None;
        for key in keys {
            let Some(hit) = trace_hit(&conn, &key, grace_seconds, now_ms)? else {
                continue;
            };
            let at = trace_at(&hit.value);
            if best.as_ref().is_none_or(|(best_at, _)| at >= *best_at) {
                best = Some((at, hit));
            }
        }
        Ok(best.map(|(_, hit)| hit))
    }
}

fn trace_hit(
    conn: &Connection,
    key: &str,
    grace_seconds: u64,
    now_ms: u64,
) -> Result<Option<TraceHit>, String> {
    let Some((value, expires_at)) = read_row(conn, key)? else {
        return Ok(None);
    };
    let expires_at = expires_at as u64;
    let stale = now_ms > expires_at;
    if stale && now_ms > expires_at.saturating_add(grace_seconds.saturating_mul(1000)) {
        // Fora da graça: mesma poda do `getWithStale` (o diagnóstico não
        // ressuscita entrada que a busca não serviria).
        conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map_err(|err| err.to_string())?;
        return Ok(None);
    }
    Ok(Some(TraceHit {
        value: decode_entry(&value)?,
        stale,
        remaining_s: if stale {
            0
        } else {
            expires_at.saturating_sub(now_ms) / 1000
        },
        key: key.to_string(),
    }))
}

/// `at` do ledger: `finishedAt`, senão `startedAt`, senão 0 (mesma ordenação do
/// cruzamento de escopos do Node).
fn trace_at(entry: &StreamsEntry) -> f64 {
    let trace = entry.trace.as_ref();
    let at = |field: &str| trace.and_then(|t| t.get(field)).and_then(|v| v.as_f64());
    at("finishedAt").or_else(|| at("startedAt")).unwrap_or(0.0)
}
