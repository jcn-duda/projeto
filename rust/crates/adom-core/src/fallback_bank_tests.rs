use super::tests_support::*;
use super::*;

#[test]
fn fonte_fora_do_pedido_nao_elegivel_mesmo_em_all_failed() {
    let a = "a".repeat(40);
    let mut input = base();
    // `/all` falho aceitaria qualquer fonte do banco, mas o veredito de
    // `allowedSourceIndexer` do pedido (config do runtime) vem ANTES.
    input.all_failed = true;
    let mut blocked = source("fora-do-ji", 1);
    blocked.allowed = false;
    input.sources.insert(a.clone(), vec![blocked]);
    input.works = vec![work(&a, 1, 10, magnet(&a, "Filme Teste 2024", 1, 1))];

    let out = collect_fallback(&input);
    assert_eq!(
        out.injected(),
        0,
        "fonte não permitida não pode entrar pela falha"
    );
    assert_eq!(out.cut.get("no-source"), Some(&1));
}

#[test]
fn fonte_nao_permitida_nao_esconde_a_permitida_do_mesmo_hash() {
    let a = "a".repeat(40);
    let mut input = base();
    input.failed = set(&["bludv"]);
    let mut blocked = source("fora-do-ji", 1);
    blocked.allowed = false;
    input
        .sources
        .insert(a.clone(), vec![blocked, source("bludv", 2)]);
    input.works = vec![work(&a, 1, 10, magnet(&a, "Filme Teste 2024", 1, 1))];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 1);
    assert_eq!(out.items[0].indexer, "bludv");
}

#[test]
fn falha_ou_pendente_injeta_reserva_do_indexer_indisponivel() {
    let a = "a".repeat(40);
    let mut input = base();
    // Pendente no prazo é o mesmo conjunto do falho (`failedIndexers()`).
    input.failed = set(&["bludv", "pendente"]);
    input.sources = sources(&[(&a, &["bludv", "outro"])]);
    input.works = vec![work(
        &a,
        1,
        10,
        magnet(&a, "Filme Teste 2024 1080p DUBLADO", 9, 7),
    )];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 1);
    let item = &out.items[0];
    assert_eq!(item.indexer, "bludv");
    assert_eq!(item.seeders, 7, "seedersLast real, nunca seedersMax");
    assert_eq!(item.info_hash, a);
    assert!(item.is_br, "título DUBLADO liga a origem BR");
    assert!(item.fallback_fetchable);
    assert_eq!(item.tracker, "");
}

#[test]
fn suspeito_so_cobre_obra_com_passed_filter() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let mut input = base();
    input.suspect = set(&["bludv"]);
    input.sources = sources(&[(&a, &["bludv"]), (&b, &["bludv"])]);
    input.works = vec![
        work(&a, 1, 10, magnet(&a, "Filme Teste 2024 1080p", 1, 1)),
        work(&b, 0, 20, magnet(&b, "Filme Teste 2024 1080p", 1, 1)),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 1);
    assert_eq!(out.items[0].info_hash, a);
    assert_eq!(out.cut.get("no-source"), Some(&1));
}

#[test]
fn suspeito_sem_falha_ainda_pede_banco_mas_so_aprovado_entra() {
    let a = "a".repeat(40);
    let mut input = base();
    input.suspect = set(&["bludv"]);
    input.sources = sources(&[(&a, &["bludv"])]);
    input.works = vec![work(&a, 0, 10, magnet(&a, "Filme Teste 2024 1080p", 1, 1))];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 0);
    assert_eq!(out.cut.get("no-source"), Some(&1));
}

#[test]
fn all_failed_aceita_qualquer_fonte_do_banco() {
    let a = "a".repeat(40);
    let mut input = base();
    input.all_failed = true;
    input.sources = sources(&[(&a, &["outro"])]);
    input.works = vec![work(&a, 0, 10, magnet(&a, "Filme Teste 2024 1080p", 3, 3))];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 1);
    assert_eq!(out.items[0].indexer, "outro");
    assert!(!out.items[0].fallback_fetchable, "pf=0 e fonte comum");
}

