use super::*;

#[test]
fn hold_volatil_expira_e_libera() {
    let registry = Holds::new();
    let account = account_scope("conta-do-hold");
    registry.hold(&account, "ABC", Duration::from_millis(30));
    assert!(registry.is_held(&account, "abc"), "hash normalizado");
    std::thread::sleep(Duration::from_millis(40));
    assert!(!registry.is_held(&account, "abc"));
}

#[tokio::test]
async fn hold_do_chamador_e_registro_volatil_protegem() {
    // Conta própria: outro teste não pode soltar o hold global deste.
    const HOLD_KEY: &str = "ad-cleanup-hold-shared";
    let account = account_scope(HOLD_KEY);
    // Hold volátil global: o autofetch em voo protege o hash 'b'.
    hold(&account, &hash_of('b'), Duration::from_secs(60));
    let scene = scene("ab", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            HOLD_KEY,
            &[hash_of('a'), hash_of('b'), hash_of('c')],
            &opts(true, true, Some(&[]), &[hash_of('a').as_str()], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "a (held) e b (volátil) ficam");
    assert_eq!(plan.uncached.len(), 1);
    assert_eq!(plan.uncached[0].hash, hash_of('c'));
    assert_eq!(plan.protected, 2);
    crate::alldebrid_cleanup::release(&account, &hash_of('b'));
}

// ── knownBefore / inventário ────────────────────────────────────────────────

#[tokio::test]
async fn preexistente_do_snapshot_nao_apaga() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let known = [hash_of('a')];
    let report = ad
        .check_cached(
            KEY,
            &[hash_of('a'), hash_of('c')],
            &opts(
                true,
                true,
                Some(&known.iter().map(String::as_str).collect::<Vec<_>>()),
                &[],
                true,
                None,
            ),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "acervo do usuário fica");
    assert_eq!(plan.known_before, 1);
    assert_eq!(plan.uncached.len(), 1);
    assert_eq!(plan.uncached[0].hash, hash_of('c'));
}

#[tokio::test]
async fn inventario_proprio_so_autoriza_com_snapshot() {
    // Conta própria: o snapshot global nasce vazio para esta chave.
    const OWNER: &str = "ad-cleanup-inventory-own";
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            OWNER,
            &[hash_of('a')],
            &opts(true, false, None, &[], true, None),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert_eq!(
        plan.suppressed,
        Some(CleanupSuppressed::InventoryMissing),
        "sem snapshot nesta rodada ninguém sai"
    );
    assert!(report.deleted.is_empty());
    assert_eq!(delete_hits(&scene), 0);
}

#[tokio::test]
async fn inventario_subtrai_adsub_e_submitted() {
    reset_submitted();
    let account = account_scope("ad-inventory-build");
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adsub_key(&account, &hash_of('b'))]);
    let durable = DurablePeek::new(path);
    let scene = scene(
        "",
        &[
            hash_of('a').as_str(),
            hash_of('b').as_str(),
            hash_of('c').as_str(),
        ],
        DeleteMode::Ok,
    );
    let ad = open_scene(scene.clone()).await;
    remember_submitted(&account, &hash_of('c'));
    let inventory = Inventory::new(Duration::from_secs(60));
    let snapshot = inventory
        .load_now(&ad, KEY, &account, Some(&durable))
        .await
        .expect("snapshot");
    assert!(snapshot.contains(&hash_of('a')), "acervo do usuário");
    assert!(!snapshot.contains(&hash_of('b')), "adsub durável é nosso");
    assert!(!snapshot.contains(&hash_of('c')), "submitted é nosso");
}

// ── adprot durável / autofetch ──────────────────────────────────────────────

#[tokio::test]
async fn adprot_duravel_protege_o_acervo_br() {
    const ADPROT_KEY: &str = "ad-cleanup-adprot";
    let account = account_scope(ADPROT_KEY);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adprot_key(&account, &hash_of('a'))]);
    let durable = Arc::new(DurablePeek::new(path));
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            ADPROT_KEY,
            &[hash_of('a'), hash_of('c')],
            &opts(true, true, Some(&[]), &[], true, Some(durable)),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.ready.is_empty(), "adprot segura o pronto");
    assert_eq!(plan.protected, 1);
    assert_eq!(plan.uncached.len(), 1, "o frio novo ainda sai");
}

#[tokio::test]
async fn autofetch_held_e_adprot_nao_saem_por_drop_uncached() {
    const AUTO_KEY: &str = "ad-cleanup-autofetch";
    let account = account_scope(AUTO_KEY);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(dir.path(), &[adprot_key(&account, &hash_of('b'))]);
    let durable = Arc::new(DurablePeek::new(path));
    hold(&account, &hash_of('b'), Duration::from_secs(60));
    let scene = scene("", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let report = ad
        .check_cached(
            AUTO_KEY,
            &[hash_of('b')],
            &opts(false, true, Some(&[]), &[], true, Some(durable)),
        )
        .await
        .unwrap();
    let plan = report.cleanup.expect("plano");
    assert!(plan.uncached.is_empty(), "download do autofetch fica");
    assert_eq!(plan.protected, 1);
    assert_eq!(delete_hits(&scene), 0);
    crate::alldebrid_cleanup::release(&account, &hash_of('b'));
}

// ── dropReady / dropUncached ────────────────────────────────────────────────

#[tokio::test]
async fn drop_ready_e_drop_uncached_seguem_as_flags() {
    let scene = scene("a", &[], DeleteMode::Ok);
    let ad = open_scene(scene.clone()).await;
    let hashes = [hash_of('a'), hash_of('c')];

    let both = ad
        .check_cached(KEY, &hashes, &opts(true, true, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert_eq!(both.ready.len(), 1);
    assert_eq!(both.uncached.len(), 1);

    let ready_only = ad
        .check_cached(KEY, &hashes, &opts(true, false, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert_eq!(ready_only.ready.len(), 1);
    assert!(ready_only.uncached.is_empty());

    let uncached_only = ad
        .check_cached(KEY, &hashes, &opts(false, true, Some(&[]), &[], true, None))
        .await
        .unwrap()
        .cleanup
        .unwrap();
    assert!(uncached_only.ready.is_empty());
    assert_eq!(uncached_only.uncached.len(), 1);
}

#[test]
fn classify_drop_fecha_o_fail_safe() {
    let account = "conta-classify";
    let gate = crate::alldebrid_cleanup::CleanupGate::new(
        true,
        true,
        true,
        HashSet::from(["aaa".to_string()]),
        None,
        account,
    );
    let empty = HashSet::new();
    let snapshot = HashSet::from(["bbb".to_string()]);
    assert_eq!(
        classify(&gate, None, "ccc"),
        DropVerdict::NoInventory,
        "sem inventário ninguém sai"
    );
    assert_eq!(
        classify(&gate, Some(&snapshot), "bbb"),
        DropVerdict::KnownBefore
    );
    assert_eq!(classify(&gate, Some(&empty), "aaa"), DropVerdict::Protected);
    assert!(matches!(
        classify(&gate, Some(&empty), "ccc"),
        DropVerdict::Delete(_)
    ));
}

fn classify(
    gate: &crate::alldebrid_cleanup::CleanupGate,
    inventory: Option<&HashSet<String>>,
    hash: &str,
) -> DropVerdict {
    crate::alldebrid_cleanup::classify_drop(gate, inventory, hash, "7", 0)
}
