//! Testes da rota `GET /crawl/site-snapshot`.
//!
//! O Router REAL sobe numa porta efêmera e o teste fala HTTP com ele (mesmo
//! padrão de `admin_tests`): status, corpo camelCase e efeito no `crawl.db` são
//! o contrato que o painel Node consome.

use std::sync::Arc;

use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::Mutex;

use super::server::{router, AppState};
use super::snapshot::{merge_error_groups, stable_error_reason, PROBE_VERDICT_KEY};
use crate::motor::types::MotorConfig;
use crate::motor::CrawlMotor;
use crate::store::{CrawlStore, UrlRow};

const TOKEN: &str = "token-do-snapshot";
const SITE: &str = "nerdfilmes";

struct Harness {
    base: String,
    store: Arc<Mutex<CrawlStore>>,
    /// Por último: o diretório (e o `crawl.db`) morre depois do servidor.
    _dir: TempDir,
}

impl Harness {
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("crawl.db");
        let store = CrawlStore::open(db.to_str().expect("utf-8")).expect("abrir");
        store.migrate().expect("migrate");
        let store = Arc::new(Mutex::new(store));
        let state = Arc::new(AppState {
            motor: Arc::new(CrawlMotor::new(MotorConfig::default())),
            store: store.clone(),
            auth_token: TOKEN.to_string(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind efêmero");
        let addr = listener.local_addr().expect("endereço");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router(state)).await;
        });
        Self {
            base: format!("http://{addr}"),
            store,
            _dir: dir,
        }
    }

    /// GET com (ou sem) o token. Devolve status e corpo JSON.
    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        let mut req = reqwest::Client::new().get(format!("{}{}", self.base, path));
        if let Some(token) = token {
            req = req.header("X-Indexer-Test-Token", token);
        }
        let resp = req.send().await.expect("requisição ao sidecar");
        let status = resp.status().as_u16();
        let text = resp.text().await.expect("corpo");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn snapshot(&self, query: &str) -> (u16, Value) {
        self.get(&format!("/crawl/site-snapshot?{query}"), Some(TOKEN))
            .await
    }

    async fn seed(&self, rows: &[UrlRow]) {
        let store = self.store.lock().await;
        store.upsert_urls(SITE, rows).expect("upsert");
    }

    async fn with_store<T>(&self, f: impl FnOnce(&CrawlStore) -> T) -> T {
        let store = self.store.lock().await;
        f(&store)
    }
}

/// Linha da fila com o status, o `checked_at` e o erro/progresso dados.
fn row(key: &str, status: &str, checked_at: i64) -> UrlRow {
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
        checked_at,
        releases: 0,
        error: String::new(),
        progress: String::new(),
        added_at: 1_000,
    }
}

// ─── Autenticação, site e limite ────────────────────────────────────────────

#[tokio::test]
async fn snapshot_sem_token_responde_401() {
    let h = Harness::new().await;
    let (status, _) = h
        .get(&format!("/crawl/site-snapshot?site={SITE}"), None)
        .await;
    assert_eq!(status, 401);
}

#[tokio::test]
async fn snapshot_site_invalido_responde_400() {
    let h = Harness::new().await;
    let (status, body) = h.snapshot("site=nao-existe").await;
    assert_eq!(status, 400, "corpo: {body}");
    assert_eq!(body["ok"].as_bool(), Some(false));

    let (status, _) = h.snapshot("site=").await;
    assert_eq!(status, 400, "site vazio também é 400");
}

#[tokio::test]
async fn snapshot_limit_nao_numerico_responde_400() {
    let h = Harness::new().await;
    let (status, _) = h.snapshot(&format!("site={SITE}&limit=abc")).await;
    assert_eq!(status, 400);
}

// ─── Forma da resposta sem dados ────────────────────────────────────────────

