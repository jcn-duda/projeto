//! Testes das rotas da represa: `POST /autofetch/suppressed-drain` e os campos
//! `suppressed` / `lastSuppressedDrain` do `GET /autofetch`.
//!
//! O Router REAL da admin sobe em `127.0.0.1:0` (loopback + token), como em
//! `autofetch/tests.rs`. A diferença é o KV das chaves (`ownership_kv`), que
//! aqui é injetado: é dele que a rota lê e escreve a represa.

use std::sync::Arc;

use adom_autofetch::v3::SuppressedV3;
use adom_index::NativeKv;
use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::suppressed_step;
use crate::autofetch::control::Control;
use crate::autofetch::fakes::{factory_for, FakeDebrid, SCOPE};
use crate::autofetch::ports::DebridIo;
use crate::autofetch::worker::AutofetchHandle;

const TOKEN: &str = "token-de-teste";
const ADAPTER: &str = "alldebrid";
const ACCOUNT: &str = "conta-de-teste";
const TTL: i64 = 600;
/// Knob estático do dreno (`DEBRID_REMOVE_BY_ID`, default OFF).
const KNOB: &str = "DEBRID_REMOVE_BY_ID";

/// `DEBRID_REMOVE_BY_ID` controlado no teste: segura o MESMO lock dos testes de
/// `Policy` (`build::test_lock`, porque `std::env` é global) e devolve o valor
/// anterior no `Drop`, mesmo quando a asserção falha.
struct KnobScope {
    _lock: std::sync::MutexGuard<'static, ()>,
    saved: Option<String>,
}

impl KnobScope {
    fn value(raw: Option<&str>) -> Self {
        let lock = crate::autofetch::build::test_lock();
        let saved = std::env::var(KNOB).ok();
        match raw {
            Some(value) => std::env::set_var(KNOB, value),
            None => std::env::remove_var(KNOB),
        }
        Self { _lock: lock, saved }
    }
}

impl Drop for KnobScope {
    fn drop(&mut self) {
        match &self.saved {
            Some(value) => std::env::set_var(KNOB, value),
            None => std::env::remove_var(KNOB),
        }
    }
}

/// Hash sintético distinto por `n` (40 hex, como o infoHash real).
fn hash(n: u8) -> String {
    format!("{n:040x}")
}

/// Admin de verdade (loopback + `X-Indexer-Test-Token`) em porta efêmera, com o
/// KV das chaves injetado (`Some` = o mesmo `cache.db` do worker no boot).
struct Admin {
    base: String,
}

