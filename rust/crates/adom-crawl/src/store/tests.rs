//! Testes da camada store (CrawlStore). Cada teste cria banco temporário
//! via `tempfile`. Cobre: migrate, upsert+take_next, mark_result,
//! requeue_inflight, counters, clear_site, state, runs, batch.

use crate::store::ops::{CrawlStore, MarkResult, UrlRow};

/// Cria um CrawlStore temporário já migrado, pronto para testes.
fn temp_store() -> (CrawlStore, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("test.db");
    let store = CrawlStore::open(db_path.to_str().unwrap()).expect("open");
    store.migrate().expect("migrate");
    (store, dir)
}

/// Cria uma UrlRow de teste com valores padrão.
fn sample_url(path: &str) -> UrlRow {
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

// ─── clear_site ──────────────────────────────────────────────────────────────

/// `clear_site` apaga tudo do site (URLs, estado, rodadas).
#[test]
fn clear_site_apaga_tudo() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls("test-site", &[sample_url("/filme-a")])
        .expect("upsert");
    store
        .set_state("test-site", "cursor", "abc")
        .expect("set_state");
    let run_id = store.start_run("test-site").expect("start_run");
    store
        .finish_run(run_id, "{\"done\":1}")
        .expect("finish_run");

    // Outra site não deve ser afetado.
    store
        .upsert_urls("outro-site", &[sample_url("/x")])
        .expect("upsert outro");

    store.clear_site("test-site").expect("clear");

    let c = store.counters("test-site").expect("counters");
    assert_eq!(c.pending, 0, "URLs devem ter sido apagadas");

    let state = store.get_state("test-site", "cursor").expect("get_state");
    assert!(state.is_none(), "estado deve ter sido apagado");

    // Outro site intacto.
    let c2 = store.counters("outro-site").expect("counters outro");
    assert_eq!(c2.pending, 1);
}

// ─── has_due ─────────────────────────────────────────────────────────────────

/// `has_due` retorna true quando há trabalho pendente.
#[test]
fn has_due_detecta_trabalho() {
    let (store, _dir) = temp_store();

    assert!(!store.has_due("test-site").expect("has_due vazio"));

    store
        .upsert_urls("test-site", &[sample_url("/filme-a")])
        .expect("upsert");
    assert!(store.has_due("test-site").expect("has_due com pendente"));
}

// ─── state ───────────────────────────────────────────────────────────────────

/// `get_state` / `set_state` funcionam como par chave/valor.
#[test]
fn state_get_set() {
    let (store, _dir) = temp_store();

    let missing = store.get_state("test-site", "cursor").expect("get");
    assert!(missing.is_none());

    store
        .set_state("test-site", "cursor", "pagina-42")
        .expect("set");
    let val = store.get_state("test-site", "cursor").expect("get 2");
    assert_eq!(val.as_deref(), Some("pagina-42"));

    // Sobrescreve.
    store
        .set_state("test-site", "cursor", "pagina-43")
        .expect("set 2");
    let val2 = store.get_state("test-site", "cursor").expect("get 3");
    assert_eq!(val2.as_deref(), Some("pagina-43"));
}

// ─── run ─────────────────────────────────────────────────────────────────────

/// `start_run` + `finish_run` gravam rodada corretamente.
#[test]
fn run_start_finish() {
    let (store, _dir) = temp_store();

    let run_id = store.start_run("test-site").expect("start");
    assert!(run_id > 0);

    store
        .finish_run(run_id, "{\"done\":5,\"error\":1}")
        .expect("finish");

    let counters: String = store
        .conn()
        .query_row(
            "SELECT counters FROM crawl_run WHERE id = ?1",
            rusqlite::params![run_id],
            |row| row.get(0),
        )
        .expect("query");
    assert_eq!(counters, "{\"done\":5,\"error\":1}");
}

// ─── sum_releases ────────────────────────────────────────────────────────────

/// `sum_releases` soma releases de todas as URLs do site.
#[test]
fn sum_releases_soma() {
    let (store, _dir) = temp_store();

    assert_eq!(store.sum_releases("test-site").expect("sum vazio"), 0);

    let mut a = sample_url("/a");
    a.releases = 3;
    let mut b = sample_url("/b");
    b.releases = 7;
    store.upsert_urls("test-site", &[a, b]).expect("upsert");

    assert_eq!(store.sum_releases("test-site").expect("sum"), 10);
}

// ─── take_next_batch ─────────────────────────────────────────────────────────

/// `take_next_batch` reclama uma URL por site, até o limite.
#[test]
fn take_next_batch_multiplos_sites() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls("site-a", &[sample_url("/1")])
        .expect("upsert a");
    store
        .upsert_urls("site-b", &[sample_url("/2")])
        .expect("upsert b");
    store
        .upsert_urls("site-c", &[sample_url("/3")])
        .expect("upsert c");

    let batch = store.take_next_batch(2).expect("batch");
    assert_eq!(batch.len(), 2, "deve retornar 2 sites (limite)");

    // Todos devem estar inflight.
    for row in &batch {
        assert_eq!(row.status, "inflight");
    }
}

// ─── requeue_errors ──────────────────────────────────────────────────────────

/// `requeue_errors` reenfileira URLs com status error/no-work.
#[test]
fn requeue_errors_recupera() {
    let (store, _dir) = temp_store();

    store
        .upsert_urls("test-site", &[sample_url("/a"), sample_url("/b")])
        .expect("upsert");

    // Marca /a como error, /b como no-work.
    let ra = store.take_next("test-site").expect("take").expect("row");
    store
        .mark_result(
            "test-site",
            &ra.url_key,
            &MarkResult {
                status: "error".to_string(),
                imdb: None,
                title: None,
                year: None,
                releases: 0,
                error: "oops".to_string(),
                progress: String::new(),
                next_at: 0,
                request_cost: 1,
            },
        )
        .expect("mark a");

    let rb = store.take_next("test-site").expect("take").expect("row");
    store
        .mark_result(
            "test-site",
            &rb.url_key,
            &MarkResult {
                status: "no-work".to_string(),
                imdb: None,
                title: None,
                year: None,
                releases: 0,
                error: String::new(),
                progress: String::new(),
                next_at: 0,
                request_cost: 1,
            },
        )
        .expect("mark b");

    let c = store.counters("test-site").expect("counters antes");
    assert_eq!(c.error, 1);
    assert_eq!(c.no_work, 1);

    let n = store.requeue_errors("test-site").expect("requeue");
    assert_eq!(n, 2);

    let c2 = store.counters("test-site").expect("counters depois");
    assert_eq!(c2.pending, 2);
    assert_eq!(c2.error, 0);
    assert_eq!(c2.no_work, 0);
}
