//! Banco de magnets (`mag:v1`) — histórico durável POR HASH, escopado por
//! serviço + conta.
//!
//! Mesma semântica do `magnetdb` do Node (`src/utils/magnetdb.ts`), com o Rust
//! como dono da regra e do estado. A chave é
//! `mag:v1:<campo>:<adapter>:<accountScope(apiKey)>:<hash>` e o valor gravado é
//! `"1"` (`JSON.stringify(1)`), no MESMO `data/cache.db` do Node.
//!
//! O que não pode variar:
//! - falso negativo é pior que falso positivo: `bad` só nasce de NoVideoError e
//!   `lie` só de DubLieError; timeout/rede nunca condena;
//! - `bad` vence o `alive` do mesmo hash NA MESMA TRANSAÇÃO. As janelas de TTL
//!   são distintas (24 h contra 7 dias), então os dois podem coexistir — e um
//!   `alive` sobrevivente desempataria o sort por dias num magnet que o play
//!   provou estar quebrado;
//! - `lie` NÃO apaga `alive`: o torrent tem vídeo, o que faltou foi o áudio PT.
//!
//! Schema idêntico ao `kv.rs` (`cache(key, value, expires_at)`, WAL,
//! `busy_timeout` 5000, índice `cache_expires`). Regras de expiração do Node
//! (`src/utils/magnetdb.ts` e o `cache.setMany` que ele usa): `ttl_seconds <= 0`
//! é janela **desligada** e nada é gravado — `markBad`/`markLie`/`markAlive`
//! retornam antes de tocar no banco, como o `ttl <= 0` das guardas do TS
//! (`magnetdb.ts:86,144,202`), e `mark_bad` desligado NÃO apaga o `alive`; com
//! TTL positivo, `expires_at` vencido (`<= now_ms`) é expirado e a leitura
//! apaga a linha.
//!
//! Desde a T2-L5b o namespace é do Rust ponta a ponta: enumeração
//! (`entries`/`summary`/`live_count`/`live_lies`) e manutenção (`clear`,
//! `sweep`, `forget_bad_of`, `remaining`) moram no irmão
//! [`query`](self::query), e o Node não lê nem poda mais estas linhas. Por isso
//! a chave só aceita hash `^[a-f0-9]{40}$`: chave que a enumeração não sabe ler
//! de volta é lixo invisível, e a guarda mora onde a chave nasce (o `davail`
//! NÃO segue essa regra — lá qualquer hash não vazio vale).

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use adom_core::{account_scope, prefix};
use rusqlite::Connection;
use serde_json::Value;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS cache_expires ON cache (expires_at);
";

/// Valor gravado nas marcas (`JSON.stringify(1)` do Node).
const MARK_VALUE: &str = "1";

/// `mag:v1:<campo>:<adapter>:<accountScope(api_key)>:<hash>`, com o hash em
/// minúsculas — a mesma chave do `magKey` do Node.
pub fn magnet_key(field: &str, adapter: &str, api_key: &str, hash: &str) -> String {
    format!(
        "{}{field}:{adapter}:{}:{}",
        prefix("mag"),
        account_scope(&Value::String(api_key.to_string())),
        hash.to_ascii_lowercase()
    )
}

/// Variante com o ESCOPO pronto (o SHA-256 da conta): o recompute do trace
/// (`/streams/trace`) não tem a API key — ela não viaja no `streamsCacheKey`, só
/// o scope — e recomputar `account_scope(scope)` seria outro hash.
pub fn magnet_key_scoped(field: &str, adapter: &str, scope: &str, hash: &str) -> String {
    format!(
        "{}{field}:{adapter}:{scope}:{}",
        prefix("mag"),
        hash.to_ascii_lowercase()
    )
}

/// Hash de 40 hex **minúsculo** — a única forma que a enumeração do
/// [`query`](self::query) lê de volta como `mag:v1:<side>:<adapter>:<scope>:<hash>`.
/// Fora disso a escrita é ignorada (não grava, não lê, não apaga).
pub(crate) fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Campo do `mag:v1` que uma marca ocupa.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MagnetState {
    Alive,
    Bad,
    Lie,
}