impl Admin {
    async fn mount(
        autofetch: Option<AutofetchHandle>,
        ownership_kv: Option<Arc<NativeKv>>,
    ) -> Self {
        let cfg = crate::store_admin::AdminConfig {
            listen: crate::store_admin::DEFAULT_LISTEN.parse().unwrap(),
            token: TOKEN.to_string(),
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
            ownership_kv,
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

fn get(path: &str) -> Request<Body> {
    Request::builder()
        .uri(path)
        .header("x-indexer-test-token", TOKEN)
        .body(Body::empty())
        .unwrap()
}

fn post(path: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(path)
        .header("x-indexer-test-token", TOKEN)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

/// Sem worker ligado (`enabled:false`) a rota responde `drained:0` + motivo e
/// NÃO toca a represa — nunca 500, mesmo com entrada represada no KV.
#[tokio::test]
async fn rota_sem_worker_responde_motivo_e_nao_drena() {
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(1), "id-1", TTL, now)
        .unwrap();
    let admin = Admin::mount(
        Some(AutofetchHandle::with_store(Arc::clone(&kv))),
        Some(Arc::clone(&kv)),
    )
    .await;

    let (status, body) = admin
        .call(post("/autofetch/suppressed-drain", json!({})))
        .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["operation"], "suppressed-drain");
    assert_eq!(body["enabled"], false);
    assert_eq!(body["effect"], "none");
    assert_eq!(body["drained"], 0);
    assert_eq!(body["reason"], "worker-disabled");
    // Nada foi apagado: a represa continua com a entrada dela.
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 1);
}

/// `suppressed` do `GET /autofetch` é a profundidade do KV; com worker vivo e
/// fábrica registrada a rota drena de verdade e publica `lastSuppressedDrain`.
#[tokio::test]
async fn get_autofetch_conta_a_represa_e_o_dreno_devolve_contadores() {
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    for n in 0..2 {
        SuppressedV3::new(&kv)
            .note(ADAPTER, ACCOUNT, &hash(n), &format!("id-{n}"), TTL, now)
            .unwrap();
    }
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount(Some(handle), Some(Arc::clone(&kv))).await;

    // Antes do dreno: a profundidade do painel é a do KV (2) e não há passo.
    let (status, body) = admin.call(get("/autofetch")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"]["enabled"], true, "{body}");
    assert_eq!(body["status"]["suppressed"], 2, "{body}");
    assert_eq!(body["status"]["suppressedSource"], "kv", "{body}");
    assert_eq!(body["status"]["lastSuppressedDrain"], Value::Null, "{body}");

    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    let (status, body) = admin
        .call(post(
            "/autofetch/suppressed-drain",
            json!({ "confirm": true }),
        ))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["effect"], "applied", "{body}");
    assert_eq!(body["drained"], 2, "{body}");
    assert_eq!(body["operations"], 2, "{body}");
    assert_eq!(body["dropped"], 2, "{body}");
    assert_eq!(body["kept"], 0, "{body}");
    assert_eq!(body["failed"], 0, "{body}");
    assert_eq!(body["suppressed"], 0, "{body}");
    let mut removed = debrid.removed();
    removed.sort();
    assert_eq!(removed, vec!["id-0".to_string(), "id-1".to_string()]);

    // Depois: KV vazio e painel com o último passo (contadores + timestamp).
    assert_eq!(
        suppressed_step::count(&kv, adom_sources::now_ms()).unwrap(),
        0
    );
    let (_, body) = admin.call(get("/autofetch")).await;
    assert_eq!(body["status"]["suppressed"], 0, "{body}");
    assert_eq!(
        body["status"]["lastSuppressedDrain"]["dropped"], 2,
        "{body}"
    );
    assert_eq!(
        body["status"]["lastSuppressedDrain"]["operations"], 2,
        "{body}"
    );
    assert!(
        body["status"]["lastSuppressedDrain"]["at"]
            .as_i64()
            .unwrap()
            > 0,
        "{body}"
    );
    suppressed_step::clear();
}

/// Sem `confirm` e com o knob OFF (o default) a rota NÃO drena: `effect:"none"`,
/// `reason`/`gate` = `remove-by-id-off`, serviço intocado e represa intacta —
/// apagar por id sem confirmação é o buraco que esta rota fechou.
#[tokio::test]
async fn rota_sem_confirm_e_knob_off_nao_apaga() {
    let knob = KnobScope::value(None);
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(7), "id-7", TTL, now)
        .unwrap();
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount(Some(handle), Some(Arc::clone(&kv))).await;
    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    // Corpo `{}`: o painel antigo (sem confirmação) cai no gate do knob.
    let (status, body) = admin
        .call(post("/autofetch/suppressed-drain", json!({})))
        .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["operation"], "suppressed-drain", "{body}");
    assert_eq!(body["effect"], "none", "{body}");
    assert_eq!(body["drained"], 0, "{body}");
    assert_eq!(body["reason"], "remove-by-id-off", "{body}");
    assert_eq!(body["gate"], "remove-by-id-off", "{body}");
    assert_eq!(body["kept"], 1, "{body}");
    assert_eq!(body["operations"], 0, "{body}");
    assert!(debrid.removed().is_empty(), "{:?}", debrid.removed());
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 1);
    drop(knob);
    suppressed_step::clear();
}

/// `{"confirm":true}` libera o `force` do operador: com o knob OFF o dreno roda
/// AQUI, apaga pelo id atual e responde `effect:"applied"`.
#[tokio::test]
async fn rota_com_confirm_forca_o_dreno_com_o_knob_off() {
    let knob = KnobScope::value(None);
    let _guard = suppressed_step::test_lock().await;
    suppressed_step::clear();
    let now = adom_sources::now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    SuppressedV3::new(&kv)
        .note(ADAPTER, ACCOUNT, &hash(8), "id-8", TTL, now)
        .unwrap();
    let handle =
        AutofetchHandle::stub_enabled(Arc::clone(&kv), None, Arc::new(Control::new(false, 60_000)));
    let admin = Admin::mount(Some(handle), Some(Arc::clone(&kv))).await;
    let debrid = Arc::new(FakeDebrid::accepting());
    let io: DebridIo = debrid.clone();
    suppressed_step::register_factory(factory_for(SCOPE, io));

    let (status, body) = admin
        .call(post(
            "/autofetch/suppressed-drain",
            json!({ "confirm": true }),
        ))
        .await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["effect"], "applied", "{body}");
    assert_eq!(body["drained"], 1, "{body}");
    assert_eq!(body["operations"], 1, "{body}");
    assert_eq!(body["gate"], Value::Null, "{body}");
    assert_eq!(debrid.removed(), vec!["id-8".to_string()]);
    assert_eq!(suppressed_step::count(&kv, now).unwrap(), 0);
    drop(knob);
    suppressed_step::clear();
}
