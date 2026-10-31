//! Paridade das escritas do veredito (T3-L7a) sobre o SQLite de verdade —
//! o que o teste TS `runDubAudit: mentira do tail destrava adprot` provava.

use super::*;
use adom_index::NativeKv;
use serde_json::json;

fn temp_path() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    (dir, path)
}

/// Trava de env: `MAGNET_DB`/`CACHE_DB_PATH` são do processo e os testes rodam
/// em paralelo (mesmo padrão de `rd_warmer_http_tests`). À prova de poison.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Seta a var e restaura o valor anterior ao sair (não vaza para os irmãos).
struct EnvVar {
    key: &'static str,
    saved: Option<String>,
}

impl EnvVar {
    fn set(key: &'static str, value: &str) -> Self {
        let saved = std::env::var(key).ok();
        unsafe { std::env::set_var(key, value) };
        Self { key, saved }
    }
}

impl Drop for EnvVar {
    fn drop(&mut self) {
        unsafe {
            match &self.saved {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }
}

/// D1: o gate `MAGNET_DB` (e o `MAGNET_LIE`) atravessa o caminho inteiro —
/// `from_env` zera o `lie_enabled` e o executor (`mark_lie`) recusa ANTES de
/// tocar o banco. O `CACHE_DB_PATH` aponta para tempdir para o `from_env` não
/// abrir o `cache.db` de verdade.
#[test]
fn mag_db_desligado_nao_grava_a_mentira_do_tail() {
    let _lock = env_lock();
    let dir = tempfile::tempdir().expect("tempdir");
    let _db = EnvVar::set(
        "CACHE_DB_PATH",
        dir.path().join("cache.db").to_str().expect("caminho"),
    );
    let now = now_ms();
    let hash = "ab".repeat(20);

    let _off = EnvVar::set("MAGNET_DB", "false");
    let writes = NativeWrites::from_env(None);
    writes.mark_lie("alldebrid", "chave-de-teste", &hash, now);
    assert!(
        !writes.is_lie("alldebrid", "chave-de-teste", &hash),
        "gate desligado: a mentira do tail não grava"
    );

    // `MAGNET_LIE` desligado também zera, mesmo com o `MAGNET_DB` ligado.
    let _db_on = EnvVar::set("MAGNET_DB", "true");
    let _lie_off = EnvVar::set("MAGNET_LIE", "false");
    let writes = NativeWrites::from_env(None);
    writes.mark_lie("alldebrid", "chave-de-teste", &hash, now);
    assert!(!writes.is_lie("alldebrid", "chave-de-teste", &hash));

    // Com as duas ligadas, a MESMA chamada grava: a diferença é só o gate.
    let _lie_on = EnvVar::set("MAGNET_LIE", "true");
    let writes = NativeWrites::from_env(None);
    writes.mark_lie("alldebrid", "chave-de-teste", &hash, now);
    assert!(writes.is_lie("alldebrid", "chave-de-teste", &hash));
}

/// D3: a mentira que nasce no tail sobe o agregado O(1); renovar a MESMA
/// mentira não duplica a contagem.
#[test]
fn mentira_do_tail_sobe_o_agregado_sem_duplicar() {
    let (_dir, path) = temp_path();
    let now = now_ms();
    let writes = NativeWrites::open(&path, None);
    let hash = "ab".repeat(20);

    writes.mark_lie("alldebrid", "chave-de-teste", &hash, now);
    let mag = writes.mag.as_ref().expect("mag aberto");
    let agg = mag
        .counts(now)
        .unwrap()
        .expect("agregado gravado pelo tail");
    let lado = agg.adapters.get("alldebrid").expect("adapter");
    assert_eq!((lado.alive, lado.bad, lado.lie), (0, 0, 1));
    assert_eq!(lado.ttl_remaining_sums.lie, 7 * 24 * 3600);

    writes.mark_lie("alldebrid", "chave-de-teste", &hash, now + 1_000);
    let agg = mag.counts(now + 2_000).unwrap().expect("agregado vivo");
    assert_eq!(
        agg.adapters.get("alldebrid").unwrap().lie,
        1,
        "renovação não duplica"
    );
}

#[test]
fn mentira_grava_lie_e_destrava_o_adprot() {
    let (_dir, path) = temp_path();
    let now = now_ms();
    let api_key = "chave-nativa";
    let hash = "ab".repeat(20);
    let account = account_scope(&Value::String(api_key.to_string()));
    let key = format!("adprot:v1:alldebrid:{account}:{hash}");
    NativeKv::open(&path)
        .unwrap()
        .put_json(&key, &json!({ "at": now }), 0, now)
        .unwrap();

    let writes = NativeWrites::open(&path, None);
    assert!(!writes.is_lie("alldebrid", api_key, &hash));
    writes.mark_lie("alldebrid", api_key, &hash, now);
    assert!(writes.is_lie("alldebrid", api_key, &hash));
    // O veredito é por conta: outra chave não herda a mentira.
    assert!(!writes.is_lie("alldebrid", "outra-chave", &hash));

    writes.unprotect("alldebrid", api_key, &hash);
    assert_eq!(
        NativeKv::open(&path)
            .unwrap()
            .remaining_seconds(&key, now)
            .unwrap(),
        None,
        "adprot destravado"
    );
}

#[test]
fn episodio_errado_grava_a_prova_por_episodio_e_da_temporada() {
    let (_dir, path) = temp_path();
    let now = now_ms();
    let writes = NativeWrites::open(&path, None);
    let hash = "ab".repeat(20);

    writes.mark_missing("tt123", 1, 4, &hash, false, now);
    assert!(writes.is_missing("tt123", Some(1), Some(4), &hash, now));
    assert!(
        !writes.is_missing("tt123", Some(1), Some(5), &hash, now),
        "o mesmo hash continua candidato para outro episódio"
    );

    // Arquivo sem episódio declarado no nome: invalida a temporada inteira.
    let other = "cd".repeat(20);
    writes.mark_missing("tt123", 2, 1, &other, true, now);
    let index = ReleaseIndexStore::open(&path).unwrap();
    assert!(index.is_missing(
        "tt123",
        WorkTarget {
            season: Some(2),
            episode: None,
        },
        &other,
        now
    ));
}
