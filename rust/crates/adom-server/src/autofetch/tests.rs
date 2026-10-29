//! Testes das rotas do worker nativo do Chupim (`/autofetch*`).
//!
//! O Router REAL da admin sobe em `127.0.0.1:0` (porta efêmera) com o
//! middleware de token: status, corpo e efeito no KV são o contrato que o
//! painel consome. `tower` não é dependência do crate — nada de `oneshot`;
//! `axum::serve` + o cliente do proxy provam a rota de ponta a ponta.

use std::sync::Arc;

use adom_index::NativeKv;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::worker::AutofetchHandle;

const TOKEN: &str = "token-de-teste";
const CONFIG_KEY: &str = "autofetch-worker:v1:config";
const QUEUE_PREFIX: &str = "autofetch:v3:q:";
const LOT_PREFIX: &str = "autofetch:v3:lot:";

/// Admin de verdade (loopback + `X-Indexer-Test-Token`) em porta efêmera.
struct Admin {
    base: String,
}

impl Admin {
    /// Admin com o worker montado sobre `kv` (o caso normal do boot).
    async fn with_worker(kv: Arc<NativeKv>) -> Self {
        Self::mount(Some(AutofetchHandle::with_store(kv))).await
    }

    /// Admin sem worker (`autofetch: None`: store indisponível no boot).
    async fn without_worker() -> Self {
        Self::mount(None).await
    }

    async fn mount(autofetch: Option<AutofetchHandle>) -> Self {
        let cfg = crate::store_admin::AdminConfig {
            listen: crate::store_admin::DEFAULT_LISTEN.parse().unwrap(),
            token: TOKEN.to_string(),
            // Rotas não destrutivas: a segunda credencial fica ausente.
            destructive_token: None,
        };
        let store = Arc::new(adom_store::StreamsStore::open_memory_with_quota(8).unwrap());
        let app = crate::store_admin::router_with_ownership(
            &cfg,
            store,
            300,
            None,
            autofetch,
            None,
            crate::ownership_admin::router(),
            None,
            None,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: format!("http://{addr}"),
        }
    }

    async fn call(&self, req: Request<Body>) -> (StatusCode, Value) {
        let client = crate::proxy::client();
        let (mut parts, body) = req.into_parts();
        let pq = parts
            .uri
            .path_and_query()
            .map(|item| item.as_str().to_string())
            .unwrap_or_else(|| "/".to_string());
        parts.uri = format!("{}{pq}", self.base).parse().unwrap();
        let response = client
            .request(Request::from_parts(parts, body))
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }
}

fn get(path: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header("x-indexer-test-token", token)
        .body(Body::empty())
        .unwrap()
}

fn post(path: &str, body: Value, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("x-indexer-test-token", token)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn status_expoe_contrato_preparado_com_fila_hidratada() {
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    for suffix in ["a", "b", "c"] {
        kv.put_json(
            &format!("{QUEUE_PREFIX}{suffix}"),
            &json!([{ "infoHash": "0123456789abcdef" }]),
            600,
            now,
        )
        .unwrap();
    }
    kv.put_json(
        &format!("{LOT_PREFIX}lote1"),
        &json!({ "attempts": 1 }),
        600,
        now,
    )
    .unwrap();
    let admin = Admin::with_worker(kv).await;

    let (status, body) = admin.call(get("/autofetch", TOKEN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    let out = &body["status"];
    assert_eq!(out["enabled"], false);
    assert_eq!(out["phase"], "prepared");
    assert_eq!(out["paused"], false);
    // Profundidade REAL lida do KV v3 (o worker não enfileira nem consome).
    assert_eq!(out["queueDepth"], 3);
    assert_eq!(out["lots"], 1);
    assert_eq!(out["inflight"], false);
    assert_eq!(out["intervalMs"], 60_000);
}

#[tokio::test]
async fn config_recusa_campo_desconhecido_e_intervalo_fora_de_faixa() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv.clone()).await;

    for body in [
        json!({ "foo": 1 }),
        json!({ "intervalMs": 0 }),
        json!({ "intervalMs": 3_600_001 }),
        json!({ "paused": "sim" }),
        // Credencial de usuário nunca é campo desta rota.
        json!({ "dk": "segredo" }),
        json!({ "apiKey": "segredo" }),
    ] {
        let (status, out) = admin
            .call(post("/autofetch/config", body.clone(), TOKEN))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} => {out}");
    }
    assert!(
        kv.get_json(CONFIG_KEY, adom_sources::now_ms())
            .unwrap()
            .is_none(),
        "recusa não pode persistir nada"
    );
}

