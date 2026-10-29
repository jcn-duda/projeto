//! Segunda parte da evicção por hash: hold do Node, `adrm`, inventário
//! ausente, idade e o caminho feliz.
//!
//! Arquivo próprio pela catraca de 400 linhas — o harness (`EvictEnv`,
//! `db_with`, `row_dated`) mora no irmão e é compartilhado por `pub(super)`.
//! Cada teste aqui APAGA o que a guarda deveria barrar: se um deles passar a
//! remover, a prova regrediu.

use std::sync::Arc;

use super::evict::*;
use super::*;
use crate::alldebrid_cleanup::{account_scope, adhold_key, adrm_key};
use crate::autofetch_ports::evict::{
    evict_gate, margin_from, min_age_from, EvictProof, EvictSkip, EVICT_MARGIN_ENV,
    EVICT_MIN_AGE_ENV,
};
use crate::error::now_ms;

/// Fila feliz: uma linha só, com delete respondendo 200.
async fn scene_ok(row: serde_json::Value) -> (SocketAddr, Scene) {
    listen(
        vec![
            (
                "GET /magnet/status",
                200,
                envelope(json!({"magnets": [row]})),
            ),
            ("GET /magnet/delete", 200, envelope(json!({}))),
        ],
        (404, "{}".into()),
    )
    .await
}

#[tokio::test]
async fn hash_com_hold_do_node_nao_e_apagado() {
    let hash = hash_of('h');
    let (addr, scene) = scene_ok(row(51, &hash, "Duna.2021.1080p.mkv")).await;
    // Posse e idade provadas; o ÚNICO veto é o hold do Node (`adhold:v1`), que
    // o mapa em memória deste processo nunca vê.
    let (_dir, db) = db_with(&[owned(&hash), adhold_key(&account_scope(KEY), &hash)]);
    let _env = EvictEnv::new(addr, "on");
    assert!(
        all_debrid(db).evict(&[hash]).await.unwrap().is_empty(),
        "hold vivo barra o delete"
    );
    assert_eq!(paths(&scene), ["/magnet/status"], "nenhum delete tentado");
}

#[tokio::test]
async fn hash_com_adrm_nao_conta_como_posse() {
    let hash = hash_of('m');
    let (addr, scene) = scene_ok(row(52, &hash, "Duna.2021.1080p.mkv")).await;
    // `adsub` vivo (posse) + `adrm` vivo (apagado DE PROPÓSITO): a marca nega
    // a posse, então o hash não é lixo nosso de novo.
    let (_dir, db) = db_with(&[owned(&hash), adrm_key(&account_scope(KEY), &hash)]);
    let _env = EvictEnv::new(addr, "on");
    assert!(
        all_debrid(db).evict(&[hash]).await.unwrap().is_empty(),
        "adrm nega a posse"
    );
    assert_eq!(paths(&scene), ["/magnet/status"]);
}

#[tokio::test]
async fn inventario_ausente_nao_apaga_nada() {
    let hash = hash_of('n');
    let (addr, scene) = listen(vec![], (500, "{}".into())).await;
    // `db_path` aponta para um arquivo que não existe: `adsub`/`adprot`/`adrm`/
    // `adhold` sem fonte, e "não protegido" seria indistinguível de "protegido".
    let dir = tempfile::tempdir().unwrap();
    let _env = EvictEnv::new(addr, "on");
    let port = AutofetchPorts::alldebrid(
        Arc::new(AllDebrid::new(HttpClient::new().unwrap())),
        KEY,
        AlldebridFacts {
            db_path: Some(dir.path().join("nao-existe.db")),
            ..AlldebridFacts::default()
        },
    );
    let error = port.evict(&[hash]).await.unwrap_err();
    assert_ne!(
        error.kind(),
        "unsupported",
        "a capacidade existe: {error:?}"
    );
    assert!(
        format!("{error:?}").contains("inventário"),
        "recusa tem que dizer o motivo: {error:?}"
    );
    assert!(paths(&scene).is_empty(), "inventário ilegível = zero rede");
}

#[tokio::test]
async fn hash_jovem_na_conta_nao_e_apagado() {
    let hash = hash_of('o');
    let now = now_ms() as i64;
    // Upload de 15 min e posse de 20 min: as DUAS idades abaixo do piso de 30
    // min, e upload (15 min) dentro da margem da posse (20 min + 10 min) — de
    // propósito, para o veto vir da IDADE e não do anti-re-add.
    let upload_s = (now - 900_000) / 1000;
    let (addr, scene) = scene_ok(row_dated(53, &hash, "Duna.2021.1080p.mkv", upload_s)).await;
    let (_dir, db) = db_with_at(&[owned(&hash)], now - 1_200_000);
    let _env = EvictEnv::new(addr, "on");
    assert!(
        all_debrid(db).evict(&[hash]).await.unwrap().is_empty(),
        "hash jovem não é fallback velho"
    );
    assert_eq!(paths(&scene), ["/magnet/status"], "nenhum delete tentado");
}

