//! Testes da camada store (CrawlStore) — parte 1. Cada teste cria banco
//! temporário via `tempfile`. Cobre: migrate, upsert+take_next, mark_result,
//! requeue_inflight e counters. A outra metade (clear_site, has_due, state,
//! runs, sum_releases, batch e requeue_errors) fica em `tests_part2`, que reusa
//! os helpers abaixo; a divisão atende à catraca de 400 linhas do CI Rust.

use crate::store::ops::{CrawlStore, MarkResult, UrlRow};

/// Cria um CrawlStore temporário já migrado, pronto para testes.
/// Compartilhado com `tests_part2` (visível em `crate::store`).
pub(super) fn temp_store() -> (CrawlStore, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("test.db");
    let store = CrawlStore::open(db_path.to_str().unwrap()).expect("open");
    store.migrate().expect("migrate");
    (store, dir)
}

/// Cria uma UrlRow de teste com valores padrão.
/// Compartilhado com `tests_part2` (visível em `crate::store`).
pub(super) fn sample_url(path: &str) -> UrlRow {
    UrlRow {
        site: "test-site".to_string(),
        url: format!("https://example.com{path}"),
        url_key: path.to_string(),
        kind: "movie".to_string(),
        status: "pending".to_string(),
        lastmod: String::new(),
        imdb: None,
        tries: 0,
        next_at: 0, // due imediatamente
        checked_at: 0,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 0,
    }
}

// ─── migrate ─────────────────────────────────────────────────────────────────

/// `migrate()` cria as 3 tabelas sem erro e é idempotente.
#[test]
fn migrate_cria_tres_tabelas() {
    let (store, _dir) = temp_store();
    // Segunda chamada não deve falhar (idempotente).
    store.migrate().expect("migrate idempotente");

    let tables: Vec<String> = store
        .conn()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(tables.contains(&"crawl_url".to_string()));
    assert!(tables.contains(&"crawl_run".to_string()));
    assert!(tables.contains(&"crawl_state".to_string()));
}

// ─── upsert + take_next roundtrip ────────────────────────────────────────────

/// `upsert_urls` grava URLs e `take_next` as recupera em ordem.
#[test]
fn upsert_e_take_next_roundtrip() {
    let (store, _dir) = temp_store();

    let urls = vec![sample_url("/filme-a"), sample_url("/filme-b")];
    store.upsert_urls("test-site", &urls).expect("upsert");

    // Primeira take_next: deve retornar a primeira URL (menor url_key).
    let row = store
        .take_next("test-site")
        .expect("take_next")
        .expect("deve ter");
    assert_eq!(row.url_key, "/filme-a");
    assert_eq!(row.status, "inflight");

    // Segunda take_next: retorna a outra.
    let row2 = store
        .take_next("test-site")
        .expect("take_next 2")
        .expect("deve ter");
    assert_eq!(row2.url_key, "/filme-b");

    // Terceira: não há mais URLs due.
    let none = store.take_next("test-site").expect("take_next vazio");
    assert!(none.is_none());
}

/// `upsert_urls` sobrescreve URL existente (mesma PK site+url_key).
#[test]
fn upsert_substitui_existente() {
    let (store, _dir) = temp_store();

    let mut url = sample_url("/filme-a");
    url.imdb = Some("tt0000001".to_string());
    store.upsert_urls("test-site", &[url]).expect("upsert 1");

    let mut url2 = sample_url("/filme-a");
    url2.imdb = Some("tt0000002".to_string());
    url2.releases = 5;
    store.upsert_urls("test-site", &[url2]).expect("upsert 2");

    let counters = store.counters("test-site").expect("counters");
    assert_eq!(counters.pending, 1, "deve haver exatamente 1 pending");
    assert_eq!(store.sum_releases("test-site").expect("releases"), 5);
}

// ─── mark_result ─────────────────────────────────────────────────────────────

