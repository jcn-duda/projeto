use std::cell::RefCell;

use super::*;
use crate::dedup::dedup_tests::{block_on, get, none, row, store_with, ACCOUNT, ADAPTER};

fn wrow(id: &str, hash: &str, size: i64, bucket: &str, imdb: &str) -> Row {
    Row {
        bucket: bucket.into(),
        imdb_id: imdb.into(),
        work_title: "Obra".into(),
        ..row(id, hash, "Obra.mkv", size, 0)
    }
}

fn work(store: &CatalogStore, protected: &dyn Fn(&str) -> bool) -> WorkVersionPlan {
    plan_work_versions(store, ACCOUNT, ADAPTER, protected).unwrap()
}

#[test]
fn work_agrupa_por_imdb_e_prefere_dub() {
    // catalog-work-versions.test.ts: "agrupa por imdbId + temporada + episódio".
    let store = store_with(vec![
        wrow("1", &"a".repeat(40), 5_000_000_000, "dub", "tt1234"),
        wrow("2", &"b".repeat(40), 6_000_000_000, "dual", "tt1234"),
    ]);
    let plan = work(&store, &none);
    assert_eq!(plan.groups.len(), 1);
    assert_eq!(plan.groups[0].imdb_id, "tt1234");
    assert_eq!(plan.groups[0].keep.bucket, "dub");
    assert_eq!(plan.groups[0].kill[0].bucket, "dual");
    assert_eq!(plan.groups[0].recoverable_bytes, 6_000_000_000);
}

#[test]
fn work_separa_temporadas_e_pack() {
    // catalog-work-versions.test.ts: "planWorkVersions separa temporadas e pack".
    let ep = |id: &str, hash: &str, size: i64, bucket: &str, episode: Option<i64>| {
        let mut r = wrow(id, hash, size, bucket, "tt5678");
        r.season = Some(1);
        r.episode = episode;
        r
    };
    let store = store_with(vec![
        ep("10", &"c".repeat(40), 2_000_000_000, "dub", Some(1)),
        ep("11", &"d".repeat(40), 3_000_000_000, "dual", Some(1)),
        ep("12", &"e".repeat(40), 20_000_000_000, "dub", None),
        ep("13", &"f".repeat(40), 18_000_000_000, "lixo", None),
    ]);
    let plan = work(&store, &none);
    assert_eq!(plan.groups.len(), 2, "S01E01 e pack S01");
    assert_eq!(
        plan.groups[0].episode, None,
        "pack vem primeiro: mais bytes"
    );
    assert_eq!(plan.groups[0].season, Some(1));
    assert_eq!(plan.groups[0].kill[0].service_id, "13");
    assert_eq!(plan.groups[1].episode, Some(1));
    assert_eq!(plan.groups[1].recoverable_bytes, 3_000_000_000);
}

#[test]
fn work_exclui_sem_imdb_e_ativa_nunca_sai() {
    // catalog-work-versions.test.ts: "exclui linhas sem imdbId" e "linha ativa nunca sugerida".
    let sem = store_with(vec![
        wrow("20", &"g".repeat(40), 1_000_000_000, "dub", ""),
        wrow("21", &"h".repeat(40), 2_000_000_000, "dual", ""),
    ]);
    let plan = work(&sem, &none);
    assert!(plan.groups.is_empty());
    assert_eq!(plan.without_imdb, 2);

    let mut active = wrow("30", &"i".repeat(40), 5_000_000_000, "dub", "tt9999");
    active.status = "downloading".into();
    let store = store_with(vec![
        active,
        wrow("31", &"j".repeat(40), 4_000_000_000, "dual", "tt9999"),
    ]);
    let plan = work(&store, &none);
    assert_eq!(plan.groups[0].keep.service_id, "30");
    assert_eq!(plan.groups[0].kill[0].service_id, "31");
}

#[test]
fn work_linha_protegida_nunca_sai() {
    // catalog-work-versions.test.ts: "linha protegida nunca sugerida para sair".
    let store = store_with(vec![
        wrow("40", &"k".repeat(40), 3_000_000_000, "lixo", "tt8888"),
        wrow("41", &"l".repeat(40), 4_000_000_000, "dual", "tt8888"),
    ]);
    let plan = work(&store, &none);
    assert_eq!(plan.groups[0].keep.bucket, "dual", "dual vence lixo");
    assert_eq!(plan.groups[0].kill[0].bucket, "lixo");

    let held = "k".repeat(40);
    let protect = |hash: &str| hash == held;
    assert!(
        work(&store, &protect).groups.is_empty(),
        "o lixo protegido não sai"
    );
}

#[test]
fn work_prefere_sem_prova_estrangeira_e_json() {
    let mut foreign = wrow("1", &"a".repeat(40), 9_000_000_000, "dub", "tt1");
    foreign.foreign_proof = "lang:en".into();
    let store = store_with(vec![
        foreign,
        wrow("2", &"b".repeat(40), 1_000_000_000, "dub", "tt1"),
    ]);
    let plan = work(&store, &none);
    assert_eq!(
        plan.groups[0].keep.service_id, "2",
        "sem prova estrangeira vence, mesmo menor"
    );

    let v = serde_json::to_value(&plan).unwrap();
    assert_eq!(v["withoutImdb"], 0);
    assert_eq!(v["groups"][0]["imdbId"], "tt1");
    assert_eq!(v["groups"][0]["workTitle"], "Obra");
    assert_eq!(
        v["groups"][0]["recoverableBytes"], 9_000_000_000i64,
        "sai o estrangeiro de 9 GB"
    );
    assert_eq!(v["groups"][0]["keep"]["foreignProof"], "");
    assert!(v["groups"][0]["keep"]["season"].is_null());
}