#[tokio::test]
async fn config_persistida_sobrevive_ao_handle_reaberto() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv.clone()).await;

    let (status, body) = admin
        .call(post(
            "/autofetch/config",
            json!({ "paused": true, "intervalMs": 12_345 }),
            TOKEN,
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"]["paused"], true);
    assert_eq!(body["status"]["intervalMs"], 12_345);

    // O KV guarda SÓ pausa e intervalo — nenhum campo de credencial.
    let persisted = kv
        .get_json(CONFIG_KEY, adom_sources::now_ms())
        .unwrap()
        .unwrap();
    assert_eq!(persisted, json!({ "paused": true, "intervalMs": 12_345 }));

    // Restart do gateway: o handle novo relê a config do KV.
    let reopened = AutofetchHandle::with_store(kv);
    let out = reopened.status();
    assert!(out.paused);
    assert_eq!(out.interval_ms, 12_345);
    assert!(!out.enabled);
    assert_eq!(out.phase, "prepared");
}

#[tokio::test]
async fn pause_exige_somente_o_booleano() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv).await;

    let (status, body) = admin
        .call(post("/autofetch/pause", json!({ "paused": true }), TOKEN))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"]["paused"], true);

    for body in [
        json!({}),
        json!({ "paused": 1 }),
        json!({ "paused": "true" }),
        json!({ "paused": true, "intervalMs": 1_000 }),
    ] {
        let (status, out) = admin
            .call(post("/autofetch/pause", body.clone(), TOKEN))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body} => {out}");
    }
}

#[tokio::test]
async fn drain_e_suppressed_drain_respondem_prepared_sem_efeito() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv).await;

    for (path, operation) in [
        ("/autofetch/drain", "drain"),
        ("/autofetch/suppressed-drain", "suppressed-drain"),
    ] {
        let (status, body) = admin.call(post(path, json!({}), TOKEN)).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
        assert_eq!(body["phase"], "prepared");
        assert_eq!(body["enabled"], false);
        assert_eq!(body["effect"], "none");
        assert_eq!(body["drained"], 0);
        assert_eq!(body["operation"], operation);
    }
}

#[tokio::test]
async fn sem_token_401_e_sem_worker_503() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv).await;
    assert_eq!(
        admin.call(get("/autofetch", "outro-token")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        admin.call(get("/autofetch", "")).await.0,
        StatusCode::UNAUTHORIZED
    );

    let sem_worker = Admin::without_worker().await;
    let (status, body) = sem_worker.call(get("/autofetch", TOKEN)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"]["phase"], "unavailable");
    assert_eq!(body["status"]["queueDepth"], 0);
    assert_eq!(body["status"]["lots"], 0);

    let (status, body) = sem_worker
        .call(post("/autofetch/config", json!({ "paused": true }), TOKEN))
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["error"], "autofetch_worker_unavailable");
    for path in ["/autofetch/drain", "/autofetch/suppressed-drain"] {
        let (status, _) = sem_worker.call(post(path, json!({}), TOKEN)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}");
    }
}

/// Regressão: o worker desta fatia só administra estado. Nada de enfileirar,
/// nada de criar lote de recheck nem marker — a fila do KV fica intocada.
#[tokio::test]
async fn worker_preparado_nao_enfileira_nem_escreve_na_fila_v3() {
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    let admin = Admin::with_worker(kv.clone()).await;

    for req in [
        get("/autofetch", TOKEN),
        post(
            "/autofetch/config",
            json!({ "paused": false, "intervalMs": 60_000 }),
            TOKEN,
        ),
        post("/autofetch/pause", json!({ "paused": false }), TOKEN),
        post("/autofetch/drain", json!({}), TOKEN),
        post("/autofetch/suppressed-drain", json!({}), TOKEN),
    ] {
        let (status, body) = admin.call(req).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        if let Some(out) = body.get("status") {
            assert_eq!(out["phase"], "prepared");
            assert_eq!(out["enabled"], false);
        }
    }

    let now = adom_sources::now_ms();
    assert!(
        kv.keys_matching(QUEUE_PREFIX, now).unwrap().is_empty(),
        "worker preparado não enfileira"
    );
    assert!(
        kv.keys_matching(LOT_PREFIX, now).unwrap().is_empty(),
        "worker preparado não cria lote de recheck"
    );
    // A ÚNICA chave `autofetch*` que a admin escreve é a config.
    assert_eq!(
        kv.keys_matching("autofetch", now).unwrap(),
        vec![CONFIG_KEY.to_string()]
    );
}
