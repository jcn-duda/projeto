//! Testes dos efeitos de produção (`NativeEffects`) sobre um `NativeKv` em
//! memória — sem env global e sem `cache.db` em disco.

use std::collections::HashSet;
use std::sync::Arc;

use adom_autofetch::v3::SuppressedV3;
use adom_debrid::alldebrid_cleanup::{adprot_key, adprot_prefix, adrm_key, adsub_key};
use adom_index::NativeKv;

use super::{NativeEffects, SweepEffects, ADAPTER};
use crate::al_sweeps::tests::{hash_of, FakeFacts, NOW};

fn effects(kv: Option<Arc<NativeKv>>) -> NativeEffects {
    NativeEffects {
        account: "conta".into(),
        kv,
        mark_enabled: true,
        mark_ttl_seconds: 3 * 24 * 3600,
    }
}

fn kv() -> Arc<NativeKv> {
    Arc::new(NativeKv::open_memory().expect("kv em memória"))
}

#[test]
fn marca_o_removido_com_at_e_nome() {
    let store = kv();
    effects(Some(store.clone())).mark_removed(&hash_of('a').to_uppercase(), "Release.A.GRP", NOW);
    let record = store
        .get_json(&adrm_key("conta", &hash_of('a')), NOW)
        .expect("leitura do adrm")
        .expect("marca gravada");
    assert_eq!(record["at"], NOW);
    assert_eq!(record["name"], "Release.A.GRP");
}

#[test]
fn blindagem_br_nao_marca() {
    let store = kv();
    let fx = effects(Some(store.clone()));
    fx.mark_removed(&hash_of('a'), "Filme.2024.BLUDV", NOW);
    fx.mark_removed(&hash_of('b'), "A Paixão de Cristo 1080p", NOW);
    assert_eq!(
        store
            .get_json(&adrm_key("conta", &hash_of('a')), NOW)
            .unwrap(),
        None,
        "nome com marca BR nunca grava: o pior caso é o lixo voltar"
    );
    assert_eq!(
        store
            .get_json(&adrm_key("conta", &hash_of('b')), NOW)
            .unwrap(),
        None
    );
}

#[test]
fn kill_ou_ttl_zerado_nao_marca() {
    let store = kv();
    let mut fx = effects(Some(store.clone()));
    fx.mark_enabled = false;
    fx.mark_removed(&hash_of('a'), "Release.A.GRP", NOW);
    assert_eq!(
        store
            .get_json(&adrm_key("conta", &hash_of('a')), NOW)
            .unwrap(),
        None
    );
    fx.mark_enabled = true;
    fx.mark_ttl_seconds = 0;
    fx.mark_removed(&hash_of('a'), "Release.A.GRP", NOW);
    assert_eq!(
        store
            .get_json(&adrm_key("conta", &hash_of('a')), NOW)
            .unwrap(),
        None
    );
}

#[test]
fn sem_kv_nenhum_efeito_panica_nem_grava() {
    effects(None).mark_removed(&hash_of('a'), "R", NOW);
    effects(None).heal_suppressed(&hash_of('a'));
    effects(None).forget_ownership(&hash_of('a'));
    assert_eq!(
        effects(None).prune_retention(&FakeFacts::default(), &HashSet::new(), 0, NOW),
        0
    );
}

#[test]
fn poda_respeita_presente_hold_e_idade() {
    let store = kv();
    let jovem_at = NOW - 60_000;
    let velho_at = NOW - 3_600_000;
    for (hash, at) in [
        (&hash_of('a'), Some(velho_at)), // fora da conta e velho: poda
        (&hash_of('b'), Some(jovem_at)), // jovem: fica
        (&hash_of('c'), None),           // sem carimbo: poda
    ] {
        let mut record = serde_json::json!({ "acceptedAt": 1, "readyAt": null });
        match at {
            Some(at) => record["acceptedAt"] = at.into(),
            None => record = serde_json::json!("não é objeto"),
        }
        store
            .put_json(
                &adprot_key("conta", hash),
                &record,
                10 * 365 * 24 * 3600,
                NOW,
            )
            .unwrap();
    }
    // `d` está na conta (present); `e` tem hold vivo (FakeFacts).
    store
        .put_json(
            &adprot_key("conta", &hash_of('d')),
            &serde_json::json!({ "acceptedAt": velho_at }),
            10 * 365 * 24 * 3600,
            NOW,
        )
        .unwrap();
    store
        .put_json(
            &adprot_key("conta", &hash_of('e')),
            &serde_json::json!({ "acceptedAt": velho_at }),
            10 * 365 * 24 * 3600,
            NOW,
        )
        .unwrap();

    let facts = FakeFacts::default().holds('e');
    let present: HashSet<String> = [hash_of('d')].into_iter().collect();
    let pruned = effects(Some(store.clone())).prune_retention(&facts, &present, 30 * 60_000, NOW);

    assert_eq!(pruned, 2);
    let alive = |hash: &str| {
        store
            .get_json(&adprot_key("conta", hash), NOW)
            .unwrap()
            .is_some()
    };
    assert!(!alive(&hash_of('a')), "velho e ausente sai");
    assert!(!alive(&hash_of('c')), "registro sem carimbo não prova nada");
    assert!(alive(&hash_of('b')), "jovem fica pela graça");
    assert!(alive(&hash_of('d')), "presente na conta nunca sai");
    assert!(alive(&hash_of('e')), "hold vivo adia a poda");
    assert!(
        store
            .keys_matching(&adprot_prefix("conta"), NOW)
            .unwrap()
            .len()
            == 3,
        "a varredura não toca em namespace de outra conta"
    );
}

