//! Cota do `idx:v14` por FAIXA de prefixo: semântica, plano de execução e a
//! medição antes/depois do `substr` → `key >= ?1 AND key < ?2`.
//!
//! Incluída por `#[path]` a partir de `release_index_tests.rs` (teto de 400
//! linhas por arquivo).

use super::{movie, record, store, NOW};
use rusqlite::ToSql;
use serde_json::json;

use crate::release_index::prefix_bounds;

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

#[test]
fn faixa_de_prefixo_e_o_sucessor_do_dois_pontos() {
    // `:` (0x3A) incrementado vira `;` (0x3B): a faixa cobre o prefixo inteiro
    // e nada além dele — o mesmo conjunto que o `substr` comparava.
    assert_eq!(prefix_bounds("idx:v14:").1, "idx:v14;");
    assert_eq!(prefix_bounds("raw:v1:").1, "raw:v1;");
    let (lo, hi) = prefix_bounds("idx:");
    assert_eq!(lo, "idx:");
    assert!(lo.as_str() <= "idx:v14:tt1");
    assert!("idx:v14:tt1" < hi.as_str());
    // Vizinhos que NÃO são do namespace ficam fora da faixa: `idx;…` já é o
    // limite superior e `idx0…` está abaixo do prefixo (0x30 < 0x3A).
    assert!("idx;v14:tt1" >= hi.as_str());
    assert!("idx0:v14:tt1" < lo.as_str());
}

#[test]
fn cota_usa_faixa_e_o_plano_busca_por_indice_em_vez_de_varrer() {
    let store = store();
    let conn = store.conn.lock().unwrap_or_else(|err| err.into_inner());
    let (lo, hi) = prefix_bounds("idx:");
    // As três passadas do `enforce_quota` têm que ser SARGÁVEIS na PK.
    let casos: [(&str, Vec<&dyn ToSql>); 3] = [
        (
            "SELECT COUNT(*) FROM cache WHERE key >= ?1 AND key < ?2",
            vec![&lo, &hi],
        ),
        (
            "DELETE FROM cache WHERE expires_at <= ?1 AND key >= ?2 AND key < ?3",
            vec![&NOW, &lo, &hi],
        ),
        (
            "DELETE FROM cache WHERE key IN (
                SELECT key FROM cache WHERE key >= ?1 AND key < ?2
                ORDER BY expires_at ASC LIMIT ?3
            )",
            vec![&lo, &hi, &NOW],
        ),
    ];
    for (sql, args) in casos {
        let plano = plano(&conn, sql, &args);
        assert!(
            plano.contains("SEARCH"),
            "faixa de prefixo precisa buscar por índice: {plano} ({sql})"
        );
        assert!(
            !plano.contains("SCAN"),
            "faixa de prefixo não pode varrer a tabela: {plano} ({sql})"
        );
    }
    // Controle: o `substr` da versão antiga varria o acervo inteiro.
    let velho = plano(
        &conn,
        "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
        &[&lo],
    );
    assert!(velho.contains("SCAN"), "o substr sempre varreu: {velho}");
}

