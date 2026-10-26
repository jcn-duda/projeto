//! `davail:v1` — disponibilidade ⚡ por hash, escopada por adapter e conta.
//!
//! Mesma tabela `cache` do `data/cache.db` (schema e expiração do [`kv`]), mas
//! com uma chave própria: `davail:v1:<adapter>:<accountScope(apiKey)>:<hash>`.
//! O escopo de conta é o mesmo do `magnet_db::mark_key` — sem ele o ⚡ medido
//! numa conta apareceria na lista de outra: a mentira mais cara do addon.
//!
//! O valor é sempre **evidência medida**, nunca inferência: `1` = o debrid
//! confirmou que o hash está pronto, `0` = o serviço (ou o play) acabou de
//! provar que não está. Positivo e negativo têm TTLs próprios (`availPosTtl` /
//! `availNegTtl` no TS) e `ttl <= 0` **desliga** a janela: nada é gravado — o
//! mesmo contrato do `cache.setMany` do Node (`DEBRID_AVAIL_NEG_TTL=0` é a
//! forma documentada de o negativo sempre voltar à rede). `expires_at = 0`
//! também não sobrevive ao boot do Node, que o apaga junto com os vencidos
//! (`DELETE FROM cache WHERE expires_at <= now`), então "permanente" nem
//! existiria de fato.
//!
//! Hash vazio não é chave: `put`/`put_many` recusam e `get`/`get_many`
//! respondem ausência, como o `!infoHash` do `noteAvailable`/`noteUnavailable`
//! do TS. Só `is_empty` — espaço conta como hash, igual ao teste falsy do TS.
//!
//! Leitura tolerante: o Node gravava `1`/`0` (saída de `JSON.stringify`), mas
//! chave antiga pode ter `true`/`false` cru. Valor que não é nenhum dos dois é
//! tratado como ausente — ausência faz o chamador perguntar ao debrid, enquanto
//! adivinhar pintaria ⚡ falso.
//!
//! Desde a T2-L5b o namespace é do Rust ponta a ponta: o Node não carrega nem
//! poda mais estas linhas, então `clear` (esvaziar) e `sweep` (vencidas + teto
//! por ordem de escrita) são daqui. Sem eles o namespace cresceria para sempre.
//!
//! [`kv`]: crate::kv

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use adom_core::{account_scope, prefix};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
";

/// Teto de hashes por `get_many`: uma consulta por hash sob o MESMO lock, então
/// a chamada é limitada em vez de paginada. Hash que passa do teto fica sem
/// veredito — o chamador volta a perguntar ao debrid (erro para o lado seguro).
const MAX_HASHES_PER_CALL: usize = 200;

const UPSERT: &str = "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at";

/// `davail:v1:<adapter>:<accountScope(api_key)>:<hash>` — hash em minúsculas.
pub fn davail_key(adapter: &str, api_key: &str, hash: &str) -> String {
    format!(
        "{}{}:{}:{}",
        prefix("davail"),
        adapter,
        account(api_key),
        hash.to_ascii_lowercase()
    )
}

/// Veredito de um hash presente e vivo no lote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DavailAnswer {
    pub hash: String,
    pub cached: bool,
}

/// O que a varredura removeu do `davail:v1`. Sem contagem por lado: cada linha
/// é o veredito de um hash, não uma marca com lado.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DavailSweep {
    pub expired: u32,
    pub evicted: u32,
}

/// Estado `davail:v1` no `cache.db` compartilhado com o Node e o gateway.
pub struct DavailStore {
    conn: Mutex<Connection>,
}

