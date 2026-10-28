//! Boot: a trava `AUTOFETCH_WORKER=on` liga a fábrica de produção e o handle
//! sai `active`; sem ela nada muda (`prepared`, sem fábrica).

use std::sync::Arc;

use super::*;
use crate::autofetch::build::test_lock;
use crate::autofetch::worker::AutofetchHandle;
use crate::autofetch::{Policy, Vault};

const API_KEY: &str = "chave-de-teste-do-worker";

fn cache_db() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    (dir, path)
}

fn vault() -> Arc<Vault> {
    Arc::new(Vault::new(21_600_000, 8, ""))
}

#[test]
fn env_on_liga_a_fabrica_de_producao() {
    let _guard = test_lock();
    let (_dir, path) = cache_db();
    let kv = open_kv(&path).expect("cache.db de fixture");
    let vault = vault();
    std::env::set_var("AUTOFETCH_WORKER", "on");
    let factory = production_factory(&kv, &path, Some(&vault)).expect("fábrica de produção");

    // Os CINCO serviços, pela MESMA fábrica que o laço vai chamar.
    let now = adom_sources::now_ms();
    for service in crate::autofetch::build::SERVICES {
        let scope = vault.put(service, API_KEY, now).expect("escopo do cofre");
        assert!(factory(&scope).is_some(), "{service}");
    }
    // Escopo com chave viva e serviço fora dos cinco → `None` (passo pulado).
    let unknown = vault
        .put("servico-desconhecido", API_KEY, now)
        .expect("escopo");
    assert!(factory(&unknown).is_none());
    // Escopo sem chave no cofre → `None` (nunca recusa do lote).
    assert!(factory("torbox:conta-que-nao-existe").is_none());

    let handle = AutofetchHandle::build(kv, &Policy::fixture(), Some(vault), Some(factory));
    let status = handle.status();
    assert!(status.enabled, "handle ligado com a trava");
    assert_eq!(status.phase, "active");
    assert!(handle.request_drain(), "canal do laço existe");
    std::env::remove_var("AUTOFETCH_WORKER");
}

#[test]
fn sem_env_o_worker_fica_prepared() {
    let _guard = test_lock();
    let (_dir, path) = cache_db();
    let kv = open_kv(&path).expect("cache.db de fixture");
    let vault = vault();
    std::env::remove_var("AUTOFETCH_WORKER");
    assert!(
        production_factory(&kv, &path, Some(&vault)).is_none(),
        "trava desligada não monta fábrica"
    );
    let handle = AutofetchHandle::build(kv, &Policy::fixture(), Some(vault), None);
    let status = handle.status();
    assert!(!status.enabled);
    assert_eq!(status.phase, "prepared");
}

#[test]
fn sem_cofre_a_fabrica_nao_e_montada() {
    let _guard = test_lock();
    let (_dir, path) = cache_db();
    let kv = open_kv(&path).expect("cache.db de fixture");
    std::env::set_var("AUTOFETCH_WORKER", "on");
    assert!(production_factory(&kv, &path, None).is_none());
    std::env::remove_var("AUTOFETCH_WORKER");
}
