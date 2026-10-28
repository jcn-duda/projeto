//! Fábrica de produção: os cinco serviços, o escopo fora do vocabulário e o
//! gate RD ÚNICO (prova pelo contador de executors criados).

use std::path::PathBuf;
use std::sync::Arc;

use adom_debrid::alldebrid::Provenance;
use adom_index::NativeKv;

use super::*;

const API_KEY: &str = "chave-de-teste-do-worker";

/// `cache.db` de fixture + fábrica. O diretório fica vivo até o fim do teste.
struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn setup(ledger: bool) -> (Fixture, Arc<Build>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("cache.db");
    let kv = Arc::new(NativeKv::open(&path).expect("cache.db de fixture"));
    // O caso comum (ledger ligado) passa pelo construtor padrão da fábrica.
    let build = if ledger {
        fixture(kv, &path)
    } else {
        fixture_with(kv, &path, false)
    };
    (Fixture { _dir: dir, path }, build)
}

#[test]
fn cinco_servicos_tem_adaptador() {
    let _guard = test_lock();
    let (_fixture, build) = setup(true);
    for service in SERVICES {
        let scope = format!("{service}:conta-de-teste");
        let ports = build.ports_for(service, API_KEY, &scope).expect(service);
        assert_eq!(ports.service().id(), service);
        // `evict` é desligado nos cinco: nenhum adaptador apaga por hash.
        assert!(!ports.capabilities().evict, "{service}");
        // O escopo vai para log/gate/ledger: a chave não pode viajar nele.
        assert!(!ports.scope().contains(API_KEY), "{service}");
        // A cola do trait (o que o laço consome) existe para cada um.
        assert!(
            build.adapter(service, API_KEY, &scope).is_some(),
            "{service}"
        );
    }
}

#[test]
fn escopo_desconhecido_nao_tem_adaptador() {
    let _guard = test_lock();
    let (_fixture, build) = setup(true);
    let scope = "servico-desconhecido:conta-de-teste";
    assert!(build
        .ports_for("servico-desconhecido", API_KEY, scope)
        .is_none());
    assert!(build
        .adapter("servico-desconhecido", API_KEY, scope)
        .is_none());
}

#[test]
fn rd_com_dois_escopos_usa_o_mesmo_gate() {
    let _guard = test_lock();
    let before = gates_built();
    let (_fixture, build) = setup(true);
    assert_eq!(gates_built(), before + 1, "a fábrica cria UM gate");
    let first = build
        .adapter("realdebrid", API_KEY, "realdebrid:conta-a")
        .expect("conta a");
    let second = build
        .adapter("realdebrid", "outra-chave", "realdebrid:conta-b")
        .expect("conta b");
    assert_eq!(
        gates_built(),
        before + 1,
        "conta nova reusa o gate do processo"
    );
    drop((first, second));
}

#[test]
fn alldebrid_usa_o_cache_db_e_fail_safe_sem_inventario() {
    let _guard = test_lock();
    let (fixture, build) = setup(true);
    let facts = build.alldebrid_facts("alldebrid:conta-sem-inventario");
    assert_eq!(facts.db_path.as_deref(), Some(fixture.path.as_path()));
    // Sem snapshot da conta: `inventory_ready` falso e nenhuma posse provada —
    // a guarda `adrm` fecha o caminho em vez de inventar dono.
    assert!(!facts.inventory_ready);
    assert_eq!(facts.provenance, Provenance::Unavailable);
}

#[test]
fn ledger_rd_liga_a_prova_de_cache() {
    let _guard = test_lock();
    let (_com, com) = setup(true);
    let (_sem, sem) = setup(false);
    let scope = "realdebrid:conta-de-teste";
    assert!(
        com.ports_for("realdebrid", API_KEY, scope)
            .expect("com ledger")
            .capabilities()
            .cache_known
    );
    assert!(
        !sem.ports_for("realdebrid", API_KEY, scope)
            .expect("sem ledger")
            .capabilities()
            .cache_known
    );
    // Debrid-Link não publica checagem de cache em nenhum caso.
    assert!(
        !com.ports_for("debridlink", API_KEY, "debridlink:conta")
            .expect("debridlink")
            .capabilities()
            .cache_known
    );
}