impl DavailStore {
    /// Abre (ou cria) o `cache.db` em `path`, criando a pasta pai.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do cache.db: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir cache.db: {err}"))?;
        Self::from_conn(conn)
    }

    /// Banco efêmero (testes).
    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        Self::from_conn(conn)
    }

    fn from_conn(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema do cache.db: {err}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Grava o veredito de um hash. Sem adapter ou sem chave não há conta, hash
    /// vazio não é chave e `ttl <= 0` desliga a janela: nos três casos não grava
    /// nada (`Ok`), como o `noteAvailable`/`noteUnavailable` do TS.
    pub fn put(
        &self,
        adapter: &str,
        api_key: &str,
        hash: &str,
        cached: bool,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<(), String> {
        let Some(head) = key_head(adapter, api_key) else {
            return Ok(());
        };
        if hash.is_empty() {
            return Ok(());
        }
        let Some(expires_at) = expires_at_for(ttl_seconds, now_ms) else {
            return Ok(());
        };
        let key = format!("{head}{}", hash.to_ascii_lowercase());
        let conn = self.lock();
        conn.execute(UPSERT, params![key, flag_value(cached), expires_at])
            .map_err(|err| err.to_string())?;
        Ok(())
    }

    /// Lote em UMA transação: `entries` = `(hash, cached, ttl_seconds)`. Cada
    /// entrada leva o próprio TTL (positivo e negativo não compartilham janela)
    /// e é julgada sozinha: hash vazio ou `ttl <= 0` é pulado sem impedir as
    /// outras de gravar.
    pub fn put_many(
        &self,
        adapter: &str,
        api_key: &str,
        entries: &[(String, bool, i64)],
        now_ms: i64,
    ) -> Result<(), String> {
        let Some(head) = key_head(adapter, api_key) else {
            return Ok(());
        };
        if entries.is_empty() {
            return Ok(());
        }
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| format!("transação do davail: {err}"))?;
        {
            let mut stmt = tx
                .prepare(UPSERT)
                .map_err(|err| format!("preparar gravação do davail: {err}"))?;
            for (hash, cached, ttl_seconds) in entries {
                if hash.is_empty() {
                    continue;
                }
                let Some(expires_at) = expires_at_for(*ttl_seconds, now_ms) else {
                    continue;
                };
                stmt.execute(params![
                    format!("{head}{}", hash.to_ascii_lowercase()),
                    flag_value(*cached),
                    expires_at
                ])
                .map_err(|err| format!("gravar davail: {err}"))?;
            }
        }
        tx.commit()
            .map_err(|err| format!("commit do davail: {err}"))?;
        Ok(())
    }

    /// Leitura dura: expirado é apagado da tabela e vira `None`.
    pub fn get(
        &self,
        adapter: &str,
        api_key: &str,
        hash: &str,
        now_ms: i64,
    ) -> Result<Option<bool>, String> {
        if adapter.is_empty() || api_key.is_empty() || hash.is_empty() {
            return Ok(None);
        }
        let key = davail_key(adapter, api_key, hash);
        let conn = self.lock();
        read_one(&conn, &key, now_ms)
    }

    /// Só os hashes PRESENTES e vivos, na ordem da entrada; desconhecido ou
    /// expirado não aparece. Limitado a [`MAX_HASHES_PER_CALL`].
    pub fn get_many(
        &self,
        adapter: &str,
        api_key: &str,
        hashes: &[String],
        now_ms: i64,
    ) -> Result<Vec<DavailAnswer>, String> {
        let Some(head) = key_head(adapter, api_key) else {
            return Ok(Vec::new());
        };
        let conn = self.lock();
        let mut answers = Vec::new();
        // Hash vazio é recusado ANTES do teto: entrada sem chave não pode
        // consumir vaga de quem tem veredito para ler.
        for hash in hashes
            .iter()
            .filter(|hash| !hash.is_empty())
            .take(MAX_HASHES_PER_CALL)
        {
            let key = format!("{head}{}", hash.to_ascii_lowercase());
            if let Some(cached) = read_one(&conn, &key, now_ms)? {
                answers.push(DavailAnswer {
                    hash: hash.to_ascii_lowercase(),
                    cached,
                });
            }
        }
        Ok(answers)
    }

    /// Esvazia o namespace inteiro (`davail:v1:%`) e devolve quantas linhas
    /// saíram.
    pub fn clear(&self) -> Result<u32, String> {
        let conn = self.lock();
        let removed = conn
            .execute("DELETE FROM cache WHERE key LIKE ?1", params![like_all()])
            .map_err(|err| err.to_string())?;
        Ok(u32::try_from(removed).unwrap_or(u32::MAX))
    }

    /// Poda do namespace, agora que o Node não apaga mais estas linhas: apaga as
    /// VENCIDAS e, acima de `max_entries` (`0` = sem teto), as mais antigas por
    /// `rowid` (ordem de escrita). Numa transação só.
    pub fn sweep(&self, max_entries: u32, now_ms: i64) -> Result<DavailSweep, String> {
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        // Varredura completa ANTES de apagar: deletar enquanto o `SELECT` anda
        // pode pular linha, e a conta do teto sairia errada.
        let rows = {
            let mut stmt = tx
                .prepare(
                    "SELECT rowid, key, expires_at FROM cache WHERE key LIKE ?1 ORDER BY rowid",
                )
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![like_all()], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })
                .map_err(|err| err.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?
        };
        let mut expired = 0u32;
        let mut live: Vec<i64> = Vec::new();
        for (rowid, key, expires_at) in rows {
            if is_expired(expires_at, now_ms) {
                expired = expired.saturating_add(1);
                tx.execute("DELETE FROM cache WHERE key = ?1", params![key])
                    .map_err(|err| err.to_string())?;
                continue;
            }
            live.push(rowid);
        }
        // `max_entries == 0` é teto DESLIGADO, não "apaga tudo".
        let excess = if max_entries == 0 {
            0
        } else {
            live.len().saturating_sub(max_entries as usize)
        };
        let mut evicted = 0u32;
        for rowid in live.into_iter().take(excess) {
            tx.execute("DELETE FROM cache WHERE rowid = ?1", params![rowid])
                .map_err(|err| err.to_string())?;
            evicted = evicted.saturating_add(1);
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(DavailSweep { expired, evicted })
    }
}

