use super::tests_support::*;
use super::*;

#[test]
fn ordena_por_passed_filter_seeders_e_last_seen() {
    let h1 = "1".repeat(40);
    let h2 = "2".repeat(40);
    let h3 = "3".repeat(40);
    let h4 = "4".repeat(40);
    let mut input = base();
    input.all_failed = true;
    input.per_indexer_max = 1;
    input.sources = sources(&[(&h1, &["a"]), (&h2, &["a"]), (&h3, &["b"]), (&h4, &["b"])]);
    input.works = vec![
        work(&h1, 0, 10, magnet(&h1, "Filme Teste H1", 100, 100)),
        work(&h2, 1, 20, magnet(&h2, "Filme Teste H2", 1, 1)),
        work(&h3, 1, 30, magnet(&h3, "Filme Teste H3", 5, 5)),
        work(&h4, 1, 40, magnet(&h4, "Filme Teste H4", 9, 9)),
    ];

    let out = collect_fallback(&input);
    let order: Vec<&str> = out.items.iter().map(|i| i.info_hash.as_str()).collect();
    assert_eq!(order, [h4.as_str(), h2.as_str()]);
    assert_eq!(out.cut.get("cap-indexer"), Some(&2));
}

#[test]
fn last_seen_desempata_quando_tudo_mais_e_igual() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let mut input = base();
    input.failed = set(&["bludv"]);
    input.sources = sources(&[(&a, &["bludv"]), (&b, &["bludv"])]);
    let mut ma = magnet(&a, "Filme Teste A", 5, 5);
    ma.last_seen = 10;
    let mut mb = magnet(&b, "Filme Teste B", 5, 5);
    mb.last_seen = 20;
    input.works = vec![work(&a, 1, 10, ma), work(&b, 1, 20, mb)];

    let out = collect_fallback(&input);
    assert_eq!(
        out.items
            .iter()
            .map(|i| i.info_hash.as_str())
            .collect::<Vec<_>>(),
        [b.as_str(), a.as_str()]
    );
}

#[test]
fn teto_global_corta_depois_da_ordenacao() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let mut input = base();
    input.all_failed = true;
    input.global_max = 2;
    input.sources = sources(&[(&a, &["a"]), (&b, &["b"]), (&c, &["c"])]);
    input.works = vec![
        work(&a, 1, 10, magnet(&a, "Filme Teste A", 1, 1)),
        work(&b, 1, 20, magnet(&b, "Filme Teste B", 5, 5)),
        work(&c, 1, 30, magnet(&c, "Filme Teste C", 9, 9)),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 2);
    assert_eq!(
        out.items
            .iter()
            .map(|i| i.info_hash.as_str())
            .collect::<Vec<_>>(),
        [c.as_str(), b.as_str()]
    );
    assert_eq!(out.cut.get("cap-global"), Some(&1));
}

#[test]
fn dedupe_por_hash_mantem_a_primeira_obra() {
    let a = "a".repeat(40);
    let mut input = base();
    input.suspect = set(&["bludv"]);
    input.sources = sources(&[(&a, &["bludv"])]);
    input.works = vec![
        // Primeira linha do hash manda, como o `Map` do TS — mesmo que a
        // segunda tivesse passed_filter=1.
        work(&a, 0, 30, magnet(&a, "Filme Teste 2024", 9, 9)),
        work(&a, 1, 10, magnet(&a, "Filme Teste 2024", 9, 9)),
    ];

    let out = collect_fallback(&input);
    assert_eq!(out.injected(), 0);
    assert_eq!(out.cut.get("no-source"), Some(&1));
}

#[test]
fn fallback_fetchable_vem_de_passed_filter_ou_index_only() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let mut input = base();
    input.all_failed = true;
    input.index_only_indexers = vec!["IndexOnly".to_string()];
    input.sources = sources(&[(&a, &["a"]), (&b, &["indexonly"]), (&c, &["c"])]);
    input.works = vec![
        work(&a, 1, 30, magnet(&a, "Filme Teste A", 3, 3)),
        work(&b, 0, 20, magnet(&b, "Filme Teste B", 2, 2)),
        work(&c, 0, 10, magnet(&c, "Filme Teste C", 1, 1)),
    ];

    let out = collect_fallback(&input);
    let flags: Vec<bool> = out
        .items
        .iter()
        .map(|item| item.fallback_fetchable)
        .collect();
    assert_eq!(flags, [true, true, false]);
}

#[test]
fn origem_br_vem_da_fonte_br_ou_do_titulo() {
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let c = "c".repeat(40);
    let mut input = base();
    input.failed = set(&["bludv", "outro"]);
    input.br_indexers = vec!["BLUDV".to_string()];
    input.sources = sources(&[(&a, &["bludv"]), (&b, &["outro"]), (&c, &["outro"])]);
    input.works = vec![
        work(&a, 1, 30, magnet(&a, "Filme Teste A", 1, 1)),
        work(&b, 1, 20, magnet(&b, "Filme Teste B Dublado", 1, 1)),
        work(&c, 1, 10, magnet(&c, "Filme Teste C", 1, 1)),
    ];

    let out = collect_fallback(&input);
    let br: Vec<bool> = out.items.iter().map(|item| item.is_br).collect();
    assert_eq!(br, [true, true, false]);
}

#[test]
fn campos_do_raw_item_seguem_o_to_raw_item_do_ts() {
    let a = "a".repeat(40);
    let mut input = base();
    input.failed = set(&["bludv"]);
    input.sources = sources(&[(&a, &["bludv"])]);
    let mut row = magnet(&a, "", 0, 0);
    row.uri = format!("https://exemplo/{a}");
    row.size = 0;
    input.works = vec![work(&a, 1, 10, row)];

    let out = collect_fallback(&input);
    let item = &out.items[0];
    assert_eq!(item.title, "Torrent");
    assert_eq!(item.magnet, None, "URI fora de magnet: não vira magnet");
    assert_eq!(item.size, None, "tamanho sentinela 0 não entra");
    assert_eq!(item.seeders, 0);
}
