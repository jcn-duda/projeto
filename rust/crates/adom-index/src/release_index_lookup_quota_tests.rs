//! Cota e limpeza do `idx:v14` por FAIXA de prefixo (`count_live`/`clear_all`)
//! e as varreduras de obra (`vivas_da_obra`/`agrega_obras`): semântica,
//! `EXPLAIN QUERY PLAN` antes/depois e a medição do ganho.
//!
//! Submódulo de `release_index_lookup` (dono das consultas), incluído por
//! `#[path]`: enxerga a `conn` e o `prefix_bounds` do índice. Fica abaixo do
//! teto de 400 linhas por fonte.

use rusqlite::ToSql;

use crate::release_index::{prefix_bounds, RecordOptions, ReleaseIndexStore};

const NOW: i64 = 1_700_000_000_000;
const TTL: u64 = 30 * 24 * 3600;
/// Expiração bem à frente do relógio fixo: toda linha semeada está viva.
const FAR: i64 = NOW + 30 * 24 * 3600 * 1000;

// As consultas do store, copiadas para o `EXPLAIN QUERY PLAN` e a medição.
const SQL_COUNT_FAIXA: &str =
    "SELECT COUNT(*) FROM cache WHERE key >= ?1 AND key < ?2 AND expires_at >= ?3";
const SQL_COUNT_SUBSTR: &str = "SELECT COUNT(*) FROM cache
     WHERE substr(key, 1, length(?1)) = ?1 AND expires_at >= ?2";
const SQL_CLEAR_FAIXA: &str = "DELETE FROM cache WHERE key >= ?1 AND key < ?2";
const SQL_CLEAR_SUBSTR: &str = "DELETE FROM cache WHERE substr(key, 1, length(?1)) = ?1";
const SQL_OBRA_FAIXA: &str = "SELECT key, value FROM cache
     WHERE (key = ?1 OR (key >= ?2 AND key < ?3)) AND expires_at >= ?4";
const SQL_OBRA_SUBSTR: &str = "SELECT key, value FROM cache
     WHERE (key = ?1 OR substr(key, 1, length(?2)) = ?2) AND expires_at >= ?3";
const SQL_AGREGA_FAIXA: &str = "SELECT key, value FROM cache
     WHERE key >= ?1 AND key < ?2 AND expires_at >= ?3";
const SQL_AGREGA_SUBSTR: &str = "SELECT key, value FROM cache
     WHERE substr(key, 1, length(?1)) = ?1 AND expires_at >= ?2";

fn store() -> ReleaseIndexStore {
    ReleaseIndexStore::open_memory().expect("memória")
}

/// Semeia linhas cruas (`value = '{}'`): o teste quer o recorte de CHAVES, não
/// o JSON do índice.
fn seed(store: &ReleaseIndexStore, rows: &[(&str, i64)]) {
    let conn = store.lock();
    conn.execute_batch("BEGIN").expect("begin");
    {
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)")
            .expect("prepare do seed");
        for (key, expires_at) in rows {
            stmt.execute(rusqlite::params![key, expires_at])
                .expect("seed");
        }
    }
    conn.execute_batch("COMMIT").expect("commit");
}

/// Chaves presentes, em ordem — para conferir o que sobreviveu ao `clear_all`.
fn chaves(store: &ReleaseIndexStore) -> Vec<String> {
    let conn = store.lock();
    let mut stmt = conn
        .prepare("SELECT key FROM cache ORDER BY key")
        .expect("prepare");
    stmt.query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("linhas")
}

/// Plano de execução (`EXPLAIN QUERY PLAN`) numa linha só.
fn plano(conn: &rusqlite::Connection, sql: &str, args: &[&dyn ToSql]) -> String {
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("prepare do plano");
    let linhas: Vec<String> = stmt
        .query_map(args, |row| row.get::<_, String>(3))
        .expect("query do plano")
        .collect::<Result<_, _>>()
        .expect("linhas do plano");
    linhas.join(" | ")
}

/// A faixa tem que BUSCAR pela PK; varrer a tabela é o defeito que ela fecha.
fn busca_na_primaria(plano: &str, sql: &str) {
    assert!(
        plano.contains("SEARCH"),
        "faixa de prefixo precisa buscar por índice: {plano} ({sql})"
    );
    assert!(
        !plano.contains("SCAN"),
        "faixa de prefixo não pode varrer a tabela: {plano} ({sql})"
    );
}

