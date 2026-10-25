//! Testes das rotas administrativas do sidecar (`/crawl/*`).
//!
//! O Router REAL sobe em `127.0.0.1:0` (porta efêmera) e o teste fala HTTP com
//! ele: status, corpo e efeito no `crawl.db` são o contrato que o Node consome.
//! `tower`/`tower-util` não são dependência do crate, então nada de `oneshot`:
//! `axum::serve` + `reqwest` (já é dependência) provam a rota de ponta a ponta.

use std::sync::Arc;

use rusqlite::params;
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::Mutex;

use super::server::{router, AppState};
use crate::motor::types::MotorConfig;
use crate::motor::CrawlMotor;
use crate::store::{CrawlStore, UrlRow};

const TOKEN: &str = "token-de-teste";
const SITE: &str = "nerdfilmes";

struct Harness {
    base: String,
    store: Arc<Mutex<CrawlStore>>,
    /// O diretório morre por último: o drop dos campos é na ordem declarada.
    _dir: TempDir,
}

impl Harness {
    /// Sidecar em porta efêmera sobre um `crawl.db` temporário.
    async fn new() -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("crawl.db");
        let path = db.to_str().expect("caminho utf-8");
        let store = CrawlStore::open(path).expect("abrir crawl.db");
        store.migrate().expect("migrate do crawl.db");
        let store = Arc::new(Mutex::new(store));
        let state = Arc::new(AppState {
            motor: Arc::new(CrawlMotor::new(MotorConfig::default())),
            store: store.clone(),
            auth_token: TOKEN.to_string(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind efêmero");
        let addr = listener.local_addr().expect("endereço local");
        tokio::spawn(async move {
            let _ = axum::serve(listener, router(state)).await;
        });
        Self {
            base: format!("http://{addr}"),
            store,
            _dir: dir,
        }
    }

    /// Uma requisição crua: `body` vazio vira GET, o resto POST JSON.
    async fn call(
        &self,
        method: &str,
        path: &str,
        body: &str,
        token: Option<&str>,
    ) -> (u16, Value) {
        let url = format!("{}{}", self.base, path);
        let client = reqwest::Client::new();
        let mut req = if method == "GET" {
            client.get(url)
        } else {
            client
                .post(url)
                .header("Content-Type", "application/json")
                .body(body.to_string())
        };
        if let Some(token) = token {
            req = req.header("X-Indexer-Test-Token", token);
        }
        let resp = req.send().await.expect("requisição ao sidecar");
        let status = resp.status().as_u16();
        let text = resp.text().await.expect("corpo da resposta");
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn post_json(&self, path: &str, body: Value, token: Option<&str>) -> (u16, Value) {
        self.call("POST", path, &body.to_string(), token).await
    }

    async fn get(&self, path: &str, token: Option<&str>) -> (u16, Value) {
        self.call("GET", path, "", token).await
    }

    /// Semeia a fila do site de teste.
    async fn seed(&self, rows: &[UrlRow]) {
        let store = self.store.lock().await;
        store.upsert_urls(SITE, rows).expect("upsert");
    }

    /// `(status, tries, releases, progress)` de uma linha da fila.
    async fn row(&self, url_key: &str) -> (String, u32, u32, String) {
        let store = self.store.lock().await;
        store
            .conn()
            .query_row(
                "SELECT status, tries, releases, progress FROM crawl_url \
                 WHERE site = ?1 AND url_key = ?2",
                params![SITE, url_key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .expect("linha da fila")
    }

    async fn state_value(&self, key: &str) -> Option<String> {
        let store = self.store.lock().await;
        store.get_state(SITE, key).expect("get_state")
    }

    async fn set_state_value(&self, key: &str, value: &str) {
        let store = self.store.lock().await;
        store.set_state(SITE, key, value).expect("set_state");
    }
}

/// Linha da fila com o mínimo que as rotas leem.
fn url_row(url_key: &str, status: &str, progress: &str, releases: u32, tries: u32) -> UrlRow {
    UrlRow {
        site: SITE.to_string(),
        url: format!("https://nerdfilmes.example{url_key}"),
        url_key: url_key.to_string(),
        kind: "movie".to_string(),
        status: status.to_string(),
        lastmod: String::new(),
        imdb: None,
        tries,
        next_at: 0,
        checked_at: 1_000,
        releases,
        error: String::new(),
        progress: progress.to_string(),
        added_at: 1_000,
    }
}

// ─── requeue-simulated ──────────────────────────────────────────────────────

/// `simulated` E qualquer linha com progresso seco voltam a `pending` do zero;
/// gravação real fica intocada e a contagem devolvida é a das linhas tocadas.
#[tokio::test]
async fn requeue_simulated_marca_as_paginas_secas() {
    let h = Harness::new().await;
    h.seed(&[
        url_row("/a", "simulated", "", 5, 1),
        url_row("/b", "done", "{\"dry\":1}", 3, 1),
        url_row("/c", "error", "{\"dry\":1,\"e\":1}", 1, 2),
        url_row("/d", "done", "", 7, 1),
    ])
    .await;

    let (status, body) = h
        .post_json(
            "/crawl/requeue-simulated",
            json!({ "site": SITE }),
            Some(TOKEN),
        )
        .await;

    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(body["ok"].as_bool(), Some(true));
    assert_eq!(body["action"].as_str(), Some("crawl-requeue-simulated"));
    assert_eq!(body["site"].as_str(), Some(SITE));
    assert_eq!(
        body["requeued"].as_u64(),
        Some(3),
        "as três linhas contaminadas pelo passe seco"
    );
    let ids: Vec<&str> = body["ids"]
        .as_array()
        .expect("ids")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert_eq!(ids, vec!["/a", "/b", "/c"]);

    for key in ["/a", "/b", "/c"] {
        let (status, tries, releases, progress) = h.row(key).await;
        assert_eq!(status, "pending", "{key} volta para a fila");
        assert_eq!(tries, 0, "{key} recomeça sem tentativas");
        assert_eq!(
            releases, 0,
            "{key}: contagem seca é descoberta, não gravação"
        );
        assert_eq!(progress, "", "{key}: progresso seco é limpo");
    }
    let (status, _, releases, _) = h.row("/d").await;
    assert_eq!(status, "done", "gravação real não é tocada");
    assert_eq!(releases, 7, "a contagem real é preservada");
}

// ─── reprocess-no-work ──────────────────────────────────────────────────────

/// Só o `no-work` volta à fila: `error`/`done` do site ficam como estão.
#[tokio::test]
async fn reprocess_no_work_reenfileira_so_as_sem_obra() {
    let h = Harness::new().await;
    h.seed(&[
        url_row("/x", "no-work", "{\"e\":2}", 0, 2),
        url_row("/y", "no-work", "", 0, 1),
        url_row("/z", "error", "", 0, 3),
        url_row("/w", "done", "", 4, 1),
    ])
    .await;

    let (status, body) = h
        .post_json(
            "/crawl/reprocess-no-work",
            json!({ "site": SITE }),
            Some(TOKEN),
        )
        .await;

    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(body["action"].as_str(), Some("crawl-reprocess-no-work"));
    assert_eq!(body["requeued"].as_u64(), Some(2));

    let (status, tries, _, progress) = h.row("/x").await;
    assert_eq!(
        (status.as_str(), tries, progress.as_str()),
        ("pending", 0, ""),
        "o `sem obra` recomeça do zero"
    );
    let (status, _, _, _) = h.row("/y").await;
    assert_eq!(status, "pending");
    let (status, tries, _, _) = h.row("/z").await;
    assert_eq!(
        (status.as_str(), tries),
        ("error", 3),
        "`error` é do 'reprocessar erros', não desta rota"
    );
    let (status, _, _, _) = h.row("/w").await;
    assert_eq!(status, "done");
}

// ─── cursor ─────────────────────────────────────────────────────────────────

/// POST grava o estado durável e GET devolve exatamente o mesmo.
#[tokio::test]
async fn cursor_post_grava_e_get_devolve_o_mesmo() {
    let h = Harness::new().await;

    let (status, body) = h
        .post_json(
            "/crawl/cursor",
            json!({
                "site": SITE,
                "movie": "2026-10-01T00:00:00Z",
                "tv_show": "2026-10-02T00:00:00Z",
            }),
            Some(TOKEN),
        )
        .await;
    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(body["movie"].as_str(), Some("2026-10-01T00:00:00Z"));
    assert_eq!(body["tv_show"].as_str(), Some("2026-10-02T00:00:00Z"));
    assert_eq!(
        h.state_value("cursor:movie").await.as_deref(),
        Some("2026-10-01T00:00:00Z"),
        "o cursor do filme é durável no crawl_state"
    );
    assert_eq!(
        h.state_value("cursor:tv_show").await.as_deref(),
        Some("2026-10-02T00:00:00Z")
    );

    let (status, body) = h
        .get(&format!("/crawl/cursor?site={SITE}"), Some(TOKEN))
        .await;
    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(body["site"].as_str(), Some(SITE));
    assert_eq!(body["movie"].as_str(), Some("2026-10-01T00:00:00Z"));
    assert_eq!(body["tv_show"].as_str(), Some("2026-10-02T00:00:00Z"));
}

/// GET cai no cursor LEGADO (`cursor`, Fase 6) quando `cursor:movie` está
/// vazio — a mesma leitura do `cursorsView` do TS, sem migrar (quem migra é a
/// carga do motor).
#[tokio::test]
async fn cursor_get_usa_o_legado_quando_movie_esta_vazio() {
    let h = Harness::new().await;
    h.set_state_value("cursor", "2025-01-01T00:00:00Z").await;

    let (status, body) = h
        .get(&format!("/crawl/cursor?site={SITE}"), Some(TOKEN))
        .await;

    assert_eq!(status, 200, "corpo: {body}");
    assert_eq!(body["movie"].as_str(), Some("2025-01-01T00:00:00Z"));
    assert_eq!(body["tv_show"].as_str(), Some(""));
    assert_eq!(
        h.state_value("cursor:movie").await,
        None,
        "a leitura do painel não migra nem escreve"
    );
}

/// Corpo inválido (tipo errado, sintaxe quebrada, sem `site`, nada a gravar) e
/// site fora do registry são 400 — nunca 422 nem "0 mudo".
#[tokio::test]
async fn cursor_corpo_invalido_e_400() {
    let h = Harness::new().await;

    let (status, body) = h
        .call("POST", "/crawl/cursor", r#"{"site":1}"#, Some(TOKEN))
        .await;
    assert_eq!(status, 400, "campo com tipo errado: {body}");

    let (status, _) = h.call("POST", "/crawl/cursor", "{", Some(TOKEN)).await;
    assert_eq!(status, 400, "JSON quebrado");

    let (status, body) = h
        .post_json("/crawl/cursor", json!({ "movie": "x" }), Some(TOKEN))
        .await;
    assert_eq!(status, 400, "sem site: {body}");
    assert_eq!(body["error"].as_str(), Some("site obrigatório"));

    let (status, body) = h
        .post_json("/crawl/cursor", json!({ "site": SITE }), Some(TOKEN))
        .await;
    assert_eq!(status, 400, "nada a gravar: {body}");

    let (status, _) = h.get("/crawl/cursor", Some(TOKEN)).await;
    assert_eq!(status, 400, "GET sem site");

    let (status, body) = h
        .post_json(
            "/crawl/cursor",
            json!({ "site": "site-que-nao-existe", "movie": "x" }),
            Some(TOKEN),
        )
        .await;
    assert_eq!(status, 400, "site fora do registry: {body}");
    assert!(
        body["error"]
            .as_str()
            .expect("error")
            .contains("desconhecido"),
        "corpo: {body}"
    );
}

// ─── autenticação e montagem das rotas ──────────────────────────────────────

/// Todas as rotas novas exigem o MESMO token das vizinhas: sem header e com
/// token errado devolvem o status que o `/status` já devolve; com o token certo
/// atendem.
#[tokio::test]
async fn rotas_novas_exigem_o_token_das_vizinhas() {
    let h = Harness::new().await;
    let (vizinho, _) = h.get("/status", None).await;
    assert_eq!(vizinho, 401, "status da rota que já existia");

    let calls = [
        (
            "POST",
            "/crawl/requeue-simulated",
            r#"{"site":"nerdfilmes"}"#,
        ),
        (
            "POST",
            "/crawl/reprocess-no-work",
            r#"{"site":"nerdfilmes"}"#,
        ),
        ("GET", "/crawl/cursor?site=nerdfilmes", ""),
        (
            "POST",
            "/crawl/cursor",
            r#"{"site":"nerdfilmes","movie":"x"}"#,
        ),
    ];

    for (method, path, body) in calls {
        let (sem_token, _) = h.call(method, path, body, None).await;
        assert_eq!(sem_token, vizinho, "{method} {path} sem token");
        let (token_errado, _) = h.call(method, path, body, Some("token-errado")).await;
        assert_eq!(token_errado, vizinho, "{method} {path} com token errado");
        let (ok, corpo) = h.call(method, path, body, Some(TOKEN)).await;
        assert_eq!(ok, 200, "{method} {path} com o token certo: {corpo}");
    }
}

/// Rota fora das declaradas no prefixo continua 404 (nada cai num catch-all).
#[tokio::test]
async fn rota_desconhecida_do_prefixo_e_404() {
    let h = Harness::new().await;
    let (status, _) = h.get("/crawl/nada", Some(TOKEN)).await;
    assert_eq!(status, 404);
}
