//! Testes do import NDJSON e do backfill (`magnet_bank_import.rs`). Banco em
//! memória com o schema real; as asserções leem as tabelas direto.

use serde_json::{json, Value};

use super::ImportReport;
use crate::magnet_bank::MagnetBankStore;

fn hash(c: char) -> String {
    c.to_string().repeat(40)
}

/// Cabeçalho válido seguido das linhas dadas, uma por linha do NDJSON.
fn file(lines: &[Value]) -> Vec<u8> {
    let mut text = String::from(r#"{"t":"meta","format":"adom-magnet-bank","v":1}"#);
    for line in lines {
        text.push('\n');
        text.push_str(&line.to_string());
    }
    text.into_bytes()
}

/// Junta os campos extras num objeto base (só para não repetir o hash).
fn with(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Value::Object(extra)) = (base.as_object_mut(), extra) {
        base.extend(extra);
    }
    base
}

fn magnet(h: &str, extra: Value) -> Value {
    with(
        json!({"t": "m", "hash": h, "title": "Filme A", "firstSeen": 1000, "lastSeen": 2000}),
        extra,
    )
}

fn import(store: &MagnetBankStore, bytes: &[u8]) -> ImportReport {
    store.import_ndjson(bytes).expect("io do import")
}

/// Conteúdo das tabelas em forma comparável (ordem fixa pelo SQL).
fn dump(store: &MagnetBankStore) -> Vec<String> {
    let mut out = Vec::new();
    let conn = store.lock();
    for sql in [
        "SELECT * FROM magnet ORDER BY hash",
        "SELECT * FROM magnet_source ORDER BY hash, indexer",
        "SELECT * FROM magnet_work ORDER BY hash, imdb, season, episode",
    ] {
        let mut stmt = conn.prepare(sql).unwrap();
        let cols = stmt.column_count();
        let rows = stmt
            .query_map([], |row| {
                let mut parts = Vec::new();
                for i in 0..cols {
                    parts.push(format!("{:?}", row.get::<_, rusqlite::types::Value>(i)?));
                }
                Ok(parts.join("|"))
            })
            .unwrap();
        out.extend(rows.map(Result::unwrap));
    }
    out
}

#[test]
fn recusa_arquivo_sem_cabecalho() {
    let store = MagnetBankStore::open_memory().unwrap();
    let body = format!(r#"{{"t":"m","hash":"{}"}}"#, hash('1'));
    let report = import(&store, body.as_bytes());
    assert!(!report.ok);
    assert_eq!(
        report.error.as_deref(),
        Some("cabeçalho ausente: o arquivo não é um export do banco de magnets")
    );
}

#[test]
fn recusa_linha_que_nao_e_json_antes_do_cabecalho() {
    let store = MagnetBankStore::open_memory().unwrap();
    let report = import(&store, "isto não é json\n".as_bytes());
    assert!(!report.ok);
    assert_eq!(
        report.error.as_deref(),
        Some("arquivo não é NDJSON do banco de magnets")
    );
}

#[test]
fn recusa_versao_diferente_de_um() {
    let store = MagnetBankStore::open_memory().unwrap();
    let body = r#"{"t":"meta","format":"adom-magnet-bank","v":2}"#;
    let report = import(&store, body.as_bytes());
    assert!(!report.ok);
    assert_eq!(
        report.error.as_deref(),
        Some("versão do arquivo não suportada (2)")
    );
    // Igualdade estrita, como o TS: a versão em texto também é recusada.
    let text = r#"{"t":"meta","format":"adom-magnet-bank","v":"1"}"#;
    assert!(!import(&store, text.as_bytes()).ok);
}

#[test]
fn recusa_arquivo_vazio_sem_contar_linhas() {
    let store = MagnetBankStore::open_memory().unwrap();
    let report = import(&store, b"\n   \n");
    assert!(!report.ok);
    assert_eq!(report.error.as_deref(), Some("arquivo vazio"));
    assert_eq!(report.lines, 0);
}

#[test]
fn import_simples_conta_inserted() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('1');
    let bytes = file(&[
        magnet(&h, json!({"uri": format!("magnet:?xt=urn:btih:{h}&dn=Filme")})),
        json!({"t": "s", "hash": h, "indexer": "bludv", "tracker": "t1", "firstSeen": 1000, "lastSeen": 2000, "seedersLast": 3}),
        json!({"t": "w", "hash": h, "imdb": "tt0000001", "firstSeen": 1000, "lastSeen": 2000, "passedFilter": 1}),
    ]);
    let report = import(&store, &bytes);
    assert!(report.ok, "{report:?}");
    assert_eq!(report.error, None);
    assert_eq!(report.lines, 4);
    assert_eq!(report.rejected, 0);
    assert_eq!(report.magnets.read, 1);
    assert_eq!(report.magnets.inserted, 1);
    assert_eq!(report.magnets.merged, 0);
    assert_eq!(report.sources.inserted, 1);
    assert_eq!(report.works.inserted, 1);
    let title: String = store
        .lock()
        .query_row("SELECT title FROM magnet WHERE hash = ?1", [&h], |r| r.get(0))
        .unwrap();
    assert_eq!(title, "Filme A");
}