/// Site sem linha nenhuma: zeros com TODAS as chaves, `latestRun` null e o
/// estado vazio. É a forma que o painel lê num site recém-criado.
#[tokio::test]
async fn snapshot_vazio_devolve_zeros_e_run_null() {
    let h = Harness::new().await;
    let (status, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(status, 200, "corpo: {body}");

    assert_eq!(body["site"], SITE);
    assert_eq!(body["counters"]["total"], 0);
    let by = &body["counters"]["byStatus"];
    for key in [
        "pending",
        "inflight",
        "done",
        "no-torrent",
        "no-work",
        "error",
        "simulated",
        "partial",
    ] {
        assert_eq!(by[key], 0, "{key} zerado");
    }
    assert!(body["latestRun"].is_null(), "sem rodada, latestRun é null");
    assert_eq!(body["magnetsFound"], 0);
    for list in ["done", "noWork", "partial", "error"] {
        assert_eq!(body["lists"][list], json!([]), "{list} vazia");
    }
    assert_eq!(body["errorGroups"], json!([]));
    assert!(body["state"]["probeVerdict"].is_null());
    assert_eq!(body["state"]["cursorMovie"], "");
    assert_eq!(body["state"]["cursorTvShow"], "");
}

// ─── Contagens, ordem e limite ──────────────────────────────────────────────

/// Uma linha de cada status (dois `done`), com `checked_at` variado: confere
/// as contagens, a ordem `checked_at` desc e o corte do `limit`.
#[tokio::test]
async fn snapshot_conta_cada_status_ordena_e_respeita_limite() {
    let h = Harness::new().await;
    let mut d1 = row("/d1", "done", 100);
    d1.releases = 5;
    d1.imdb = Some("tt0000001".to_string());
    let mut d2 = row("/d2", "done", 300);
    d2.releases = 7;
    let mut d3 = row("/d3", "done", 200);
    d3.releases = 1;
    let mut err = row("/e1", "error", 400);
    err.error = "timeout".to_string();
    err.tries = 2;
    let mut partial = row("/p1", "partial", 500);
    partial.progress = "{\"v\":1,\"doneCards\":[]}".to_string();
    h.seed(&[
        d1,
        d2,
        d3,
        row("/n1", "no-work", 50),
        err,
        partial,
        row("/s1", "simulated", 60),
        row("/q0", "pending", 0),
        row("/i1", "inflight", 70),
        row("/t1", "no-torrent", 80),
    ])
    .await;

    let (status, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(status, 200, "corpo: {body}");

    assert_eq!(body["counters"]["total"], 10);
    let by = &body["counters"]["byStatus"];
    assert_eq!(by["done"], 3);
    assert_eq!(by["no-work"], 1);
    assert_eq!(by["error"], 1);
    assert_eq!(by["partial"], 1);
    assert_eq!(by["simulated"], 1);
    assert_eq!(by["pending"], 1);
    assert_eq!(by["inflight"], 1);
    assert_eq!(by["no-torrent"], 1);
    assert_eq!(body["magnetsFound"], 13, "soma dos releases");

    let done_keys: Vec<&str> = body["lists"]["done"]
        .as_array()
        .expect("done")
        .iter()
        .map(|r| r["url"].as_str().expect("url"))
        .collect();
    assert_eq!(
        done_keys,
        vec![
            "https://nerdfilmes.example/d2",
            "https://nerdfilmes.example/d3",
            "https://nerdfilmes.example/d1",
        ],
        "checked_at desc"
    );
    let first = &body["lists"]["done"][2];
    assert_eq!(first["imdb"], "tt0000001");
    assert_eq!(first["releases"], 5);
    assert_eq!(first["checkedAt"], 100);
    assert!(first["error"].is_null(), "erro vazio vira null");
    assert!(first["progress"].is_null(), "progresso vazio vira null");

    assert_eq!(body["lists"]["error"][0]["error"], "timeout");
    assert_eq!(body["lists"]["error"][0]["tries"], 2);
    assert_eq!(
        body["lists"]["partial"][0]["progress"],
        "{\"v\":1,\"doneCards\":[]}"
    );
    assert_eq!(body["lists"]["noWork"].as_array().map(Vec::len), Some(1));

    let (_, limited) = h.snapshot(&format!("site={SITE}&limit=2")).await;
    assert_eq!(limited["lists"]["done"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        limited["lists"]["done"][0]["checkedAt"], 300,
        "o corte mantém o mais novo"
    );
}

/// Sem `limit` a lista tem 50 e com `limit` acima do teto corta em 200.
#[tokio::test]
async fn snapshot_limite_padrao_50_e_teto_200() {
    let h = Harness::new().await;
    let rows: Vec<UrlRow> = (0..205)
        .map(|i| row(&format!("/d{i:03}"), "done", i64::from(i)))
        .collect();
    h.seed(&rows).await;

    let (_, padrao) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(padrao["lists"]["done"].as_array().map(Vec::len), Some(50));

    let (_, teto) = h.snapshot(&format!("site={SITE}&limit=999")).await;
    assert_eq!(teto["lists"]["done"].as_array().map(Vec::len), Some(200));
    assert_eq!(teto["counters"]["total"], 205, "o total não é cortado");
}

// ─── Agrupamento de erros ───────────────────────────────────────────────────

/// Detalhe variável some do motivo (`series_truncated: cards 2/4` e
/// `cards 3/4` viram um grupo) e o vazio vira `erro`. Ordem: frequência, depois
/// motivo.
#[tokio::test]
async fn snapshot_agrupa_erros_pelo_motivo_estavel() {
    let h = Harness::new().await;
    let erros = [
        ("/a", "series_truncated: cards 2/4 botões 40/40"),
        ("/b", "series_truncated: cards 3/4"),
        ("/c", "series_stall: cards 5/9"),
        ("/d", "timeout"),
        ("/e", "timeout"),
        ("/f", ""),
    ];
    let rows: Vec<UrlRow> = erros
        .iter()
        .map(|(key, error)| {
            let mut r = row(key, "error", 10);
            r.error = (*error).to_string();
            r
        })
        .collect();
    h.seed(&rows).await;

    let (status, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(
        body["errorGroups"],
        json!([
            { "reason": "series_truncated", "count": 2 },
            { "reason": "timeout", "count": 2 },
            { "reason": "erro", "count": 1 },
            { "reason": "series_stall", "count": 1 },
        ])
    );
}

#[test]
fn motivo_estavel_reconhece_rotulos_sem_diferenciar_caixa() {
    assert_eq!(
        stable_error_reason("series_truncated: cards 2/4"),
        "series_truncated"
    );
    assert_eq!(stable_error_reason("SERIES_STALL cards"), "series_stall");
    assert_eq!(
        stable_error_reason("series_truncatedX"),
        "series_truncatedX"
    );
    assert_eq!(stable_error_reason("   "), "erro");
    assert_eq!(stable_error_reason("timeout"), "timeout");
    let merged = merge_error_groups(vec![
        ("series_truncated: a".to_string(), 1),
        ("series_truncated: b".to_string(), 3),
    ]);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].count, 4);
}

// ─── Run, estado e cursor ───────────────────────────────────────────────────

/// Duas rodadas: a SEGUNDA é a mais recente; `finishedAt` vem preenchido e os
/// contadores saem como objeto.
#[tokio::test]
async fn snapshot_run_mais_recente_com_contadores_parseados() {
    let h = Harness::new().await;
    let (primeira, segunda) = h
        .with_store(|s| {
            let a = s.start_run(SITE).expect("start 1");
            s.finish_run(a, "{}").expect("finish 1");
            let b = s.start_run(SITE).expect("start 2");
            s.finish_run(b, "{\"newReleases\":4}").expect("finish 2");
            (a, b)
        })
        .await;

    let (status, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(status, 200, "corpo: {body}");
    let run = &body["latestRun"];
    assert_eq!(
        run["id"], segunda,
        "a mais recente vence (primeira era {primeira})"
    );
    assert_eq!(run["site"], SITE);
    assert_eq!(run["phase"], "initial");
    assert!(run["finishedAt"].is_number());
    assert_eq!(run["counters"]["newReleases"], 4);
    assert_eq!(run["cursor"], "");
}

/// Veredito da sonda sai como foi gravado; cursor de filme cai no legado
/// `cursor` quando a chave nova está vazia, e a chave nova vence quando existe.
#[tokio::test]
async fn snapshot_le_probe_e_cursores_como_o_ts() {
    let h = Harness::new().await;
    let veredito = "{\"v\":2,\"site\":\"nerdfilmes\",\"verdict\":\"go\"}";
    h.with_store(|s| {
        s.set_state(SITE, PROBE_VERDICT_KEY, veredito)
            .expect("probe");
        s.set_state(SITE, "cursor", "legado").expect("legado");
        s.set_state(SITE, "cursor:movie", "").expect("movie vazio");
        s.set_state(SITE, "cursor:tv_show", "tv-1").expect("tv");
    })
    .await;

    let (_, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(body["state"]["probeVerdict"], veredito, "JSON cru");
    assert_eq!(
        body["state"]["cursorMovie"], "legado",
        "vazio cai no legado"
    );
    assert_eq!(body["state"]["cursorTvShow"], "tv-1");

    h.with_store(|s| s.set_state(SITE, "cursor:movie", "novo").expect("movie"))
        .await;
    let (_, body) = h.snapshot(&format!("site={SITE}")).await;
    assert_eq!(body["state"]["cursorMovie"], "novo", "a chave nova vence");
}