/// Acervo mínimo com as bordas: o próprio prefixo (limite inferior), o
/// sucessor (`;`), a versão morta, o namespace vizinho e a chave vazia.
const ACERVO: [(&str, i64); 9] = [
    ("", FAR),
    ("idx:v14:", FAR),
    ("idx:v14:tt1000001", FAR),
    ("idx:v14:tt1000001:S1E1", NOW - 1),
    ("idx:v14;", FAR),
    ("idx:v14;x", FAR),
    ("idx:v14x:tt1", FAR),
    ("idx2:v14:tt1", FAR),
    ("idx:v13:tt1", FAR),
];

#[test]
fn count_live_conta_so_as_chaves_vivas_da_faixa() {
    let store = store();
    seed(&store, &ACERVO);
    // Vivas na faixa `[idx:v14:, idx:v14;)`: a chave no limite inferior entra;
    // a vencida e tudo o que está fora (sucessor, vizinho, versão morta, vazio)
    // fica de fora.
    assert_eq!(store.count_live(NOW).expect("conta"), 2);
    // Nada vivo depois do TTL: "namespace" não pode ser confundido com "vivo".
    assert_eq!(store.count_live(FAR + 1).expect("conta vencida"), 0);
}

#[test]
fn clear_all_apaga_so_o_namespace_vivo_do_indice() {
    let store = store();
    seed(&store, &ACERVO);
    // O `clear_all` não olha expiração: apaga as TRÊS linhas da faixa (a
    // vencida inclusive), e só elas.
    assert_eq!(store.clear_all().expect("limpa"), 3, "só as da faixa");
    assert_eq!(
        chaves(&store),
        vec![
            String::new(),
            "idx2:v14:tt1".to_string(),
            "idx:v13:tt1".to_string(),
            "idx:v14;".to_string(),
            "idx:v14;x".to_string(),
            "idx:v14x:tt1".to_string(),
        ],
        "vizinhos, sucessor, versão morta e chave vazia intactos"
    );
    assert_eq!(store.count_live(NOW).expect("conta"), 0);
    assert_eq!(store.clear_all().expect("limpa de novo"), 0, "idempotente");
}

#[test]
fn limite_superior_e_o_sucessor_do_dois_pontos() {
    let (lo, hi) = prefix_bounds("idx:v14:");
    assert_eq!((lo.as_str(), hi.as_str()), ("idx:v14:", "idx:v14;"));
    // A chave EXATAMENTE no limite inferior entra; a do caractere seguinte não.
    assert!(lo.as_str() <= "idx:v14:");
    assert!("idx:v14:tt1" < hi.as_str());
    assert!("idx:v14;" >= hi.as_str());
    assert!("idx:v14x:tt1" >= hi.as_str());
    assert!("idx2:v14:tt1" < lo.as_str());
    // Prefixo vazio não é faixa: o sucessor de `""` seria `""` e o recorte
    // viraria o acervo inteiro. Quem chama só passa prefixo de namespace.
    assert!(String::new() < lo);
}

#[test]
fn plano_da_contagem_e_da_limpeza_busca_na_primaria() {
    let store = store();
    let conn = store.lock();
    let (lo, hi) = prefix_bounds("idx:v14:");
    busca_na_primaria(
        &plano(&conn, SQL_COUNT_FAIXA, &[&lo, &hi, &NOW]),
        SQL_COUNT_FAIXA,
    );
    busca_na_primaria(&plano(&conn, SQL_CLEAR_FAIXA, &[&lo, &hi]), SQL_CLEAR_FAIXA);
    // Controle: o `substr` da versão anterior varria o acervo inteiro.
    let velho = plano(&conn, SQL_CLEAR_SUBSTR, &[&lo]);
    assert!(velho.contains("SCAN"), "o substr sempre varreu: {velho}");
}