#[test]
fn reimportar_o_mesmo_arquivo_nao_muda_o_banco() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('2');
    let bytes = file(&[
        magnet(&h, json!({"seedersMax": 4, "seedersLast": 2})),
        json!({"t": "s", "hash": h, "indexer": "bludv", "lastSeen": 2000}),
        json!({"t": "w", "hash": h, "imdb": "tt0000002", "lastSeen": 2000, "passedFilter": 1}),
    ]);
    import(&store, &bytes);
    let before = dump(&store);
    let again = import(&store, &bytes);
    assert!(again.ok);
    assert_eq!(again.magnets.inserted, 0);
    assert_eq!(again.magnets.merged, 1);
    assert_eq!(again.sources.merged, 1);
    assert_eq!(again.works.merged, 1);
    assert_eq!(dump(&store), before);
}

#[test]
fn mescla_magnet_pelas_regras_do_banco() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('3');
    let first = file(&[
        magnet(
            &h,
            json!({"firstSeen": 1000, "lastSeen": 2000, "seedersMax": 10, "seedersLast": 5}),
        ),
        json!({"t": "w", "hash": h, "imdb": "tt0000003", "firstSeen": 1000, "lastSeen": 2000, "passedFilter": 1}),
    ]);
    import(&store, &first);

    // Arquivo novo: data mais antiga, observação mais nova, URI com dn=, flags
    // ligadas e título diferente (o local já existe e NÃO troca).
    let second = file(&[
        with(
            magnet(
                &h,
                json!({"firstSeen": 500, "lastSeen": 3000, "seedersMax": 7, "seedersLast": 9,
                       "isBr": true, "dubbed": 1, "lied": 1, "title": "Outro título"}),
            ),
            json!({"uri": format!("magnet:?xt=urn:btih:{h}&dn=Filme+A")}),
        ),
        json!({"t": "w", "hash": h, "imdb": "tt0000003", "firstSeen": 1500, "lastSeen": 1500, "passedFilter": 0}),
    ]);
    let report = import(&store, &second);
    assert!(report.ok);
    assert_eq!(report.magnets.merged, 1);

    let (uri, title, first_seen, last_seen, seeders_max, seeders_last, is_br, dubbed, lied): (
        String,
        String,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
    ) = store
        .lock()
        .query_row(
            "SELECT uri, title, first_seen, last_seen, seeders_max, seeders_last, is_br, dubbed, lied \
             FROM magnet WHERE hash = ?1",
            [&h],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            },
        )
        .unwrap();
    assert!(uri.contains("&dn=Filme+A"), "URI mais rica deveria vencer: {uri}");
    assert_eq!(title, "Filme A", "o título do banco não troca no import");
    assert_eq!(first_seen, 500, "first_seen é o mais antigo");
    assert_eq!(last_seen, 3000, "last_seen é o mais novo");
    assert_eq!(seeders_max, 10, "seeders_max é o máximo");
    assert_eq!(seeders_last, 9, "seeders_last vem da observação mais nova");
    assert_eq!((is_br, dubbed, lied), (1, 1, 1), "flags só sobem");

    // Obra: a observação de `last_seen` 1500 é mais velha que a local (2000),
    // então o `passed_filter` 1 do banco fica.
    let (passed, w_first, w_last): (i64, i64, i64) = store
        .lock()
        .query_row(
            "SELECT passed_filter, first_seen, last_seen FROM magnet_work WHERE hash = ?1",
            [&h],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((passed, w_first, w_last), (1, 1000, 2000));
}