#[tokio::test]
async fn posse_com_idade_e_sem_hold_apaga() {
    let hash = hash_of('p');
    let now = now_ms() as i64;
    let upload_s = (now - 3_600_000) / 1000;
    let (addr, scene) = scene_ok(row_dated(54, &hash, "Duna.2021.1080p.mkv", upload_s)).await;
    // Posse de 1 h e upload de 1 h: as duas medidas passam o piso de 30 min.
    let (_dir, db) = db_with_at(&[owned(&hash)], now - 3_600_000);
    let _env = EvictEnv::new(addr, "on");
    let removed = all_debrid(db)
        .evict(std::slice::from_ref(&hash))
        .await
        .unwrap()
        .removed;
    assert_eq!(
        removed,
        vec![hash],
        "posse provada + idade + sem hold apaga"
    );
    assert_eq!(paths(&scene), ["/magnet/status", "/magnet/delete"]);
}

/// `readded` (upload do usuário DEPOIS do carimbo + margem): a guarda barra e o
/// motivo ATRAVESSA no `Ok` — sem isso o passo só via “nada removido”.
#[tokio::test]
async fn upload_depois_do_carimbo_conta_readded_no_resultado() {
    let hash = hash_of('r');
    let now = now_ms() as i64;
    // Upload de 1 min, posse de 1 h: o anti-re-add veta ANTES das idades.
    let upload_s = (now - 60_000) / 1000;
    let (addr, scene) = scene_ok(row_dated(55, &hash, "Duna.2021.1080p.mkv", upload_s)).await;
    let (_dir, db) = db_with_at(&[owned(&hash)], now - 3_600_000);
    let _env = EvictEnv::new(addr, "on");

    let outcome = all_debrid(db).evict(&[hash]).await.unwrap();

    assert!(outcome.removed.is_empty(), "`readded` barra a remoção");
    assert_eq!(
        outcome.vetoed.get("readded"),
        Some(&1),
        "o motivo tem de atravessar: {:?}",
        outcome.vetoed
    );
    assert_eq!(paths(&scene), ["/magnet/status"], "nenhum delete tentado");
}

/// Prova mínima que PASSA: posse carimbada de 1 h, upload de 1 h.
fn proof() -> EvictProof {
    const NOW: i64 = 1_700_003_600_000;
    EvictProof {
        upload_date_ms: 1_700_000_000_000.0,
        stamp: Some(1_700_000_000_000),
        in_process_owned: false,
        held: false,
        protected: false,
        blocked: false,
        now: NOW,
        min_age_ms: 1_800_000,
        margin_ms: 600_000,
    }
}

#[test]
fn guarda_exige_prova_e_idade_nas_duas_medidas() {
    assert_eq!(evict_gate(proof()), Ok(()), "1 h nas duas medidas");
    // Upload 20 min DEPOIS da posse (margem de 10 min): re-add do usuário.
    assert_eq!(
        evict_gate(EvictProof {
            upload_date_ms: 1_700_001_200_000.0,
            ..proof()
        }),
        Err(EvictSkip::Readded)
    );
    // Posse e upload recentes: nenhuma das duas idades chega ao piso.
    assert_eq!(
        evict_gate(EvictProof {
            upload_date_ms: 1_700_003_060_000.0,
            stamp: Some(1_700_003_060_000),
            ..proof()
        }),
        Err(EvictSkip::TooYoung)
    );
    // Memo da instância sem `adsub`: sem carimbo não há idade provada.
    assert_eq!(
        evict_gate(EvictProof {
            stamp: None,
            in_process_owned: true,
            ..proof()
        }),
        Err(EvictSkip::NoStamp)
    );
    // Sem uploadDate não há prova de que é o MESMO magnet.
    assert_eq!(
        evict_gate(EvictProof {
            upload_date_ms: 0.0,
            ..proof()
        }),
        Err(EvictSkip::NoUploadDate)
    );
    // `adrm` nega a posse mesmo com carimbo e memo dizendo o contrário.
    assert_eq!(
        evict_gate(EvictProof {
            in_process_owned: true,
            blocked: true,
            ..proof()
        }),
        Err(EvictSkip::ReuploadBlocked)
    );
    // Hold/proteção barram antes de qualquer idade.
    assert_eq!(
        evict_gate(EvictProof {
            held: true,
            ..proof()
        }),
        Err(EvictSkip::Protected)
    );
    // Sem posse nenhuma: nada sai.
    assert_eq!(
        evict_gate(EvictProof {
            stamp: None,
            ..proof()
        }),
        Err(EvictSkip::NoOwnership)
    );
}

#[test]
fn idade_minima_e_margem_so_aceitam_env_valida() {
    assert_eq!(min_age_from(None), 1_800_000, "default do TS");
    assert_eq!(min_age_from(Some("600000")), 600_000);
    assert_eq!(min_age_from(Some(" 0 ")), 0, "zero explícito é opt-out");
    assert_eq!(min_age_from(Some("-5")), 1_800_000, "negativo não é piso");
    assert_eq!(min_age_from(Some("abc")), 1_800_000);
    assert_eq!(margin_from(None), 600_000, "default do TS");
    assert_eq!(margin_from(Some("120000")), 120_000);
    assert_eq!(margin_from(Some("x")), 600_000);
    // As envs do teste são as MESMAS do Node (paridade de rollback).
    assert_eq!(
        EVICT_MIN_AGE_ENV,
        "DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS"
    );
    assert_eq!(EVICT_MARGIN_ENV, "DEBRID_RECONCILE_AGE_MARGIN_MS");
}