/// `mark_result` com status "done" → next_at = 0 (terminal).
#[test]
fn mark_result_done_zera_next_at() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls("test-site", &[sample_url("/filme-a")])
        .expect("upsert");
    let row = store.take_next("test-site").expect("take").expect("row");

    let result = MarkResult {
        status: "done".to_string(),
        imdb: Some("tt1234567".to_string()),
        title: None,
        year: None,
        releases: 3,
        error: String::new(),
        progress: String::new(),
        next_at: 0, // terminal
        request_cost: 1,
    };
    store
        .mark_result("test-site", &row.url_key, &result)
        .expect("mark");

    // Verifica que o status ficou "done" e next_at = 0.
    let (status, next_at, releases): (String, i64, u32) = store
        .conn()
        .query_row(
            "SELECT status, next_at, releases FROM crawl_url WHERE site = ?1 AND url_key = ?2",
            rusqlite::params!["test-site", "/filme-a"],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("query");
    assert_eq!(status, "done");
    assert_eq!(next_at, 0);
    assert_eq!(releases, 3);
}

/// `mark_result` com next_at > 0 volta para "pending" (retry).
#[test]
fn mark_result_retry_volta_pending() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls("test-site", &[sample_url("/filme-a")])
        .expect("upsert");
    let row = store.take_next("test-site").expect("take").expect("row");

    let result = MarkResult {
        status: "error".to_string(),
        imdb: None,
        title: None,
        year: None,
        releases: 0,
        error: "timeout".to_string(),
        progress: String::new(),
        next_at: 9999999999999, // retry no futuro
        request_cost: 1,
    };
    store
        .mark_result("test-site", &row.url_key, &result)
        .expect("mark");

    let status: String = store
        .conn()
        .query_row(
            "SELECT status FROM crawl_url WHERE site = ?1 AND url_key = ?2",
            rusqlite::params!["test-site", "/filme-a"],
            |row| row.get(0),
        )
        .expect("query");
    assert_eq!(status, "pending", "next_at > 0 deve voltar para pending");
}

// ─── requeue_inflight ────────────────────────────────────────────────────────

/// `requeue_inflight` recupera URLs inflight (crash recovery).
#[test]
fn requeue_inflight_recupera_urls() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls(
            "test-site",
            &[sample_url("/filme-a"), sample_url("/filme-b")],
        )
        .expect("upsert");

    // Reivindica ambas (ficam inflight).
    store
        .take_next("test-site")
        .expect("take a")
        .expect("row a");
    store
        .take_next("test-site")
        .expect("take b")
        .expect("row b");

    // Confirma que estão inflight.
    let c = store.counters("test-site").expect("counters");
    assert_eq!(c.inflight, 2);
    assert_eq!(c.pending, 0);

    // Crash recovery.
    let requeued = store.requeue_inflight("test-site").expect("requeue");
    assert_eq!(requeued, 2);

    let c2 = store.counters("test-site").expect("counters 2");
    assert_eq!(c2.pending, 2);
    assert_eq!(c2.inflight, 0);
}

// ─── counters ────────────────────────────────────────────────────────────────

/// `counters` reflete estados corretos após várias operações.
#[test]
fn counters_reflete_estados() {
    let (store, _dir) = temp_store();

    // 3 URLs: uma done, uma error, uma pending.
    store
        .upsert_urls(
            "test-site",
            &[sample_url("/a"), sample_url("/b"), sample_url("/c")],
        )
        .expect("upsert");

    // Processa /a → done.
    let ra = store.take_next("test-site").expect("take").expect("row");
    store
        .mark_result(
            "test-site",
            &ra.url_key,
            &MarkResult {
                status: "done".to_string(),
                imdb: None,
                title: None,
                year: None,
                releases: 2,
                error: String::new(),
                progress: String::new(),
                next_at: 0,
                request_cost: 1,
            },
        )
        .expect("mark a");

    // Processa /b → error terminal.
    let rb = store.take_next("test-site").expect("take").expect("row");
    store
        .mark_result(
            "test-site",
            &rb.url_key,
            &MarkResult {
                status: "error".to_string(),
                imdb: None,
                title: None,
                year: None,
                releases: 0,
                error: "fail".to_string(),
                progress: String::new(),
                next_at: 0,
                request_cost: 1,
            },
        )
        .expect("mark b");

    let c = store.counters("test-site").expect("counters");
    assert_eq!(c.done, 1);
    assert_eq!(c.error, 1);
    assert_eq!(c.pending, 1);
    assert_eq!(c.inflight, 0);
}