#[test]
fn cota_do_indice_corta_o_que_expira_primeiro_e_preserva_outro_namespace() {
    let store = store();
    {
        let conn = store.conn.lock().unwrap_or_else(|err| err.into_inner());
        conn.execute_batch("BEGIN").expect("begin");
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)")
            .expect("prepare");
        // 2.004 vivos com expiração crescente (tt900000 expira primeiro).
        for i in 0..2_004i64 {
            stmt.execute(rusqlite::params![
                format!("idx:v14:tt9{i:05}"),
                NOW + 1_000 + i * 1_000
            ])
            .expect("seed vivo");
        }
        // Uma vencida: sai na primeira passada do `enforce_quota`.
        stmt.execute(rusqlite::params!["idx:v14:tt8000000", NOW - 1])
            .expect("seed vencido");
        // Outro namespace, expirando antes de todos: o despejo NÃO pode alcançar.
        stmt.execute(rusqlite::params!["streams:v21:movie:tt1", NOW + 500])
            .expect("seed alheio");
        drop(stmt);
        conn.execute_batch("COMMIT").expect("commit");
    }
    // A gravação dispara o `enforce_quota`: 2.005 vivos contra a cota de 2.000.
    let item = json!({
        "title": "Filme 2024 1080p",
        "infoHash": "0404040404040404040404040404040404040404",
    });
    record(&store, "tt1234567", movie(), &[item], false, NOW);
    assert_eq!(store.count_live(NOW).expect("conta"), 2_000, "cota do idx");
    assert!(
        !store.has_key("idx:v14:tt8000000", NOW),
        "vencido some na gravação"
    );
    for i in 0..5 {
        assert!(
            !store.has_key(&format!("idx:v14:tt9{i:05}"), NOW),
            "os 5 que expiram primeiro cedem lugar (i={i})"
        );
    }
    assert!(
        store.has_key("idx:v14:tt900005", NOW),
        "o sexto da fila de expiração fica"
    );
    assert!(
        store.has_key("idx:v14:tt1234567", NOW),
        "a gravação que disparou a cota fica"
    );
    let conn = store.conn.lock().unwrap_or_else(|err| err.into_inner());
    let alheio: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cache WHERE key = 'streams:v21:movie:tt1'",
            [],
            |row| row.get(0),
        )
        .expect("conta alheio");
    drop(conn);
    assert_eq!(alheio, 1, "namespace alheio intacto");
}

