//! Testes das leituras do painel (`store::read_ops`) direto no store.
//! As rotas HTTP estão em `sidecar::snapshot_tests`.

use tempfile::TempDir;

use crate::store::{CrawlStore, UrlRow};

const SITE: &str = "nerdfilmes";

/// Store migrado num `crawl.db` temporário. O diretório vive junto com a
/// struct: o arquivo some quando o teste termina.
fn store_temp() -> (TempDir, CrawlStore) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("crawl.db");
    let store = CrawlStore::open(path.to_str().expect("utf-8")).expect("abrir");
    store.migrate().expect("migrate");
    (dir, store)
}

fn row(key: &str, status: &str) -> UrlRow {
    UrlRow {
        site: SITE.to_string(),
        url: format!("https://nerdfilmes.example{key}"),
        url_key: key.to_string(),
        kind: "movie".to_string(),
        status: status.to_string(),
        lastmod: String::new(),
        imdb: None,
        tries: 0,
        next_at: 0,
        checked_at: 1_000,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 1_000,
    }
}

/// O DDL do TS grava `crawl_run.cursor` (não `cursor_val`). A leitura tem que
/// achar a coluna dos dois lados, senão o cursor da última rodada some.
#[test]
fn latest_run_le_a_coluna_cursor_do_ddl_do_ts() {
    let (_dir, store) = store_temp();
    store
        .conn()
        .execute_batch(
            "DROP TABLE crawl_run; \
             CREATE TABLE crawl_run (\
               id INTEGER PRIMARY KEY, site TEXT NOT NULL, \
               phase TEXT NOT NULL DEFAULT 'initial', cursor TEXT NOT NULL DEFAULT '', \
               started_at INTEGER NOT NULL DEFAULT 0, finished_at INTEGER, \
               counters TEXT NOT NULL DEFAULT '{}');\
             INSERT INTO crawl_run (id, site, phase, cursor, started_at, finished_at, counters) \
               VALUES (7, 'nerdfilmes', 'incremental', 'https://x/sitemap.xml', 500, NULL, '{\"newReleases\":2}');",
        )
        .expect("DDL do TS");

    let run = store.latest_run(SITE).expect("leitura").expect("há rodada");
    assert_eq!(run.id, 7);
    assert_eq!(run.phase, "incremental");
    assert_eq!(run.cursor, "https://x/sitemap.xml");
    assert_eq!(run.finished_at, None, "NULL continua None");
    assert_eq!(
        run.counters.get("newReleases").and_then(|v| v.as_i64()),
        Some(2)
    );
}

/// Com o DDL do Rust (`cursor_val`), a rodada sai com cursor vazio e fase
/// `initial` (o `start_run` do Rust não grava fase nem cursor).
#[test]
fn latest_run_com_ddl_do_rust_sai_cursor_vazio_e_fase_inicial() {
    let (_dir, store) = store_temp();
    let id = store.start_run(SITE).expect("start");
    store.finish_run(id, "{\"x\":1}").expect("finish");

    let run = store.latest_run(SITE).expect("leitura").expect("há rodada");
    assert_eq!(run.id, id);
    assert_eq!(run.phase, "initial");
    assert_eq!(run.cursor, "");
    assert!(run.finished_at.is_some());
}

/// Status que o TS não conhece (`gate-pending`) cai em `pending` no total por
/// status, como o `parseStatus` do TS. O total conta todas as linhas.
#[test]
fn status_tally_dobra_status_desconhecido_em_pending() {
    let (_dir, store) = store_temp();
    store
        .upsert_urls(
            SITE,
            &[
                row("/g", "gate-pending"),
                row("/p", "pending"),
                row("/d", "done"),
            ],
        )
        .expect("upsert");

    let tally = store.status_tally(SITE).expect("tally");
    assert_eq!(tally.total, 3);
    assert_eq!(tally.pending, 2);
    assert_eq!(tally.done, 1);
}

/// Erro vazio agrupa como `erro` e a lista respeita o limite.
#[test]
fn error_groups_mapeia_erro_vazio_para_erro() {
    let (_dir, store) = store_temp();
    let mut a = row("/a", "error");
    a.error = "timeout".to_string();
    let mut b = row("/b", "error");
    b.error = String::new();
    store.upsert_urls(SITE, &[a, b]).expect("upsert");

    let groups = store.error_groups(SITE, 10).expect("grupos");
    assert!(groups.contains(&("timeout".to_string(), 1)));
    assert!(groups.contains(&("erro".to_string(), 1)));
    assert_eq!(store.error_groups(SITE, 0).expect("limite 0").len(), 0);
}

/// Vitals contam o site inteiro: `no-torrent` entra no ritmo, a página adiada
/// (`pending` com `http_429`) entra no 429 mas não no ritmo, e o que passou da
/// hora só conta no total.
#[test]
fn site_vitals_contam_no_torrent_e_429_em_pending() {
    let (_dir, store) = store_temp();
    let now = 10_000_000;
    let recent = now - 60_000;
    let old = now - 7_200_000;
    let rows = [
        ("/nt", "no-torrent", recent, ""),
        ("/d", "done", recent, ""),
        ("/velha", "done", old, ""),
        ("/adiada", "pending", recent, "http_429"),
        ("/adiada-velha", "pending", old, "http_429 (retry)"),
        ("/exp", "error", recent, "link Expirado no portão"),
        ("/fila", "pending", 0, ""),
    ];
    store
        .upsert_urls(SITE, &rows.map(|(k, s, _, _)| row(k, s)))
        .expect("upsert");
    for (key, _, checked_at, error) in rows {
        store
            .conn()
            .execute(
                "UPDATE crawl_url SET checked_at = ?1, error = ?2 WHERE url_key = ?3",
                rusqlite::params![checked_at, error, key],
            )
            .expect("update");
    }

    let v = store.site_vitals(SITE, now).expect("vitals");
    assert_eq!(v.pages_last_hour, 3, "no-torrent, done e error recentes");
    assert_eq!((v.http429_total, v.http429_last_hour), (2, 1));
    assert_eq!((v.expired_total, v.expired_last_hour), (1, 1));
    assert_eq!(
        store.site_vitals("outro", now).expect("vazio"),
        Default::default()
    );
}
