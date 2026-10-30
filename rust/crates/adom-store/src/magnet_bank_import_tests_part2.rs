//! Segunda parte dos testes do import (`magnet_bank_import_tests.rs`): linha
//! inválida, lotes e backfill. Fica em arquivo próprio pelo teto de linhas.

use super::*;

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
    assert_eq!(
        (by_prefix('3').1, by_prefix('3').2.as_str()),
        (1, "sem resolução")
    );
    assert_eq!((by_prefix('4').1, by_prefix('4').2.as_str()), (0, "2160p"));

    // Segunda passada: nada mais é `quality = ''`.
    assert_eq!(store.backfill_classification(2).unwrap(), 0);
}
