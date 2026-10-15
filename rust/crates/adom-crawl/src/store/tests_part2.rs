//! Testes da camada store (CrawlStore) — parte 2.
//!
//! Cobre: clear_site, has_due, state, runs, sum_releases, take_next_batch e
//! requeue_errors. Os helpers compartilhados (`temp_store` / `sample_url`) e a
//! primeira metade dos testes (migrate, upsert+take_next, mark_result,
//! requeue_inflight, counters) ficam em `super::tests`.

use super::tests::{sample_url, temp_store};
use super::*;

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

/// Rodízio: o site atendido há mais tempo ganha a vaga. Antes, com a fila de
/// todos em `next_at = 0`, o desempate fixo (alfabético) servia sempre os
/// mesmos e o `site-c` (o TDF, ao vivo) nunca entrava.
#[test]
fn take_next_batch_serve_quem_esperou_mais() {
    let (store, _dir) = temp_store();
    for site in ["site-a", "site-b", "site-c"] {
        store
            .upsert_urls(site, &[sample_url("/1"), sample_url("/2")])
            .expect("upsert");
    }
    let mut served = Vec::new();
    for _ in 0..3 {
        let batch = store.take_next_batch(1).expect("batch");
        let row = &batch[0];
        served.push(row.site.clone());
        let done = MarkResult {
            status: "done".to_string(),
            imdb: None,
            title: None,
            year: None,
            releases: 1,
            error: String::new(),
            progress: String::new(),
            next_at: 0,
            request_cost: 1,
        };
        store
            .mark_result(&row.site, &row.url_key, &done)
            .expect("mark");
        // Relógio de milissegundo: garante checked_at distinto entre voltas.
        std::thread::sleep(std::time::Duration::from_millis(3));
    }
    served.sort();
    assert_eq!(
        served,
        ["site-a", "site-b", "site-c"],
        "cada site teve a vez"
    );
}

// ─── roteamento own_pace (dono único: motor TS) ─────────────────────────

/// Site real com ritmo próprio (o critério vem do perfil de rede, não do id).
const OWN_PACE: &str = "mico";

/// `take_next` nunca reivindica own_pace: o sidecar não é o dono dele e uma
/// recusa do engine queimaria tentativa (incidente de 2026-10).
#[test]
fn take_next_recusa_own_pace() {
    let (store, _dir) = temp_store();
    store
        .upsert_urls(OWN_PACE, &[sample_url("/crawl/movie/tt0000001/")])
        .expect("upsert mico");

    let none = store.take_next(OWN_PACE).expect("take mico");
    assert!(
        none.is_none(),
        "own_pace não pode ser reivindicado pelo Rust"
    );

    // A fila fica intacta (pending, sem tentativa queimada) para o TS processar.
    let c = store.counters(OWN_PACE).expect("counters mico");
    assert_eq!(c.pending, 1);
    assert_eq!(c.inflight, 0);
}

/// `take_next_batch` exclui own_pace SEM consumir vaga do limite: o Mico tem a
/// fila mais antiga, então um recorte no SQL o põe no topo — sem o filtro, os
/// sites normais perderiam vaga para quem não vai trabalhar.
#[test]
fn take_next_batch_exclui_own_pace_sem_gastar_vaga() {
    let (store, _dir) = temp_store();
    store
        .upsert_urls(OWN_PACE, &[sample_url("/crawl/movie/tt0000001/")])
        .expect("upsert mico");
    store
        .upsert_urls("site-a", &[sample_url("/a")])
        .expect("upsert a");
    store
        .upsert_urls("site-b", &[sample_url("/b")])
        .expect("upsert b");

    let batch = store.take_next_batch(2).expect("batch");
    let sites: Vec<&str> = batch.iter().map(|r| r.site.as_str()).collect();
    assert!(
        !sites.contains(&OWN_PACE),
        "own_pace nunca entra no lote do sidecar"
    );
    assert_eq!(batch.len(), 2, "o limite é preenchido com os sites normais");
}

// ─── requeue_errors ────────────────────────────────────────────────────────

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