impl MagnetState {
    fn field(self) -> &'static str {
        match self {
            Self::Alive => "alive",
            Self::Bad => "bad",
            Self::Lie => "lie",
        }
    }
}

/// Foto de um hash: `None` = nenhuma evidência viva nesta conta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagnetMark {
    pub hash: String,
    pub state: Option<MagnetState>,
}

/// Escritor/leitor do `mag:v1` na tabela `cache`.
pub struct MagnetStateStore {
    conn: Mutex<Connection>,
}

impl MagnetStateStore {
    /// Abre (ou cria) o `cache.db` em `path`.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|err| format!("pasta do cache.db: {err}"))?;
            }
        }
        let conn = Connection::open(path).map_err(|err| format!("abrir cache.db: {err}"))?;
        conn.execute_batch(SCHEMA)
            .map_err(|err| format!("schema do cache.db: {err}"))?;
        Ok(Self::from_conn(conn))
    }

    pub fn open_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|err| err.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
        Ok(Self::from_conn(conn))
    }

    fn from_conn(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    pub(crate) fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|err| err.into_inner())
    }

    /// Grava `alive` em lote e devolve quantas chaves NASCERAM (não existiam
    /// antes). Hash com `bad` vivo é recusado: o play já provou que está
    /// quebrado e uma renovação não pode ressuscitá-lo. Hash fora de
    /// [`is_valid_hash`] é ignorado, sem impedir os outros do lote.
    pub fn mark_alive(
        &self,
        adapter: &str,
        api_key: &str,
        hashes: &[String],
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<usize, String> {
        if adapter.is_empty() || api_key.is_empty() || hashes.is_empty() {
            return Ok(0);
        }
        let Some(expires_at) = expires_at_for(ttl_seconds, now_ms) else {
            return Ok(0);
        };
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let mut born = 0usize;
        for hash in hashes {
            if !is_valid_hash(hash) {
                continue;
            }
            if live_flag(&tx, &magnet_key("bad", adapter, api_key, hash), now_ms)? {
                continue;
            }
            let key = magnet_key("alive", adapter, api_key, hash);
            // Nascida = a linha não existia ANTES da escrita (presença física,
            // como o `cache.has` do Node); renovação de chave viva não conta.
            if !row_exists(&tx, &key)? {
                born += 1;
            }
            upsert(&tx, &key, expires_at)?;
        }
        tx.commit().map_err(|err| err.to_string())?;
        Ok(born)
    }

    /// Grava `bad` e APAGA o `alive` do mesmo hash na MESMA transação. `true` =
    /// a chave `bad` nasceu agora (o Node usa isso nos contadores do painel).
    pub fn mark_bad(
        &self,
        adapter: &str,
        api_key: &str,
        hash: &str,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<bool, String> {
        if adapter.is_empty() || api_key.is_empty() || !is_valid_hash(hash) {
            return Ok(false);
        }
        // Janela desligada: sem escrita NÃO se apaga o `alive` do mesmo hash.
        // O TS também retorna antes do `cache.set`/`cache.forget`
        // (`magnetdb.ts:144`), e o alive continua válido — quem o derrubaria é a
        // evidência de play sem vídeo, que com ttl 0 nem é registrada.
        let Some(expires_at) = expires_at_for(ttl_seconds, now_ms) else {
            return Ok(false);
        };
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let key = magnet_key("bad", adapter, api_key, hash);
        let born = !row_exists(&tx, &key)?;
        upsert(&tx, &key, expires_at)?;
        // Sem o `forget` o alive continuaria desempatando o sort por até 7 dias
        // num magnet que o play provou estar quebrado.
        forget(&tx, &magnet_key("alive", adapter, api_key, hash))?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(born)
    }

    /// Grava `lie` (há vídeo, mas a promessa de áudio PT não se cumpriu). NÃO
    /// apaga o `alive` do mesmo hash — o TS também não apaga.
    pub fn mark_lie(
        &self,
        adapter: &str,
        api_key: &str,
        hash: &str,
        ttl_seconds: i64,
        now_ms: i64,
    ) -> Result<bool, String> {
        if adapter.is_empty() || api_key.is_empty() || !is_valid_hash(hash) {
            return Ok(false);
        }
        let Some(expires_at) = expires_at_for(ttl_seconds, now_ms) else {
            return Ok(false);
        };
        let conn = self.lock();
        let tx = conn
            .unchecked_transaction()
            .map_err(|err| err.to_string())?;
        let key = magnet_key("lie", adapter, api_key, hash);
        let born = !row_exists(&tx, &key)?;
        upsert(&tx, &key, expires_at)?;
        tx.commit().map_err(|err| err.to_string())?;
        Ok(born)
    }

    /// Apaga SÓ o `bad`; `alive`/`lie` do mesmo hash ficam. `true` = havia o
    /// que apagar (presença física, como o `cache.has` do reparo do Node).
    pub fn forget_bad(&self, adapter: &str, api_key: &str, hash: &str) -> Result<bool, String> {
        if adapter.is_empty() || api_key.is_empty() || !is_valid_hash(hash) {
            return Ok(false);
        }
        let conn = self.lock();
        let removed = forget(&conn, &magnet_key("bad", adapter, api_key, hash))?;
        Ok(removed > 0)
    }

    /// Precedência `bad > lie > alive > None` — só o que está VIVO conta.
    pub fn state(
        &self,
        adapter: &str,
        api_key: &str,
        hash: &str,
        now_ms: i64,
    ) -> Result<Option<MagnetState>, String> {
        if adapter.is_empty() || api_key.is_empty() || !is_valid_hash(hash) {
            return Ok(None);
        }
        state_in(&self.lock(), adapter, api_key, hash, now_ms)
    }

    /// Lote: uma entrada por hash pedido, na ordem pedida. O hash volta
    /// NORMALIZADO (minúsculo), que é a forma da chave: o chamador junta a foto
    /// pelo hash que mandou e perderia a entrada se ela voltasse crua.
    pub fn state_snapshot(
        &self,
        adapter: &str,
        api_key: &str,
        hashes: &[String],
        now_ms: i64,
    ) -> Result<Vec<MagnetMark>, String> {
        if adapter.is_empty() || api_key.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.lock();
        let mut out = Vec::with_capacity(hashes.len());
        for hash in hashes {
            // O hash volta normalizado: o chamador junta a foto pelo que mandou
            // e um hash em maiúsculas perderia a entrada. Fora do formato o
            // veredito é `None` — a guarda da escrita não deixou marca nascer.
            let state = if is_valid_hash(hash) {
                state_in(&conn, adapter, api_key, hash, now_ms)?
            } else {
                None
            };
            out.push(MagnetMark {
                hash: hash.to_ascii_lowercase(),
                state,
            });
        }
        Ok(out)
    }

    /// Leitura QUIET de UMA marca por campo (`bad`/`lie`), viva no instante —
    /// com o ESCOPO pronto (ver [`magnet_key_scoped`]). As leituras são
    /// independentes de propósito: `bad` e `lie` podem coexistir (há vídeo, o
    /// áudio faltou) e o recompute do Node (`peekBad`+`peekLie`) lê as duas —
    /// `state` aqui devolveria só a mais específica.
    pub fn peek_mark_scoped(
        &self,
        field: &str,
        adapter: &str,
        scope: &str,
        hash: &str,
        now_ms: i64,
    ) -> Result<bool, String> {
        if adapter.is_empty() || scope.is_empty() || !is_valid_hash(hash) {
            return Ok(false);
        }
        live_flag(
            &self.lock(),
            &magnet_key_scoped(field, adapter, scope, hash),
            now_ms,
        )
    }
}

#[path = "magnet_state_rows.rs"]
mod rows;
use rows::{expires_at_for, live_flag, row_exists, state_in, upsert};
pub(crate) use rows::{forget, is_expired, is_mark_value, read_row};

// Enumeração e manutenção do namespace: leem por varredura e apagam em nome do
// namespace inteiro (o `magnet_state.rs` fica com o ciclo de escrita e as
// leituras por chave). Submódulo para enxergar `lock`, `read_row` e `forget`.
#[path = "magnet_state_query.rs"]
mod query;
pub use query::{MagCount, MagEntry, MagPage, MagSweep};

#[cfg(test)]
#[path = "magnet_state_tests.rs"]
mod magnet_state_tests;

#[cfg(test)]
#[path = "magnet_state_query_tests.rs"]
mod magnet_state_query_tests;
