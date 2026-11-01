//! Testes do export NDJSON: forma byte-fiel das linhas (ordem de chaves e
//! números 0/1, como o `JSON.stringify` do TS), paginação por hash e o
//! roundtrip export → import → export estável via o próprio `import_ndjson`.

use std::io::Cursor;

use crate::MagnetBankStore;

fn hash(c: char) -> String {
    c.to_string().repeat(40)
}

fn insert_magnet(store: &MagnetBankStore, h: &str, title: &str, last_seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet (hash, uri, title, size, is_br, dubbed, quality, \
         seeders_max, seeders_last, first_seen, last_seen, lied) VALUES \
         ('{h}', 'magnet:?xt=urn:btih:{h}&dn=T', '{title}', 123, 1, 0, '1080p', 10, 3, 100, {last_seen}, 0)"
    ));
}

fn insert_source(store: &MagnetBankStore, h: &str, indexer: &str, last_seen: i64) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_source (hash, indexer, tracker, first_seen, last_seen, seeders_last) \
         VALUES ('{h}', '{indexer}', 'tracker.example', 100, {last_seen}, 3)"
    ));
}

fn insert_work(
    store: &MagnetBankStore,
    h: &str,
    imdb: &str,
    season: i64,
    episode: i64,
    passed: i64,
    last_seen: i64,
) {
    store.exec_fixture(&format!(
        "INSERT INTO magnet_work (hash, imdb, season, episode, first_seen, last_seen, passed_filter) \
         VALUES ('{h}', '{imdb}', {season}, {episode}, 100, {last_seen}, {passed})"
    ));
}

fn export(store: &MagnetBankStore, now: i64) -> String {
    let mut blob: Vec<u8> = Vec::new();
    store.export_ndjson_into(&mut blob, now).unwrap();
    String::from_utf8(blob).unwrap()
}

#[test]
fn export_banco_vazio_e_so_o_cabecalho() {
    let store = MagnetBankStore::open_memory().unwrap();
    let out = export(&store, 42);
    assert_eq!(out.lines().count(), 1, "sem registros não há segunda linha");
    assert_eq!(
        out,
        "{\"t\":\"meta\",\"format\":\"adom-magnet-bank\",\"v\":1,\"exportedAt\":42,\
         \"engine\":\"sql\",\"counts\":{\"magnets\":0,\"sources\":0,\"works\":0}}\n",
        "cabeçalho byte-fiel: t/format/v/exportedAt/engine/counts nessa ordem"
    );
}

#[test]
fn export_linhas_byte_fiel_na_ordem_do_json_stringify() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('a');
    insert_magnet(&store, &h, "Filme A", 2500);
    insert_source(&store, &h, "bludv", 2200);
    insert_work(&store, &h, "tt0000001", 1, -1, 1, 2500);

    let out = export(&store, 1_700_000_000_000);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 4, "header + magnet + sua fonte + sua obra");
    assert_eq!(
        lines[1],
        format!(
            "{{\"t\":\"m\",\"hash\":\"{h}\",\"uri\":\"magnet:?xt=urn:btih:{h}&dn=T\",\
         \"title\":\"Filme A\",\"size\":123,\"isBr\":1,\"dubbed\":0,\"quality\":\"1080p\",\
         \"seedersMax\":10,\"seedersLast\":3,\"firstSeen\":100,\"lastSeen\":2500,\"lied\":0}}"
        ),
        "registro m: flags numéricas e chaves na ordem do schema"
    );
    assert_eq!(
        lines[2],
        format!(
            "{{\"t\":\"s\",\"hash\":\"{h}\",\"indexer\":\"bludv\",\"tracker\":\"tracker.example\",\
         \"firstSeen\":100,\"lastSeen\":2200,\"seedersLast\":3}}"
        )
    );
    assert_eq!(
        lines[3],
        format!(
            "{{\"t\":\"w\",\"hash\":\"{h}\",\"imdb\":\"tt0000001\",\"season\":1,\"episode\":-1,\
         \"firstSeen\":100,\"lastSeen\":2500,\"passedFilter\":1}}"
        )
    );
}

#[test]
fn export_pagina_por_hash_e_completa() {
    let store = MagnetBankStore::open_memory().unwrap();
    // 520 magnets > PAGE (500): o export só é completo se o keyset continuar.
    let mut sql = String::from("INSERT INTO magnet (hash, uri, title) VALUES ");
    for i in 0..520u64 {
        if i > 0 {
            sql.push(',');
        }
        let h = format!("{i:040x}");
        sql.push_str(&format!("('{h}', 'magnet:?xt=urn:btih:{h}', 'T{i}')"));
    }
    store.exec_fixture(&sql);

    let out = export(&store, 7);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 1 + 520, "todas as páginas foram exportadas");
    assert!(
        lines[1].contains(&format!("\"hash\":\"{:040x}\"", 0u64)),
        "keyset abre no menor hash"
    );
    assert!(
        lines[520].contains(&format!("\"hash\":\"{:040x}\"", 519u64)),
        "termina no maior hash"
    );
}

#[test]
fn roundtrip_export_import_export_estavel() {
    let a = MagnetBankStore::open_memory().unwrap();
    // Acervo variado: 3 magnets (um SEM uri), 2 fontes (um magnet com 2), 2 obras
    // (uma com temporada/episódio reais e outra global -1).
    let (h1, h2, h3) = (hash('a'), hash('b'), hash('c'));
    insert_magnet(&a, &h1, "Filme Um 2024", 2500);
    insert_magnet(&a, &h2, "Filme Dois 2024", 1000);
    a.exec_fixture(&format!(
        "INSERT INTO magnet (hash, uri, title, size, is_br, dubbed, quality, \
         seeders_max, seeders_last, first_seen, last_seen, lied) VALUES \
         ('{h3}', '', 'Sem URI', 0, 0, 0, '', 0, 0, 0, 500, 1)"
    ));
    insert_source(&a, &h1, "bludv", 2200);
    insert_source(&a, &h1, "redetorrent", 3000);
    insert_work(&a, &h1, "tt0000001", 1, 2, 1, 2500);
    insert_work(&a, &h2, "tt0000002", -1, -1, 0, 1000);

    let blob = export(&a, 1_700_000_000_000);

    let b = MagnetBankStore::open_memory().unwrap();
    let report = b.import_ndjson(Cursor::new(&blob)).unwrap();
    assert!(
        report.ok,
        "o import aceita o próprio export: {:?}",
        report.error
    );
    assert_eq!(report.magnets.inserted, 3);
    assert_eq!(report.sources.inserted, 2);
    assert_eq!(report.works.inserted, 2);
    assert_eq!(report.rejected, 0);

    let again = export(&b, 1_700_000_000_000);
    assert_eq!(
        again, blob,
        "export → import → export é estável byte a byte"
    );

    // E o reimport do segundo arquivo num banco novo também é idempotente.
    let c = MagnetBankStore::open_memory().unwrap();
    let report = c.import_ndjson(Cursor::new(&again)).unwrap();
    assert!(report.ok);
    assert_eq!(report.magnets.inserted, 3);
}