#[test]
fn plano_das_varreduras_de_obra_busca_na_primaria() {
    let store = store();
    let conn = store.lock();
    let obra = "idx:v14:tt1000001";
    let (olo, ohi) = prefix_bounds(&format!("{obra}:"));
    busca_na_primaria(
        &plano(&conn, SQL_OBRA_FAIXA, &[&obra, &olo, &ohi, &NOW]),
        SQL_OBRA_FAIXA,
    );
    let (lo, hi) = prefix_bounds("idx:v14:");
    busca_na_primaria(
        &plano(&conn, SQL_AGREGA_FAIXA, &[&lo, &hi, &NOW]),
        SQL_AGREGA_FAIXA,
    );
    // Controles: a forma antiga nunca alcança a PRIMARY KEY — sem o filtro de
    // `expires_at` varre o acervo; com ele, o `cache_expires` percorre TODAS as
    // linhas vivas (mag/streams), não só o namespace.
    let filho = format!("{obra}:");
    for (sql, args) in [
        (SQL_OBRA_SUBSTR, vec![&obra as &dyn ToSql, &filho, &NOW]),
        (SQL_AGREGA_SUBSTR, vec![&lo, &NOW]),
    ] {
        let velho = plano(&conn, sql, &args);
        assert!(
            !velho.contains("PRIMARY KEY"),
            "o substr não alcança a PK: {velho}"
        );
    }
}

#[test]
fn clear_partial_nao_sai_do_prefixo_da_obra() {
    let store = store();
    let parcial = r#"{"at":0,"partial":true,"releases":[]}"#;
    {
        let conn = store.lock();
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)")
            .expect("prepare");
        for key in [
            "idx:v14:tt1",
            "idx:v14:tt1:S1",
            "idx:v14:tt1:S1E1",
            "idx:v14:tt12",
            "idx:v14:tt1X",
        ] {
            stmt.execute(rusqlite::params![key, parcial, FAR])
                .expect("seed parcial");
        }
    }
    assert_eq!(store.clear_partial("tt1", NOW).expect("limpa"), 3);
    let ver = |key: &str| {
        store
            .lock()
            .query_row(
                "SELECT value FROM cache WHERE key = ?1",
                rusqlite::params![key],
                |row| row.get::<_, String>(0),
            )
            .expect("linha")
    };
    for propria in ["idx:v14:tt1", "idx:v14:tt1:S1", "idx:v14:tt1:S1E1"] {
        assert!(ver(propria).contains("\"partial\":false"), "{propria}");
    }
    for alheia in ["idx:v14:tt12", "idx:v14:tt1X"] {
        assert!(
            ver(alheia).contains("\"partial\":true"),
            "obra vizinha intacta: {alheia}"
        );
    }
}

#[test]
fn snapshot_all_works_le_so_a_faixa_do_indice() {
    let store = store();
    let item = serde_json::json!({
        "title": "Filme 2024 1080p",
        "infoHash": "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a",
    });
    store
        .record(
            "tt9000001",
            adom_core::WorkTarget {
                season: None,
                episode: None,
            },
            &[item],
            RecordOptions::default(),
            TTL,
            60,
            NOW,
            None,
        )
        .expect("record");
    // Fora do namespace, com o MESMO JSON de entrada: nunca entra no agregado.
    let alheio = r#"{"at":0,"partial":false,"releases":[{"hash":"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b","title":"Alheio"}]}"#;
    store
        .lock()
        .execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["raw:v1:tt9000002", alheio, FAR],
        )
        .expect("seed alheio");
    let out = store.snapshot_all_works(NOW).expect("snapshot");
    assert_eq!(out.len(), 1, "só a obra do índice: {out:?}");
    assert!(out.contains_key("tt9000001"));
}

