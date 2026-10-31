//! Orquestração do catálogo contra um fake da porta (sem rede) e um banco em
//! memória: deduplicação, deleção manual, varredura e o gate de fatos.

use std::sync::Arc;

use adom_catalog::dedup::Deletion;
use adom_debrid::alldebrid_cleanup::adrm_key;
use adom_index::NativeKv;

use super::ops::{self, dedupe_by_id};
use super::support::*;
use crate::al_sweeps::effects::{NativeEffects, SweepEffects};
use crate::dub_audit::now_ms;

#[tokio::test(flavor = "multi_thread")]
async fn dedup_t1_tomba_so_o_confirmado_e_nao_marca() {
    // Mesmo hash em dois ids: o kill sai, o hash continua na conta pelo keep.
    let store = store_with(vec![
        row("1", HASH_A, "Filme.2024.mkv", 1000, true, 1000),
        row("2", HASH_A, "Filme.2024.mkv", 1000, false, 2000),
    ]);
    let facts = Arc::new(FakeFacts::default());
    let d = deps(
        store.clone(),
        FakePort::new(Ok(vec![]), &["2"]),
        facts.clone(),
    );
    let out = ops::dedup_apply(d, None).await;
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(num(&out, "deleted"), 1);
    assert!(!alive(&store, "2"), "o kill confirmado tomba");
    assert!(alive(&store, "1"), "o sobrevivente fica");
    assert!(
        facts.hooks.lock().unwrap().is_empty(),
        "T1 não marca anti-reenchimento"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_nao_confirmado_nao_tomba_a_linha() {
    let store = store_with(vec![
        row("1", HASH_A, "Filme.2024.mkv", 1000, true, 1000),
        row("2", HASH_A, "Filme.2024.mkv", 1000, false, 2000),
    ]);
    // A porta não confirma o "2": a linha segue viva e a falha é contada.
    let d = deps(
        store.clone(),
        FakePort::new(Ok(vec![]), &[]),
        Arc::new(FakeFacts::default()),
    );
    let out = ops::dedup_apply(d, None).await;
    assert_eq!(num(&out, "deleted"), 0, "{out}");
    assert_eq!(num(&out, "falhas"), 1, "{out}");
    assert!(alive(&store, "2"));
}

#[tokio::test(flavor = "multi_thread")]
async fn dedup_t2_marca_com_o_nome_quando_o_hash_sai() {
    // Arquivos iguais com hashes diferentes: o hash do kill SAI da conta, então
    // o hook recebe o nome (a blindagem BR vive nele).
    let store = store_with(vec![
        row("1", HASH_A, "Filme.2024.1080p.mkv", 1000, true, 1000),
        row("2", HASH_B, "Filme_2024_1080p.mkv", 1000, false, 2000),
    ]);
    let facts = Arc::new(FakeFacts::default());
    let d = deps(
        store.clone(),
        FakePort::new(Ok(vec![]), &["2"]),
        facts.clone(),
    );
    let out = ops::dedup_apply(d, None).await;
    assert_eq!(num(&out, "deleted"), 1, "{out}");
    let hooks = facts.hooks.lock().unwrap().clone();
    assert_eq!(
        hooks,
        vec![(HASH_B.to_string(), Some("Filme_2024_1080p.mkv".to_string()))]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn blindagem_br_nao_grava_adrm_e_nome_comum_grava() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let now = now_ms();
    let effects = NativeEffects::new(ACCOUNT, Some(kv.clone()));
    effects.mark_removed(HASH_A, "Filme.2024.1080p.WEB-DL.DUBLADO", now);
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, HASH_A), now)
            .unwrap()
            .is_none(),
        "origem BR nunca marca"
    );
    effects.mark_removed(HASH_B, "Movie.2024.1080p.BluRay.x264-YTS", now);
    assert!(
        kv.get_json(&adrm_key(ACCOUNT, HASH_B), now)
            .unwrap()
            .is_some(),
        "nome sem origem BR marca"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn listagem_com_erro_nao_varre_nem_tomba() {
    let store = store_with(vec![row("1", HASH_A, "Filme.mkv", 1000, true, 1000)]);
    let d = deps(
        store.clone(),
        FakePort::new(Err("auth".to_string()), &[]),
        Arc::new(FakeFacts::default()),
    );
    let out = ops::scan(d).await;
    assert_eq!(out, serde_json::json!({ "ok": false, "reason": "erro" }));
    assert!(
        alive(&store, "1"),
        "lista que falhou não tomba a conta inteira"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn varredura_tomba_os_que_sumiram_da_lista() {
    let store = store_with(vec![
        row("1", HASH_A, "Filme.mkv", 1000, true, 1000),
        row("2", HASH_B, "Outro.mkv", 900, true, 1000),
    ]);
    let listed = vec![magnet("1", HASH_A, "Filme.mkv", 1000)];
    let d = deps(
        store.clone(),
        FakePort::new(Ok(listed), &[]),
        Arc::new(FakeFacts::default()),
    );
    let out = ops::scan(d).await;
    assert_eq!(out["ok"], true, "{out}");
    assert_eq!(num(&out["report"], "magnets"), 1);
    assert!(alive(&store, "1"));
    assert!(!alive(&store, "2"), "sumido da lista é tombstonado");
}

#[tokio::test(flavor = "multi_thread")]
async fn manual_delete_so_os_ids_escolhidos_e_nao_ativos() {
    let mut active = row("2", HASH_B, "Baixando.mkv", 900, false, 1000);
    active.status = "downloading".to_string();
    let store = store_with(vec![
        row("1", HASH_A, "Filme.mkv", 1000, true, 1000),
        active,
    ]);
    let facts = Arc::new(FakeFacts::default());
    let d = deps(store.clone(), FakePort::new(Ok(vec![]), &["1"]), facts);
    let ids = vec!["1".to_string(), "2".to_string(), "999".to_string()];
    let out = ops::manual_delete(d, ids).await;
    assert_eq!(num(&out, "total"), 1, "{out}");
    assert_eq!(num(&out, "deleted"), 1);
    assert_eq!(num(&out, "active"), 1, "ativo nunca sai");
    assert_eq!(num(&out, "missing"), 1, "id inexistente conta como ausente");
    assert!(!alive(&store, "1"));
    assert!(alive(&store, "2"));
}

#[test]
fn dedupe_por_id_mantem_a_posicao_e_o_ultimo_valor() {
    let make = |id: &str, reason: &str| Deletion {
        service_id: id.to_string(),
        hash: HASH_A.to_string(),
        reason: reason.to_string(),
        filename: None,
        skip_mark: false,
    };
    let out = dedupe_by_id(vec![make("1", "a"), make("2", "b"), make("1", "c")]);
    let ids: Vec<(&str, &str)> = out
        .iter()
        .map(|d| (d.service_id.as_str(), d.reason.as_str()))
        .collect();
    assert_eq!(ids, vec![("1", "c"), ("2", "b")]);
}