#[test]
fn sem_falha_nem_suspeita_ou_desligado_nao_injeta() {
    let a = "a".repeat(40);
    let mut input = base();
    input.sources = sources(&[(&a, &["bludv"])]);
    input.works = vec![work(&a, 1, 10, magnet(&a, "Filme Teste 2024", 1, 1))];
    assert_eq!(collect_fallback(&input).injected(), 0, "nenhum-live");

    input.failed = set(&["bludv"]);
    input.enabled = false;
    assert_eq!(collect_fallback(&input).injected(), 0, "kill-switch geral");

    input.enabled = true;
    input.fallback_enabled = false;
    assert_eq!(
        collect_fallback(&input).injected(),
        0,
        "kill-switch do fallback"
    );
}

#[test]
fn hash_do_lote_vivo_vence_antes_dos_tetos() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let mut input = base();
    input.failed = set(&["bludv"]);
    input.live_hashes = set(&[a.as_str()]);
    input.sources = sources(&[(&a, &["bludv"]), (&b, &["bludv"])]);
    input.works = vec![
        work(&a, 1, 30, magnet(&a, "Filme Teste 2024 A", 99, 99)),
        work(&b, 1, 10, magnet(&b, "Filme Teste 2024 B", 1, 1)),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 1);
    assert_eq!(out.items[0].info_hash, b);
    assert_eq!(out.cut.get("live-dedupe"), Some(&1));
}

#[test]
fn episodio_fora_do_pedido_e_cortado_antes_dos_tetos() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let d = "d".repeat(40);
    let e = "e".repeat(40);
    let mut input = base();
    input.work_target = WorkTarget {
        season: Some(2),
        episode: Some(3),
    };
    input.all_failed = true;
    input.sources = sources(&[
        (&a, &["bludv"]),
        (&b, &["bludv"]),
        (&c, &["bludv"]),
        (&d, &["bludv"]),
        (&e, &["bludv"]),
    ]);
    let mut dn_trap = magnet(&e, "Serie Exemplo S02 1080p", 1, 1);
    dn_trap.uri = format!("magnet:?xt=urn:btih:{e}&dn=Serie.Exemplo.S01E01.1080p");
    input.works = vec![
        work(&a, 1, 10, magnet(&a, "Serie Exemplo S01E01 1080p", 1, 1)),
        work(&b, 1, 10, magnet(&b, "Serie Exemplo S02E03 1080p", 1, 1)),
        work(&c, 1, 10, magnet(&c, "Serie Exemplo S02 1080p", 1, 1)),
        work(&d, 1, 10, magnet(&d, "Serie Exemplo Completa 1080p", 1, 1)),
        work(&e, 1, 10, dn_trap),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 3, "E02E03 + pack S02 + série completa");
    assert_eq!(out.cut.get("episode-mismatch"), Some(&2));
    let hashes: Vec<&str> = out.items.iter().map(|i| i.info_hash.as_str()).collect();
    assert!(hashes.contains(&b.as_str()));
    assert!(hashes.contains(&c.as_str()));
    assert!(hashes.contains(&d.as_str()));
}

#[test]
fn lie_e_linha_sem_hash_saem_antes_dos_tetos() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let mut input = base();
    input.all_failed = true;
    input.sources = sources(&[(&a, &["bludv"]), (&b, &["bludv"])]);
    let mut lied = magnet(&a, "Filme Teste 2024", 1, 1);
    lied.lied = true;
    input.works = vec![
        work(&a, 1, 10, lied),
        FallbackWork {
            hash: b.clone(),
            passed_filter: 1,
            last_seen: 10,
            magnet: None,
        },
        work(&b, 1, 10, magnet("", "Filme Teste 2024", 1, 1)),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 0);
    assert_eq!(out.cut.get("lied"), Some(&1));
    assert_eq!(out.cut.get("no-hash"), Some(&2));
}