/// Medição manual (fora da suíte):
/// `cargo test -p adom-index -- --ignored --nocapture medicao_lookup`.
#[test]
#[ignore = "medicao manual: cargo test -p adom-index -- --ignored --nocapture"]
fn medicao_lookup_substr_versus_faixa_de_prefixo() {
    use std::time::Instant;

    const ITER: u32 = 20;
    let conn = rusqlite::Connection::open_in_memory().expect("memória");
    conn.execute_batch(crate::release_index::SCHEMA)
        .expect("schema");
    {
        conn.execute_batch("BEGIN").expect("begin");
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)")
            .expect("prepare");
        // Acervo de produção (~93k): `mag` domina, mais o idx cheio e o raw.
        for i in 0..88_000i64 {
            stmt.execute(rusqlite::params![format!("mag:v1:{i:08}"), FAR])
                .expect("mag");
        }
        for i in 0..2_000i64 {
            stmt.execute(rusqlite::params![format!("idx:v14:tt9{i:05}"), FAR])
                .expect("idx");
        }
        for key in ["idx:v14:tt900000:S1", "idx:v14:tt900000:S1E1"] {
            stmt.execute(rusqlite::params![key, FAR]).expect("obra");
        }
        for i in 0..800i64 {
            stmt.execute(rusqlite::params![format!("raw:v1:bludv:t:q{i:06}"), FAR])
                .expect("raw");
        }
        drop(stmt);
        conn.execute_batch("COMMIT").expect("commit");
    }
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
        .expect("total");
    let (lo, hi) = prefix_bounds("idx:v14:");
    let obra = "idx:v14:tt900000";
    let (olo, ohi) = prefix_bounds(&format!("{obra}:"));
    // Prefixo sem NENHUMA linha, para o `clear_all` ser repetível na medição.
    let (sem_linhas, sem_linhas_hi) = ("zzz:v1:", "zzz:v1;");

    let tempo = |f: &mut dyn FnMut()| {
        let t = Instant::now();
        for _ in 0..ITER {
            f();
        }
        t.elapsed().as_secs_f64() * 1_000.0 / f64::from(ITER)
    };
    let conta = |sql: &str, args: &[&dyn ToSql], esperado: i64| {
        tempo(&mut || {
            let n: i64 = conn.query_row(sql, args, |row| row.get(0)).expect("conta");
            assert_eq!(n, esperado);
        })
    };
    let linhas = |sql: &str, args: &[&dyn ToSql], esperado: usize| {
        tempo(&mut || {
            let n = conn
                .prepare(sql)
                .expect("prepare")
                .query_map(args, |row| row.get::<_, String>(0))
                .expect("query")
                .count();
            assert_eq!(n, esperado);
        })
    };
    let limpa = |sql: &str, args: &[&dyn ToSql]| {
        tempo(&mut || {
            let n = conn.execute(sql, args).expect("limpa");
            assert_eq!(n, 0, "o prefixo medido não tem linhas");
        })
    };

    let conta_velha = conta(SQL_COUNT_SUBSTR, &[&lo, &NOW], 2_002);
    let conta_nova = conta(SQL_COUNT_FAIXA, &[&lo, &hi, &NOW], 2_002);
    // `clear_all` medido num prefixo SEM linhas (`zzz:`): as duas formas apagam
    // zero e a volta seguinte mede o mesmo acervo.
    let limpa_velho = limpa(SQL_CLEAR_SUBSTR, &[&sem_linhas]);
    let limpa_novo = limpa(SQL_CLEAR_FAIXA, &[&sem_linhas, &sem_linhas_hi]);
    let obra_velho = linhas(SQL_OBRA_SUBSTR, &[&obra, &format!("{obra}:"), &NOW], 3);
    let obra_novo = linhas(SQL_OBRA_FAIXA, &[&obra, &olo, &ohi, &NOW], 3);

    println!("\n[medicao] acervo = {total} linhas, {ITER} iterações por query");
    println!("[medicao] count_live  substr {conta_velha:.3} ms | faixa {conta_nova:.3} ms");
    println!("[medicao] clear_all   substr {limpa_velho:.3} ms | faixa {limpa_novo:.3} ms");
    println!("[medicao] leitura obra substr {obra_velho:.3} ms | faixa {obra_novo:.3} ms");
    for (rotulo, sql, args) in [
        (
            "count substr",
            SQL_COUNT_SUBSTR,
            vec![&lo as &dyn ToSql, &NOW],
        ),
        ("count faixa ", SQL_COUNT_FAIXA, vec![&lo, &hi, &NOW]),
        (
            "obra  substr",
            SQL_OBRA_SUBSTR,
            vec![&obra, &format!("{obra}:"), &NOW],
        ),
        (
            "obra  faixa ",
            SQL_OBRA_FAIXA,
            vec![&obra, &olo, &ohi, &NOW],
        ),
        ("clear substr", SQL_CLEAR_SUBSTR, vec![&lo as &dyn ToSql]),
        ("clear faixa ", SQL_CLEAR_FAIXA, vec![&lo, &hi]),
    ] {
        println!("[plano] {rotulo}: {}", plano(&conn, sql, &args));
    }
}
