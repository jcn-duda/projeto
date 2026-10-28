//! Porta de escrita do índice do Chupim: canal com teto + thread dona do SQLite.
//!
//! # Um canal, dois efeitos
//!
//! O MESMO canal carrega o ACEITE (`Op::Keep`, linha `source:'autofetch'`) e o
//! ESQUECIMENTO (`Op::Forget`, `ReleaseIndexStore::forget_autofetch_hash`) —
//! como o `releaseIndex` do TS, que gravava e apagava pela mesma instância.
//!
//! O motivo é o SQLite, não a estética: [`ReleaseIndexStore`] guarda UMA
//! `Mutex<Connection>`, e o arquivo é o `cache.db` compartilhado com o Node. Um
//! segundo escritor custaria uma segunda conexão no mesmo arquivo (WAL +
//! `busy_timeout` disputando com o Node) e duas ordens de escrita concorrentes
//! sobre a mesma linha `idx:v14:…` — o aceite e o esquecimento do MESMO hash
//! podem chegar intercalados. Serializar num canal único mantém a ordem de
//! chegada e uma conexão só.
//!
//! # Recusa contada, nunca espera
//!
//! [`Refuse::Full`] é orçamento do escritor esgotado nesta janela (backoff: o
//! próximo lote tenta de novo) e [`Refuse::Closed`] é escritor morto/falha real.
//! Quem chama distingue os dois no painel (`index-full` x `index-error`); nenhum
//! dos dois falha o lote, porque índice é cache.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use adom_index::ReleaseIndexStore;

use super::Accepted;

/// Teto do canal do escritor: efeito excedente é recusado, nunca bloqueia.
const CHANNEL: usize = 256;

/// O que o escritor aplica, na ordem em que chegou.
///
/// `pub(crate)` só para poder ser RE-EXPORTADO por `index_record` (que é
/// `pub(super)` lá): o módulo é privado do `autofetch`, então nada disto sai da
/// crate.
#[derive(Clone, Debug)]
pub(crate) enum Op {
    /// Aceite confirmado do lote: release do Chupim na chave da obra.
    Keep(Accepted),
    /// Hash que morreu/saiu do lote: apaga SÓ a linha do Chupim
    /// (`forget_autofetch_hash` preserva a observação pública do mesmo hash).
    Forget { imdb_id: String, hash: String },
}

/// Por que a porta recusou a operação.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Refuse {
    /// Canal cheio: orçamento do escritor esgotado nesta janela (backoff).
    Full,
    /// Escritor fechado (`Disconnected`) ou falha real de escrita.
    Closed,
}

/// Porta de escrita do registro. Produção = canal + thread ([`spawn`]); teste =
/// aplicação direta num `ReleaseIndexStore` de memória.
///
/// `usize` = linhas tocadas (`record`/`forget_autofetch_hash`), só para o log.
pub(crate) type Sink = Arc<dyn Fn(Op) -> Result<usize, Refuse> + Send + Sync>;

/// Escritor de PRODUÇÃO: canal com teto + thread dona do SQLite. `None` =
/// índice desligado (`RELEASE_INDEX=false` ou `RELEASE_INDEX_TTL=0`), o mesmo
/// portão da leitura (`stream_config.rs:95-100`).
pub(crate) fn spawn(cache_db: &Path) -> Option<Sink> {
    let (ttl, max_releases) = super::limits()?;
    let (tx, rx) = mpsc::sync_channel::<Op>(CHANNEL);
    let path = PathBuf::from(cache_db);
    if let Err(err) = std::thread::Builder::new()
        .name("adom-idx-record".into())
        .spawn(move || write_loop(&path, rx, ttl, max_releases))
    {
        eprintln!("[autofetch] escritor do índice não subiu: {err}");
        return None;
    }
    Some(Arc::new(move |op: Op| send(&tx, op)))
}

/// `try_send`: cheio é [`Refuse::Full`] (backoff), canal sem escritor é
/// [`Refuse::Closed`]. Nunca espera — este caminho é o do lote.
fn send(tx: &mpsc::SyncSender<Op>, op: Op) -> Result<usize, Refuse> {
    match tx.try_send(op) {
        Ok(()) => Ok(0),
        Err(mpsc::TrySendError::Full(_)) => Err(Refuse::Full),
        Err(mpsc::TrySendError::Disconnected(_)) => Err(Refuse::Closed),
    }
}

