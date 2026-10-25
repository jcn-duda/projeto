//! Leitura do banco de magnets do Node (`cache.db`, namespace `mag:v1`) pelo
//! caminho NATIVO.
//!
//! O `/resolve` do Node grava `mag:v1:{bad|lie}:<adapter>:<account>:<hash>`
//! (`src/utils/magnetdb.ts`). Até o F4.4a o build nativo lia essa evidência só
//! indiretamente: as rotas internas de evidência marcavam `broken` nos itens que
//! o NODE coletava — com a coleta/índice nativos o item nunca passava por lá e o
//! hash que o play provou quebrado (sem vídeo ou com áudio EN num post PT)
//! voltava à lista até o TTL.
//!
//! Aqui a evidência é lida DIRETO do `cache.db`, com as MESMAS chaves e a mesma
//! régua do `pruneKnownBroken` (`debrid-cache-steps.ts`): só `bad` e `lie`,
//! escopados por adapter+conta, e só o que ainda não venceu (`expires_at`).
//! `alive` fica fora de propósito — pintar ⚡ por histórico é outra decisão
//! (`DEBRID_ALIVE_AS_CACHE`) e não é prune.
//!
//! A conexão é READ-ONLY: o dono da escrita é o Node. Falha de abertura vira
//! `Err` e o gateway segue sem a fonte (degrada, nunca derruba a busca).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use adom_core::{account_scope as account_scope_of, prefix};
use adom_search::orchestrator::KnownBroken;
use rusqlite::Connection;
use serde_json::Value;

use crate::integrity::{self, OpenReport};

/// Sufixos lidos: o que o play PROVOU quebrado (não "pode ser"). O `alive` não
/// entra — ver o cabeçalho do módulo.
const BROKEN_FIELDS: [&str; 2] = ["bad", "lie"];

/// `mag:v1:` do `prefix('mag')`.
pub fn mag_prefix() -> &'static str {
    prefix("mag")
}

/// Chave de uma marca (`<mag><campo>:<adapter>:<account>:<hash>`), idêntica à do
/// `magKey` do Node.
pub fn mark_key(field: &str, adapter: &str, api_key: &str, hash: &str) -> String {
    format!(
        "{}{}:{}:{}:{}",
        mag_prefix(),
        field,
        adapter,
        account_scope_of(&Value::String(api_key.to_string())),
        hash.to_ascii_lowercase()
    )
}

/// Leitor do `cache.db` do Node (só `mag:`), compartilhado com a busca nativa.
pub struct MagnetDbStore {
    conn: Mutex<Connection>,
    /// Veredito do `quick_check` na abertura (arquivo podre = sem evidência).
    integrity: OpenReport,
}

impl MagnetDbStore {
    /// `CACHE_DB_PATH` (default `data/cache.db`), como o resto dos stores.
    /// `CACHE_PERSIST=false` desliga o disco do Node: não há `mag:` fresco para
    /// ler, então o caller degrada (nunca "evidência" de um arquivo parado).
    pub fn from_env() -> Result<Self, String> {
        if !crate::raw::cache_persist() {
            return Err("CACHE_PERSIST=false: sem cache.db para bad/lie".to_string());
        }
        let path = std::env::var("CACHE_DB_PATH")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty())
            .unwrap_or_else(|| "data/cache.db".to_string());
        Self::open_read_only(Path::new(&path))
    }

    /// Banco ainda inexistente falha (o caller degrada para "sem fonte"): abrir
    /// read-only não cria arquivo.
    ///
    /// O `quick_check` roda aqui, mas o arquivo NÃO é quarentenado: o dono da
    /// escrita é o Node, e renomear `cache.db` deixaria o processo dele
    /// gravando num inode órfão. Quem recupera o arquivo é o `open` gravável
    /// (streams/colhedor); aqui o store só nasce DEGRADADO e responde isso.
    pub fn open_read_only(path: &Path) -> Result<Self, String> {
        let (conn, integrity) = integrity::open_read_only_checked(path)?;
        if let Some(err) = integrity.error.as_deref() {
            eprintln!(
                "[gateway] magnet db degradado ({}): {err}; poda bad/lie sem evidência",
                path.display()
            );
        }
        Ok(Self {
            conn: Mutex::new(conn),
            integrity,
        })
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS cache (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL,
                 expires_at INTEGER NOT NULL
             );",
        )
        .map_err(|err| err.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
            integrity: OpenReport::healthy(),
        })
    }

    /// O `cache.db` reprovou o `quick_check` na abertura.
    pub fn degraded(&self) -> bool {
        self.integrity.degraded
    }

    /// Por que degradou — `None` quando o arquivo era íntegro.
    pub fn degraded_error(&self) -> Option<&str> {
        self.integrity.error.as_deref()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Hashes com histórico RUIM desta conta (só `bad`/`lie` vivos). O erro de
    /// I/O vira "sem evidência" no trait — a busca nunca cai por causa disto.
    pub fn broken_hashes_internal(
        &self,
        adapter: &str,
        api_key: &str,
        now_ms: i64,
    ) -> Result<HashSet<String>, String> {
        if adapter.is_empty() || api_key.is_empty() {
            return Ok(HashSet::new());
        }
        // O prefixo cobre `<campo>:<adapter>:<conta>:`; a varredura é por faixa
        // (`key >= prefixo AND key < prefixo + U+10FFFF`), que usa o índice da
        // PRIMARY KEY — `substr(key,1,n)` varreria a tabela a cada busca.
        let account = account_scope_of(&Value::String(api_key.to_string()));
        let conn = self.lock();
        let mut out = HashSet::new();
        for field in BROKEN_FIELDS {
            let prefix = format!("{}{}:{}:{}:", mag_prefix(), field, adapter, account);
            let upper = format!("{prefix}\u{10FFFF}");
            let mut stmt = conn
                .prepare("SELECT key FROM cache WHERE key >= ?1 AND key < ?2 AND expires_at > ?3")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![prefix, upper, now_ms], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|err| err.to_string())?;
            for key in rows.flatten() {
                let Some(hash) = key.strip_prefix(&prefix) else {
                    continue;
                };
                if !hash.is_empty() {
                    out.insert(hash.to_ascii_lowercase());
                }
            }
        }
        Ok(out)
    }
}

impl KnownBroken for MagnetDbStore {
    fn broken_hashes(&self, adapter: &str, api_key: &str, now_ms: i64) -> HashSet<String> {
        self.broken_hashes_internal(adapter, api_key, now_ms)
            .unwrap_or_else(|err| {
                eprintln!("[gateway] magnet db: leitura falhou ({err}); seguindo sem evidência");
                HashSet::new()
            })
    }
}

/// Caminho default do `cache.db` (diagnóstico/teste).
pub fn default_cache_db_path() -> std::path::PathBuf {
    crate::raw::cache_db_path()
}

#[cfg(test)]
#[path = "magnet_db_tests.rs"]
mod magnet_db_tests;