// --- apply_deletions ---------------------------------------------------------

fn del(id: &str, hash: &str) -> Deletion {
    Deletion {
        service_id: id.into(),
        hash: hash.into(),
        reason: "duplicado".into(),
        filename: None,
        skip_mark: false,
    }
}

fn removed(id: &str) -> DeleteResponse {
    DeleteResponse {
        ok: 1,
        falhas: vec![],
        removed_ids: Some(vec![id.into()]),
    }
}

#[test]
fn apply_so_o_que_sai_vira_tombstone_falha_fica_viva() {
    // catalog.test.ts: "applyDeletions: só o que o executor remove vira tombstone; falha fica viva".
    let (ha, hb) = ("a".repeat(40), "b".repeat(40));
    let store = store_with(vec![
        row("1", &ha, "Filme 2024 Dublado 1080p", 0, 1000),
        row("2", &hb, "Outro 2024 720p", 0, 2000),
    ]);
    let dels = [del("1", &ha), del("2", &hb)];
    let out = block_on(apply_deletions(
        &store,
        ACCOUNT,
        ADAPTER,
        &dels,
        777,
        |ids: Vec<String>| async move {
            if ids[0] == "1" {
                return Ok(removed("1"));
            }
            let falhas = vec![DeleteFailure {
                message: Some("falhou".into()),
            }];
            Ok(DeleteResponse {
                ok: 0,
                falhas,
                removed_ids: None,
            })
        },
        None,
    ))
    .unwrap();
    assert_eq!(out, DeleteOutcome { ok: 1, falhas: 1 });
    assert_eq!(get(&store, "1").deleted_at, 777);
    assert_eq!(get(&store, "1").delete_reason, "duplicado");
    assert_eq!(get(&store, "2").deleted_at, 0, "o recusado CONTINUA VIVO");
}

#[test]
fn apply_com_executor_que_falha_nao_tomba_nada() {
    let h = "a".repeat(40);
    let store = store_with(vec![
        row("1", &h, "Filme 2024", 0, 1000),
        row("2", &h, "Filme 2024", 0, 2000),
    ]);
    let dels = [del("1", &h), del("2", &h)];
    let calls = RefCell::new(0);
    let out = block_on(apply_deletions(
        &store,
        ACCOUNT,
        ADAPTER,
        &dels,
        5,
        |_: Vec<String>| {
            *calls.borrow_mut() += 1;
            async { Err::<DeleteResponse, String>("rede caiu".into()) }
        },
        None,
    ))
    .unwrap();
    assert_eq!(*calls.borrow(), 2, "uma chamada por deleção");
    assert_eq!(out, DeleteOutcome { ok: 0, falhas: 2 });
    assert_eq!(get(&store, "1").deleted_at, 0);
    assert_eq!(get(&store, "2").deleted_at, 0);
}

#[test]
fn apply_removed_ids_sem_o_id_nao_conta() {
    // removedIds presente exige o id: resposta com outro id é falha.
    let h = "a".repeat(40);
    let store = store_with(vec![row("1", &h, "Filme 2024", 0, 1000)]);
    let dels = [del("1", &h)];
    let out = block_on(apply_deletions(
        &store,
        ACCOUNT,
        ADAPTER,
        &dels,
        5,
        |_: Vec<String>| async { Ok(removed("999")) },
        None,
    ))
    .unwrap();
    assert_eq!(out, DeleteOutcome { ok: 0, falhas: 1 });
    assert_eq!(get(&store, "1").deleted_at, 0);
}

#[test]
fn apply_on_deleted_so_sem_skip_mark() {
    let h = "a".repeat(40);
    let store = store_with(vec![
        row("1", &h, "Filme 2024", 0, 1000),
        row("2", &h, "Filme 2024", 0, 2000),
    ]);
    let mut skipped = del("1", &h);
    skipped.skip_mark = true;
    let mut normal = del("2", &h);
    normal.filename = Some("Filme 2024".into());
    let seen: RefCell<Vec<(String, Option<String>)>> = RefCell::new(Vec::new());
    let hook = |hash: &str, name: Option<&str>| {
        seen.borrow_mut().push((hash.into(), name.map(Into::into)))
    };
    let dels = [skipped, normal];
    let ok_all = |_: Vec<String>| async {
        Ok(DeleteResponse {
            ok: 1,
            falhas: vec![],
            removed_ids: None,
        })
    };
    let out = block_on(apply_deletions(
        &store,
        ACCOUNT,
        ADAPTER,
        &dels,
        9,
        ok_all,
        Some(&hook),
    ))
    .unwrap();
    assert_eq!(out, DeleteOutcome { ok: 2, falhas: 0 });
    assert_eq!(get(&store, "1").deleted_at, 9, "skipMark ainda tombstona");
    assert_eq!(get(&store, "2").deleted_at, 9);
    assert_eq!(seen.into_inner(), vec![(h, Some("Filme 2024".to_string()))]);
}