#[test]
fn passed_filter_segue_a_ultima_observacao_e_empate_preserva_o_local() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('4');
    import(
        &store,
        &file(&[
            magnet(&h, json!({})),
            json!({"t": "w", "hash": h, "imdb": "tt0000004", "lastSeen": 2000, "passedFilter": 1}),
        ]),
    );
    // Empate de `last_seen`: o local (1) é preservado mesmo com 0 no arquivo.
    import(
        &store,
        &file(&[
            magnet(&h, json!({})),
            json!({"t": "w", "hash": h, "imdb": "tt0000004", "lastSeen": 2000, "passedFilter": 0}),
        ]),
    );
    let passed = |store: &MagnetBankStore| -> i64 {
        store
            .lock()
            .query_row("SELECT passed_filter FROM magnet_work WHERE hash = ?1", [&h], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(passed(&store), 1);
    // Observação mais nova com 0: essa vence (é a última verdade da obra).
    import(
        &store,
        &file(&[
            magnet(&h, json!({})),
            json!({"t": "w", "hash": h, "imdb": "tt0000004", "lastSeen": 2500, "passedFilter": 0}),
        ]),
    );
    assert_eq!(passed(&store), 0);
}

#[test]
fn rejeita_fonte_e_obra_orfas() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('5');
    let report = import(
        &store,
        &file(&[
            json!({"t": "s", "hash": h, "indexer": "bludv"}),
            json!({"t": "w", "hash": h, "imdb": "tt0000005"}),
        ]),
    );
    assert!(report.ok);
    assert_eq!(report.rejected, 2);
    assert_eq!(report.sources.read, 1, "lida, mas órfã não é gravada");
    assert_eq!(report.sources.inserted, 0);
    assert_eq!(report.works.inserted, 0);
    let count: i64 = store
        .lock()
        .query_row("SELECT COUNT(*) FROM magnet_source", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn rejeita_registro_invalido_e_mantem_o_resto() {
    let store = MagnetBankStore::open_memory().unwrap();
    let good = hash('6');
    let report = import(
        &store,
        &file(&[
            json!({"t": "m", "hash": "nao-e-hash", "title": "x"}),
            json!({"t": "s", "hash": good, "indexer": ""}),
            json!({"t": "w", "hash": good, "imdb": "abc"}),
            json!({"t": "zzz"}),
            magnet(&good, json!({"uri": "https://nao-e-magnet"})),
        ]),
    );
    assert!(report.ok);
    assert_eq!(report.rejected, 4);
    assert_eq!(report.magnets.read, 1);
    // URI que não é magnet não derruba o registro: vira vazia.
    let uri: String = store
        .lock()
        .query_row("SELECT uri FROM magnet WHERE hash = ?1", [&good], |r| r.get(0))
        .unwrap();
    assert_eq!(uri, "");
}

#[test]
fn linha_invalida_depois_do_cabecalho_conta_e_segue() {
    let store = MagnetBankStore::open_memory().unwrap();
    let h = hash('7');
    let mut bytes = file(&[]);
    bytes.extend_from_slice(b"\n{nao json");
    bytes.extend_from_slice(format!("\n{}", magnet(&h, json!({}))).as_bytes());
    let report = import(&store, &bytes);
    assert!(report.ok);
    assert_eq!(report.rejected, 1);
    assert_eq!(report.magnets.inserted, 1);
}

#[test]
fn lotes_de_duzentos_magnets_gravam_todos() {
    let store = MagnetBankStore::open_memory().unwrap();
    let lines: Vec<Value> = (0..205)
        .map(|i| magnet(&format!("{:040x}", i + 1), json!({})))
        .collect();
    let report = import(&store, &file(&lines));
    assert!(report.ok);
    assert_eq!(report.magnets.read, 205);
    assert_eq!(report.magnets.inserted, 205);
    let count: i64 = store
        .lock()
        .query_row("SELECT COUNT(*) FROM magnet", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 205);
}

#[test]
fn backfill_preenche_quality_e_nao_rebaixa_dubbed() {
    let store = MagnetBankStore::open_memory().unwrap();
    store.exec_fixture(&format!(
        "INSERT INTO magnet (hash, title, is_br, dubbed, quality) VALUES \
         ('{}', 'Coringa (2019) [720p WEB-DL DUBLADO]', 1, 0, ''), \
         ('{}', 'Joker.2019.1080p.WEB-DL.DUAL', 0, 0, ''), \
         ('{}', 'Algo sem nada', 0, 1, ''), \
         ('{}', 'Já preenchido 2160p', 0, 0, '2160p');",
        hash('1'),
        hash('2'),
        hash('3'),
        hash('4'),
    ));
    // Lote pequeno para cruzar a paginação por rowid.
    assert_eq!(store.backfill_classification(2).unwrap(), 3);

    let rows: Vec<(String, i64, String)> = {
        let conn = store.lock();
        let mut stmt = conn
            .prepare("SELECT hash, dubbed, quality FROM magnet ORDER BY hash")
            .unwrap();
        let mapped = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap();
        mapped.map(Result::unwrap).collect()
    };
    let by_prefix = |c: char| rows.iter().find(|row| row.0.starts_with(c)).unwrap();
    assert_eq!((by_prefix('1').1, by_prefix('1').2.as_str()), (1, "720p"));
    assert_eq!((by_prefix('2').1, by_prefix('2').2.as_str()), (0, "1080p"));
    assert_eq!((by_prefix('3').1, by_prefix('3').2.as_str()), (1, "sem resolução"));
    assert_eq!((by_prefix('4').1, by_prefix('4').2.as_str()), (0, "2160p"));

    // Segunda passada: nada mais é `quality = ''`.
    assert_eq!(store.backfill_classification(2).unwrap(), 0);
}