#[test]
fn poda_com_hold_ilegivel_fica_fail_closed() {
    // 'a' é velho e ausente — podável SE "sem hold" fosse provado; com a
    // leitura do hold SEM prova (`held_checked` → `None`), o registro FICA.
    let store = kv();
    let velho_at = NOW - 3_600_000;
    store
        .put_json(
            &adprot_key("conta", &hash_of('a')),
            &serde_json::json!({ "acceptedAt": velho_at }),
            10 * 365 * 24 * 3600,
            NOW,
        )
        .unwrap();
    let facts = FakeFacts::default().holds_unreadable();
    let pruned =
        effects(Some(store.clone())).prune_retention(&facts, &HashSet::new(), 30 * 60_000, NOW);
    assert_eq!(pruned, 0, "hold que não pôde ser lido adia a poda");
    assert!(
        store
            .get_json(&adprot_key("conta", &hash_of('a')), NOW)
            .unwrap()
            .is_some(),
        "registro permanece"
    );
}

#[test]
fn poda_nao_condena_registro_ilegivel() {
    // 'a' é podável (velho, ausente, legível); 'b' tem o corpo CORROMPIDO no
    // L2 (JSON inválido): ler falhou ≠ carimbo ausente — 'b' fica.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cache.db");
    let store = Arc::new(NativeKv::open(&path).unwrap());
    store
        .put_json(
            &adprot_key("conta", &hash_of('a')),
            &serde_json::json!({ "acceptedAt": NOW - 3_600_000 }),
            10 * 365 * 24 * 3600,
            NOW,
        )
        .unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, 'não é json', 0)",
            rusqlite::params![adprot_key("conta", &hash_of('b'))],
        )
        .unwrap();
    assert!(store
        .get_json(&adprot_key("conta", &hash_of('b')), NOW)
        .is_err());

    let pruned = effects(Some(store.clone())).prune_retention(
        &FakeFacts::default(),
        &HashSet::new(),
        30 * 60_000,
        NOW,
    );
    assert_eq!(pruned, 1, "só o registro legível sai");
    assert!(
        store
            .get_json(&adprot_key("conta", &hash_of('a')), NOW)
            .unwrap()
            .is_none(),
        "podável e legível sai"
    );
    assert!(
        store
            .keys_matching(&adprot_prefix("conta"), NOW)
            .unwrap()
            .contains(&adprot_key("conta", &hash_of('b'))),
        "registro ilegível fica (fail-closed)"
    );
}

#[test]
fn cura_esquece_o_represado_e_a_posse() {
    let store = kv();
    let queue = SuppressedV3::new(&store);
    queue
        .note(ADAPTER, "conta", &hash_of('a'), "id-1", 30 * 24 * 3600, NOW)
        .unwrap();
    store
        .put_json(
            &adsub_key("conta", &hash_of('a')),
            &serde_json::json!({ "at": NOW }),
            3600,
            NOW,
        )
        .unwrap();

    effects(Some(store.clone())).heal_suppressed(&hash_of('a'));
    effects(Some(store.clone())).forget_ownership(&hash_of('a'));

    assert_eq!(
        queue.read(ADAPTER, "conta", &hash_of('a'), NOW).unwrap(),
        None,
        "o represado curado não volta ao plano"
    );
    assert_eq!(
        store
            .get_json(&adsub_key("conta", &hash_of('a')), NOW)
            .unwrap(),
        None
    );
}
