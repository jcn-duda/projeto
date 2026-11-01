//! Escrita do `mag:v1` com outro processo gravando no mesmo `cache.db`.
//!
//! Transação DEFERRED que lê antes de escrever falha na hora em WAL quando outro
//! escritor comita no intervalo (`SQLITE_BUSY_SNAPSHOT`): o `busy_timeout` não
//! vale para esse caso. Medido em produção como `alive não gravado: database is
//! locked` com a máquina ociosa. A conexão daqui faz o papel do outro processo.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use adom_index::MagnetStateStore;
use rusqlite::Connection;

const NOW: i64 = 1_760_000_000_000;
const ROUNDS: i64 = 800;

struct OtherWriter {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
    dir: PathBuf,
}

impl OtherWriter {
    fn start(dir: PathBuf, path: &Path) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let conn = Connection::open(path).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let flag = stop.clone();
        let handle = std::thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                conn.execute(
                    "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES ('outro:x', '1', 0)",
                    [],
                )
                .unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        Self {
            stop,
            handle: Some(handle),
            dir,
        }
    }
}

impl Drop for OtherWriter {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn setup(name: &str) -> (MagnetStateStore, OtherWriter) {
    let dir =
        std::env::temp_dir().join(format!("adom-mag-contention-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cache.db");
    let store = MagnetStateStore::open(&path).unwrap();
    let other = OtherWriter::start(dir, &path);
    (store, other)
}

fn hashes() -> Vec<String> {
    (0..20u8).map(|n| format!("{n:02x}").repeat(20)).collect()
}

#[test]
fn mark_alive_nao_falha_com_outro_escritor() {
    let (store, _other) = setup("alive");
    let batch = hashes();
    for i in 0..ROUNDS {
        store
            .mark_alive("alldebrid", "chave", &batch, 3_600, NOW + i)
            .unwrap();
    }
}

#[test]
fn mark_bad_nao_falha_com_outro_escritor() {
    let (store, _other) = setup("bad");
    let batch = hashes();
    for i in 0..ROUNDS {
        store
            .mark_bad("alldebrid", "chave", &batch[0], 3_600, NOW + i)
            .unwrap();
    }
}

#[test]
fn sweep_nao_falha_com_outro_escritor() {
    let (store, _other) = setup("sweep");
    let batch = hashes();
    for i in 0..ROUNDS / 4 {
        store
            .mark_alive("alldebrid", "chave", &batch, 1, NOW + i)
            .unwrap();
        store.sweep(0, NOW + i + 2_000).unwrap();
    }
}