/// Medição manual (fora da suíte):
/// `cargo test -p adom-index -- --ignored --nocapture medicao`.
#[test]
#[ignore = "medicao manual: cargo test -p adom-index -- --ignored --nocapture"]
fn medicao_cota_substr_versus_faixa_de_prefixo() {
    use std::time::Instant;

    const ITER: u32 = 20;
    let far = NOW + 90 * 86_400_000;
    let conn = rusqlite::Connection::open_in_memory().expect("memória");
    conn.execute_batch(crate::release_index::SCHEMA)
        .expect("schema");
    {
        conn.execute_batch("BEGIN").expect("begin");
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)")
            .expect("prepare");
        // Acervo de produção: `mag` domina, mais o idx cheio (2.000) e o raw (800).
        for i in 0..88_000i64 {
            stmt.execute(rusqlite::params![format!("mag:v1:{i:08}"), far])
                .expect("mag");
        }
        for i in 0..2_000i64 {
            stmt.execute(rusqlite::params![format!("idx:v14:tt9{i:05}"), far])
                .expect("idx");
        }
        for i in 0..800i64 {
            stmt.execute(rusqlite::params![format!("raw:v1:bludv:t:q{i:06}"), far])
                .expect("raw");
        }
        drop(stmt);
        conn.execute_batch("COMMIT").expect("commit");
    }
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM cache", [], |row| row.get(0))
        .expect("total");
    let (lo, hi) = prefix_bounds("idx:");

    let ms = |f: &mut dyn FnMut()| {
        let t = Instant::now();
        for _ in 0..ITER {
            f();
        }
        t.elapsed().as_secs_f64() * 1_000.0 / f64::from(ITER)
    };

    let conta_velha = ms(&mut || {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
                rusqlite::params![lo],
                |row| row.get(0),
            )
            .expect("conta velha");
        assert_eq!(n, 2_000);
    });
    let conta_nova = ms(&mut || {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM cache WHERE key >= ?1 AND key < ?2",
                rusqlite::params![lo, hi],
                |row| row.get(0),
            )
            .expect("conta nova");
        assert_eq!(n, 2_000);
    });
    // Nenhuma vencida: mede o custo de VARRER só para descobrir isso.
    let vencido_velho = ms(&mut || {
        conn.execute(
            "DELETE FROM cache WHERE expires_at <= ?1 AND substr(key, 1, length(?2)) = ?2",
            rusqlite::params![NOW, lo],
        )
        .expect("vencido velho");
    });
    let vencido_novo = ms(&mut || {
        conn.execute(
            "DELETE FROM cache WHERE expires_at <= ?1 AND key >= ?2 AND key < ?3",
            rusqlite::params![NOW, lo, hi],
        )
        .expect("vencido novo");
    });
    // Variante de produção: 5.000 vencidos de OUTRO namespace no acervo. O
    // `substr` ainda toca cada um (índice `cache_expires` + linha inteira); a
    // faixa nunca sai do namespace do idx.
    {
        conn.execute_batch("BEGIN").expect("begin");
        let mut stmt = conn
            .prepare("INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)")
            .expect("prepare");
        for i in 0..5_000i64 {
            stmt.execute(rusqlite::params![format!("mag:v1:dead{i:05}"), NOW - 1])
                .expect("mag vencido");
        }
        drop(stmt);
        conn.execute_batch("COMMIT").expect("commit");
    }
    // Nenhum deles é do idx: as duas formas não apagam nada e são repetitíveis.
    let vencido_velho_exp = ms(&mut || {
        conn.execute(
            "DELETE FROM cache WHERE expires_at <= ?1 AND substr(key, 1, length(?2)) = ?2",
            rusqlite::params![NOW, lo],
        )
        .expect("vencido velho expirados");
    });
    let vencido_novo_exp = ms(&mut || {
        conn.execute(
            "DELETE FROM cache WHERE expires_at <= ?1 AND key >= ?2 AND key < ?3",
            rusqlite::params![NOW, lo, hi],
        )
        .expect("vencido novo expirados");
    });
    // Subselect do despejo em modo leitura (o DELETE mudaria o acervo entre voltas).
    let despejo_velho = ms(&mut || {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1
                    ORDER BY expires_at ASC LIMIT 5
                )",
                rusqlite::params![lo],
                |row| row.get(0),
            )
            .expect("despejo velho");
        assert_eq!(n, 5);
    });
    let despejo_novo = ms(&mut || {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM (
                    SELECT key FROM cache WHERE key >= ?1 AND key < ?2
                    ORDER BY expires_at ASC LIMIT 5
                )",
                rusqlite::params![lo, hi],
                |row| row.get(0),
            )
            .expect("despejo novo");
        assert_eq!(n, 5);
    });

    println!("\n[medicao] acervo = {total} linhas, {ITER} iterações por query");
    println!("[medicao] COUNT idx    substr {conta_velha:.3} ms | faixa {conta_nova:.3} ms");
    println!("[medicao] DELETE venc. substr {vencido_velho:.3} ms | faixa {vencido_novo:.3} ms");
    println!(
        "[medicao] DELETE venc. +5k alheios substr {vencido_velho_exp:.3} ms | faixa {vencido_novo_exp:.3} ms"
    );
    println!("[medicao] despejo      substr {despejo_velho:.3} ms | faixa {despejo_novo:.3} ms");
    println!(
        "[plano] COUNT substr: {}",
        plano(
            &conn,
            "SELECT COUNT(*) FROM cache WHERE substr(key, 1, length(?1)) = ?1",
            &[&lo]
        )
    );
    println!(
        "[plano] COUNT faixa : {}",
        plano(
            &conn,
            "SELECT COUNT(*) FROM cache WHERE key >= ?1 AND key < ?2",
            &[&lo, &hi]
        )
    );
    println!(
        "[plano] despejo substr: {}",
        plano(
            &conn,
            "SELECT key FROM cache WHERE substr(key, 1, length(?1)) = ?1
             ORDER BY expires_at ASC LIMIT 5",
            &[&lo]
        )
    );
    println!(
        "[plano] despejo faixa : {}",
        plano(
            &conn,
            "SELECT key FROM cache WHERE key >= ?1 AND key < ?2
             ORDER BY expires_at ASC LIMIT 5",
            &[&lo, &hi]
        )
    );
}
