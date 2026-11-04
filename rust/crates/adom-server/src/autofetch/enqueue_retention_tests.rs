//! A proteção durável do Chupim tem que ser a MESMA chave que a limpeza da
//! checagem lê (`al_cleanup_facts::protected`), senão o download aceito é
//! apagado da conta na busca seguinte.

use adom_debrid::alldebrid_cleanup;
use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::json;

use super::super::super::fakes::{batch_payload, job, FakeDebrid, SCOPE};
use super::super::super::Policy;
use super::super::{run, Holds};
use super::{adprot_key, hold_key, protect_br_with, BrFacts};

const SEARCH: &str = "tt1234567:1:2";
const ACCOUNT: &str = "conta-de-teste";

fn hash_of(n: u32) -> String {
    format!("{n:040x}")
}

fn kv() -> NativeKv {
    let kv = NativeKv::open_memory().unwrap();
    kv.put_json(
        "cfg:v1:autofetch",
        &json!({ "autoFetchMax": 3 }),
        600,
        now_ms(),
    )
    .unwrap();
    kv
}

fn alive(kv: &NativeKv, key: &str) -> bool {
    kv.get_json(key, now_ms()).unwrap().is_some()
}

fn br_facts() -> BrFacts {
    BrFacts {
        pool_br: true,
        br: true,
        dubbed: true,
        lied: false,
    }
}

#[test]
fn chaves_batem_com_as_da_limpeza() {
    let hash = hash_of(7).to_ascii_uppercase();
    assert_eq!(
        hold_key(ACCOUNT, &hash),
        alldebrid_cleanup::adhold_key(ACCOUNT, &hash)
    );
    assert_eq!(
        adprot_key("alldebrid", ACCOUNT, &hash),
        alldebrid_cleanup::adprot_key(ACCOUNT, &hash)
    );
}

#[tokio::test]
async fn aceito_fica_com_hold_duravel_e_recusado_nao() {
    let kv = kv();
    let now = now_ms();
    let payload = batch_payload(SEARCH, &[(&hash_of(1), true)]);
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &FakeDebrid::accepting(),
        &job(SCOPE, payload),
        now,
    )
    .await
    .unwrap();
    assert_eq!(report.enqueued.len(), 1);
    assert!(
        alive(&kv, &hold_key(ACCOUNT, &hash_of(1))),
        "aceito segue protegido da limpeza"
    );
    assert!(
        alive(&kv, &adprot_key("alldebrid", ACCOUNT, &hash_of(1))),
        "pool BR dublado na AllDebrid ganha retenção"
    );

    let refusing = FakeDebrid {
        known: true,
        accept: false,
        ..FakeDebrid::default()
    };
    let payload = batch_payload("tt7654321:1:1", &[(&hash_of(2), true)]);
    let report = run(
        &kv,
        Policy::fixture(),
        &Holds::default(),
        false,
        &refusing,
        &job(SCOPE, payload),
        now,
    )
    .await
    .unwrap();
    assert!(report.enqueued.is_empty());
    assert!(
        !alive(&kv, &hold_key(ACCOUNT, &hash_of(2))),
        "recusa solta o hold durável"
    );
    assert!(!alive(&kv, &adprot_key("alldebrid", ACCOUNT, &hash_of(2))));
}

#[test]
fn adprot_so_no_pool_br_dublado_sem_mentira() {
    let kv = kv();
    let now = now_ms();
    let cases = [
        (
            BrFacts {
                pool_br: false,
                ..br_facts()
            },
            "pool any/seeds",
        ),
        (
            BrFacts {
                br: false,
                ..br_facts()
            },
            "fonte não BR",
        ),
        (
            BrFacts {
                dubbed: false,
                ..br_facts()
            },
            "sem dublagem",
        ),
        (
            BrFacts {
                lied: true,
                ..br_facts()
            },
            "promessa condenada",
        ),
    ];
    for (n, (facts, why)) in cases.iter().enumerate() {
        let hash = hash_of(10 + n as u32);
        protect_br_with(&kv, "alldebrid", ACCOUNT, &hash, facts, true, 600, now);
        assert!(
            !alive(&kv, &adprot_key("alldebrid", ACCOUNT, &hash)),
            "{why}"
        );
    }
    protect_br_with(
        &kv,
        "torbox",
        ACCOUNT,
        &hash_of(20),
        &br_facts(),
        true,
        600,
        now,
    );
    assert!(
        !alive(&kv, &adprot_key("torbox", ACCOUNT, &hash_of(20))),
        "só AllDebrid"
    );
    protect_br_with(
        &kv,
        "alldebrid",
        ACCOUNT,
        &hash_of(21),
        &br_facts(),
        false,
        600,
        now,
    );
    assert!(
        !alive(&kv, &adprot_key("alldebrid", ACCOUNT, &hash_of(21))),
        "kill-switch"
    );
}

#[test]
fn adprot_e_idempotente_e_preserva_o_aceite() {
    let kv = kv();
    let now = now_ms();
    let key = adprot_key("alldebrid", ACCOUNT, &hash_of(30));
    protect_br_with(
        &kv,
        "alldebrid",
        ACCOUNT,
        &hash_of(30),
        &br_facts(),
        true,
        600,
        now - 5000,
    );
    protect_br_with(
        &kv,
        "alldebrid",
        ACCOUNT,
        &hash_of(30),
        &br_facts(),
        true,
        600,
        now,
    );
    let value = kv.get_json(&key, now).unwrap().unwrap();
    assert_eq!(value["acceptedAt"], json!(now - 5000));
    assert_eq!(value["readyAt"], json!(null));
}