/// Padrão do namespace inteiro. O prefixo não tem `%`/`_`, então dispensa
/// escape.
fn like_all() -> String {
    format!("{}%", prefix("davail"))
}

/// `<prefixo davail><adapter>:<accountScope>:` — `None` sem conta.
fn key_head(adapter: &str, api_key: &str) -> Option<String> {
    if adapter.is_empty() || api_key.is_empty() {
        return None;
    }
    Some(format!(
        "{}{}:{}:",
        prefix("davail"),
        adapter,
        account(api_key)
    ))
}

fn account(api_key: &str) -> String {
    account_scope(&Value::String(api_key.to_string()))
}

/// `ttl <= 0` = janela desligada: NÃO grava (mesmo contrato do `cache.setMany`).
fn expires_at_for(ttl_seconds: i64, now_ms: i64) -> Option<i64> {
    if ttl_seconds <= 0 {
        return None;
    }
    Some(now_ms.saturating_add(ttl_seconds.saturating_mul(1_000)))
}

/// `expires_at = 0`/ausente = sem expiração; positivo e vencido = expirado.
fn is_expired(expires_at: Option<i64>, now_ms: i64) -> bool {
    matches!(expires_at, Some(ts) if ts > 0 && ts <= now_ms)
}

/// `1`/`true` = pronto, `0`/`false` = frio. Qualquer outro texto é ausência.
fn parse_flag(raw: &str) -> Option<bool> {
    match raw.trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

fn flag_value(cached: bool) -> &'static str {
    if cached {
        "1"
    } else {
        "0"
    }
}

/// Lê uma linha; expirada é apagada e vira `None`.
fn read_one(conn: &Connection, key: &str, now_ms: i64) -> Result<Option<bool>, String> {
    let row: Option<(String, Option<i64>)> = conn
        .prepare("SELECT value, expires_at FROM cache WHERE key = ?1")
        .map_err(|err| err.to_string())?
        .query_row(params![key], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<i64>>(1)?))
        })
        .optional()
        .map_err(|err| err.to_string())?;
    let Some((raw, expires_at)) = row else {
        return Ok(None);
    };
    if is_expired(expires_at, now_ms) {
        conn.execute("DELETE FROM cache WHERE key = ?1", params![key])
            .map_err(|err| err.to_string())?;
        return Ok(None);
    }
    Ok(parse_flag(&raw))
}

#[cfg(test)]
#[path = "davail_state_tests.rs"]
mod davail_state_tests;
