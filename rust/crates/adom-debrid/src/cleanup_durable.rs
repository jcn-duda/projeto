//! Escopo da conta, chaves duráveis e leitor read-only do `cache.db` do Node.
//!
//! Nada aqui grava: o banco é do Node (WAL) e a leitura é só prova
//! (`adprot`/`adsub`) e filtro de upload (`adrm`).

use std::collections::HashSet;
use std::fmt;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::params;
use sha2::{Digest, Sha256};

use super::flags::{reupload_block_enabled, CACHE_DB_ENV};

const DEFAULT_CACHE_DB: &str = "data/cache.db";

/// Mesma chave que `accountScope` do Node (`sha256(apiKey)` em hex), para bater
/// com `adprot`/`adsub` e com o inventário do Node. Chave vazia = `none`.
pub fn account_scope(api_key: &str) -> String {
    if api_key.is_empty() {
        return "none".into();
    }
    let digest = Sha256::digest(api_key.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn adprot_key(account: &str, hash: &str) -> String {
    format!(
        "adprot:v1:alldebrid:{account}:{}",
        hash.trim().to_lowercase()
    )
}

pub fn adsub_key(account: &str, hash: &str) -> String {
    format!("adsub:v1:{account}:{}", hash.trim().to_lowercase())
}

fn adsub_prefix(account: &str) -> String {
    format!("adsub:v1:{account}:")
}

/// Anti-reenchimento da AllDebrid (Fase 8, item 8.14): hash que a limpeza
/// apagou DE PROPÓSITO não volta ao `/magnet/upload`. **Sem** segmento de
/// adapter de propósito (≠ `adprot:v1:alldebrid:...`): só a AllDebrid marca e
/// a leitura de outra conta simplesmente não encontra registro — é o mesmo
/// `key()` de `markReuploadBlocked` no Node.
pub fn adrm_key(account: &str, hash: &str) -> String {
    format!("adrm:v1:{account}:{}", hash.trim().to_lowercase())
}

fn adrm_prefix(account: &str) -> String {
    format!("adrm:v1:{account}:")
}

/// Aviso ÚNICO (sem spam) de `cache.db` ausente: cada checagem cria um
/// `DurablePeek` novo, então a flag não pode ser por instância. O arquivo é o
/// MESMO do Node (`CACHE_DB_PATH`), logo sem banco o anti-reenchimento (`adrm`)
/// vira no-op nos dois lados — daí o aviso em vez do silêncio.
fn warn_missing_cache_db(path: &Path) {
    static WARNED: OnceLock<()> = OnceLock::new();
    warn_missing_cache_db_once(path, &WARNED, |msg| eprintln!("{msg}"));
}

/// Corpo com a trava injetada: o teste mede "uma vez só" com um `OnceLock`
/// próprio, sem depender do estado acumulado do processo.
pub(crate) fn warn_missing_cache_db_once(path: &Path, latch: &OnceLock<()>, emit: impl Fn(&str)) {
    latch.get_or_init(|| {
        emit(&format!(
            "[alldebrid] cache.db ausente em {}: anti-reenchimento (adrm) vira NO-OP e a guarda durável (adprot/adsub) fica sem fonte até o banco existir",
            path.display()
        ));
    });
}

/// Leitor read-only do `cache.db` (o mesmo arquivo que o Node mantém em WAL).
/// Abre sob demanda, uma vez; erro de abertura/consulta devolve "não protegido"
/// (o fail-safe da limpeza é `holds_complete` + inventário, não este banco).
///
/// Clonável porque a checagem usa o MESMO leitor para dois papéis: o filtro de
/// upload (`adrm`, vale sempre) e a guarda durável da limpeza (`adprot`/`adsub`,
/// só com `DEBRID_AL_CLEANUP=on`). A conexão é compartilhada pelo `Arc`.
#[derive(Clone)]
pub struct DurablePeek {
    path: PathBuf,
    conn: Arc<Mutex<Option<rusqlite::Connection>>>,
}

impl fmt::Debug for DurablePeek {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DurablePeek")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl DurablePeek {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// `CACHE_DB_PATH` ou `data/cache.db` (o mesmo default do processo Node).
    pub fn from_env() -> Self {
        let path = std::env::var(CACHE_DB_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_CACHE_DB.to_string());
        Self::new(path)
    }

    fn with_conn<T>(&self, body: impl FnOnce(&rusqlite::Connection) -> Option<T>) -> Option<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|err| err.into_inner());
        if guard.is_none() {
            if !self.path.exists() {
                // Fail-open continua (o hash volta a ser consultado), mas em
                // silêncio o anti-reenchimento sumiria sem ninguém notar.
                warn_missing_cache_db(&self.path);
                return None;
            }
            // Leitura curta: a classificação roda no lote da checagem (worker
            // tokio). O `busy_timeout` de 5 s do `open_readonly` prenderia o
            // worker num checkpoint do Node — 200 ms e desiste (fail-open só
            // aqui; o fail-safe da limpeza é inventário+holds).
            let opened = rusqlite::Connection::open_with_flags(
                &self.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .ok()
            .and_then(|conn| {
                conn.busy_timeout(Duration::from_millis(200)).ok()?;
                Some(conn)
            });
            *guard = opened;
        }
        body(guard.as_ref()?)
    }

    /// Registro existe e ainda não expirou (`cache.peek` do Node).
    pub fn alive(&self, key: &str, now: i64) -> bool {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT expires_at FROM cache WHERE key = ?1")
                .ok()?;
            let expires_at: Option<i64> = stmt
                .query_row(params![key], |row| row.get::<_, i64>(0))
                .ok();
            Some(expires_at.is_some_and(|expires| expires > now))
        })
        .unwrap_or(false)
    }

    /// Acervo BR retido (`adprot:v1:alldebrid:...`).
    pub fn is_protected(&self, account: &str, hash: &str, now: i64) -> bool {
        self.alive(&adprot_key(account, hash), now)
    }

    /// O addon subiu este hash (`adsub:v1`): ele pode sair sem virar "acervo".
    pub fn is_owned(&self, account: &str, hash: &str, now: i64) -> bool {
        self.alive(&adsub_key(account, hash), now)
    }

    /// Todos os `adsub` vivos da conta numa consulta (usado pelo inventário).
    pub fn owned_hashes(&self, account: &str, now: i64) -> HashSet<String> {
        self.prefixed_hashes(&adsub_prefix(account), now)
    }

    /// Hashes desta conta que a limpeza apagou de propósito (`adrm:v1`) e que a
    /// checagem NÃO pode re-subir.
    ///
    /// É filtro de UPLOAD, não de play: o hash sai da chamada do
    /// `/magnet/upload` (que é a própria consulta de cache) para a conta não
    /// reencher com o que acabou de sair. Fonte read-only — abrir/consultar este
    /// banco não grava, não expira e não toca na conta. Banco ausente/ilegível
    /// devolve vazio: sem prova do bloqueio, o hash volta a ser consultado (o
    /// fail-safe aqui é o lado do reenchimento, nunca o de esconder ⚡ real).
    ///
    /// O kill-switch/TTL (`enabled()` do Node, MESMAS envs) é conferido ANTES
    /// de abrir o banco: desligado ou TTL 0 devolve vazio sem I/O.
    pub fn blocked_hashes(&self, account: &str, now: i64) -> HashSet<String> {
        self.blocked_hashes_when(account, now, reupload_block_enabled())
    }

    /// Miolo do filtro com a flag explícita — testes sem env global.
    pub(super) fn blocked_hashes_when(
        &self,
        account: &str,
        now: i64,
        enabled: bool,
    ) -> HashSet<String> {
        if !enabled {
            return HashSet::new();
        }
        self.prefixed_hashes(&adrm_prefix(account), now)
    }

    /// Hashes vivos com `prefix` (`<namespace>:v1:<conta>:`), numa consulta — o
    /// MESMO SQL do `owned_hashes`, de propósito: um só lugar para a régua de
    /// TTL do `cache.db` do Node.
    fn prefixed_hashes(&self, prefix: &str, now: i64) -> HashSet<String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT key FROM cache
                     WHERE substr(key, 1, length(?1)) = ?1 AND expires_at > ?2",
                )
                .ok()?;
            let rows = stmt
                .query_map(params![prefix, now], |row| row.get::<_, String>(0))
                .ok()?;
            Some(
                rows.filter_map(Result::ok)
                    .filter_map(|key| key.strip_prefix(prefix).map(str::to_lowercase))
                    .filter(|hash| !hash.is_empty())
                    .collect(),
            )
        })
        .unwrap_or_default()
    }
}