/// Laço do escritor: abre o `cache.db` na PRIMEIRA operação — processo sem
/// aceite nunca paga `schema`/`drop_stale_idx`.
fn write_loop(path: &Path, rx: mpsc::Receiver<Op>, ttl: u64, max_releases: usize) {
    let mut store: Option<ReleaseIndexStore> = None;
    for op in rx {
        if store.is_none() {
            match open(path) {
                Ok(open) => {
                    store = Some(open.with_limits(ttl, max_releases));
                    eprintln!("[autofetch] índice do Chupim gravando em {}", dest(path));
                }
                Err(err) => {
                    eprintln!(
                        "[autofetch] índice indisponível ({}): {err}",
                        path.display()
                    );
                    continue;
                }
            }
        }
        let Some(open) = store.as_ref() else {
            continue;
        };
        apply(open, op);
    }
}

/// Aplica UMA operação. Falha aqui não volta ao lote nem derruba a thread: o
/// próximo efeito tenta de novo e o TTL do índice cobre o que ficou.
fn apply(store: &ReleaseIndexStore, op: Op) {
    let now = adom_sources::now_ms();
    match op {
        Op::Keep(accepted) => match super::record(store, &accepted, now) {
            Ok(0) => {}
            Ok(added) => eprintln!("[autofetch] {added} release(s) do Chupim no índice"),
            Err(err) => eprintln!("[autofetch] gravação no índice falhou: {err}"),
        },
        Op::Forget { imdb_id, hash } => match store.forget_autofetch_hash(&imdb_id, &hash, now) {
            Ok(0) => {}
            Ok(removed) => {
                eprintln!("[autofetch] {removed} release(s) do Chupim esquecida(s) no índice")
            }
            Err(err) => eprintln!("[autofetch] esquecimento no índice falhou: {err}"),
        },
    }
}

/// `CACHE_PERSIST=false` → memória, como o LEITOR
/// (`adom-index/src/release_index.rs:29-33,198-204`).
///
/// Com o leitor em memória o escritor também grava em memória: nada observável
/// muda, mas os dois lados param de divergir (escritor em disco + leitor em
/// memória gravaria num arquivo que ninguém lê). A régua é replicada aqui
/// porque o helper do `adom-index` é privado daquele crate.
fn open(path: &Path) -> Result<ReleaseIndexStore, String> {
    if cache_persist() {
        return ReleaseIndexStore::open(path);
    }
    ReleaseIndexStore::open_memory()
}

/// Destino do escritor, para o log de abertura.
fn dest(path: &Path) -> String {
    if cache_persist() {
        path.display().to_string()
    } else {
        "memória (CACHE_PERSIST=false)".to_string()
    }
}

/// Mesma regra de `release_index.rs:29`: só `false` (case-insensitive) desliga.
fn cache_persist() -> bool {
    persist_enabled(std::env::var("CACHE_PERSIST").ok().as_deref())
}

/// Régua PURA da env (testável sem mexer em variável de processo).
pub(super) fn persist_enabled(raw: Option<&str>) -> bool {
    raw.map(|raw| !raw.trim().eq_ignore_ascii_case("false"))
        .unwrap_or(true)
}

/// Sink do CICLO (registrado UMA vez no boot do worker, `boot::spawn_at`), como
/// o `season_fill::register`.
pub(crate) fn register(sink: Sink) {
    *lock(&shared().sink) = Some(sink);
}

/// Sink registrado, se o ciclo subiu com o índice ligado.
pub(crate) fn sink() -> Option<Sink> {
    lock(&shared().sink).clone()
}

struct Shared {
    sink: Mutex<Option<Sink>>,
}

fn shared() -> &'static Shared {
    static SHARED: OnceLock<Shared> = OnceLock::new();
    SHARED.get_or_init(|| Shared {
        sink: Mutex::new(None),
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Serializa os testes que registram sink (o registro é do PROCESSO).
#[cfg(test)]
pub(crate) async fn test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let lock = LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    lock.lock().await
}

/// Zera o sink (fim de um teste que registrou o seu).
#[cfg(test)]
pub(crate) fn clear() {
    *lock(&shared().sink) = None;
}
