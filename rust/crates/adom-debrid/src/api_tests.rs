use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;
use tower::ServiceExt;

use super::{router, InternalConfig};

const KEY: &str = "nao-logar";

fn cfg(token: &str) -> InternalConfig {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("debrid.db");
    // O tempdir precisa sobreviver ao router: vaza de propósito neste teste.
    std::mem::forget(dir);
    InternalConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        token: token.to_string(),
        debrid_db: path,
        cache_db: PathBuf::from("data/cache.db.ausente"),
        import: false,
    }
}

async fn call(token: &str, header: Option<&str>, path: &str, body: &str) -> (StatusCode, String) {
    let app = router(&cfg(token));
    let mut builder = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json");
    if let Some(value) = header {
        builder = builder.header("x-indexer-test-token", value);
    }
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

struct EnvBase {
    name: &'static str,
    prev: Option<String>,
    // Trava ÚNICA do crate: outros módulos de teste também mexem na env.
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvBase {
    fn set(name: &'static str, value: &str) -> Self {
        let lock = crate::test_env::lock();
        let prev = std::env::var(name).ok();
        // SAFETY: a trava única serializa os testes de env do crate.
        unsafe { std::env::set_var(name, value) }
        Self {
            name,
            prev,
            _lock: lock,
        }
    }
}

impl Drop for EnvBase {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var(self.name, value),
                None => std::env::remove_var(self.name),
            }
        }
    }
}

/// Várias envs sob a MESMA trava (dois `EnvBase` no mesmo teste travariam).
struct EnvVars {
    saved: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvVars {
    fn set(pairs: &[(&'static str, &str)]) -> Self {
        let _lock = crate::test_env::lock();
        let saved = pairs
            .iter()
            .map(|(name, value)| {
                let prev = std::env::var(name).ok();
                // SAFETY: a trava única serializa os testes de env do crate.
                unsafe { std::env::set_var(name, value) };
                (*name, prev)
            })
            .collect();
        Self { saved, _lock }
    }
}

impl Drop for EnvVars {
    fn drop(&mut self) {
        for (name, prev) in &self.saved {
            unsafe {
                match prev {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

/// AllDebrid falso: todo upload responde `ready` para o hash pedido.
async fn fake_alldebrid(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/upload") {
        return (
            StatusCode::OK,
            r#"{"status":"success","data":{"magnets":[{"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ready":true,"id":7}]}}"#,
        )
            .into_response();
    }
    (StatusCode::OK, r#"{"status":"success","data":{}}"#).into_response()
}

async fn local_premiumize() -> String {
    let app = Router::new().fallback(any(fake_premiumize));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

async fn fake_premiumize(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/cache/check") {
        return (
            StatusCode::OK,
            r#"{"status":"success","response":[true],"filesize":[4]}"#,
        )
            .into_response();
    }
    if path.ends_with("/transfer/directdl") {
        return (
            StatusCode::OK,
            r#"{"status":"success","content":[{"path":"leia.txt","size":4,"link":"http://127.0.0.1/x"}]}"#,
        )
            .into_response();
    }
    if path.ends_with("/account/info") {
        return (StatusCode::INTERNAL_SERVER_ERROR, format!("falha {KEY}")).into_response();
    }
    (StatusCode::NOT_FOUND, "ausente").into_response()
}

#[tokio::test]
async fn sem_token_configurado_responde_503() {
    let (status, body) = call(
        "",
        Some("qualquer"),
        "/debrid/check",
        r#"{"service":"premiumize"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("debrid_internal_disabled"));
}

#[tokio::test]
async fn token_errado_responde_401() {
    let (status, _) = call(
        "segredo",
        Some("outro"),
        "/debrid/check",
        r#"{"service":"premiumize"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn query_token_nao_autentica() {
    let app = router(&cfg("segredo"));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/debrid/check?token=segredo")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"service":"premiumize"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn premiumize_no_loopback_nao_devolve_501() {
    let base = local_premiumize().await;
    let _env = EnvBase::set("PREMIUMIZE_API_BASE", &base);
    let check_body =
        format!(r#"{{"service":"premiumize","apiKey":"{KEY}","hashes":["abc"],"timeoutMs":2000}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &check_body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["complete"].as_bool(), Some(true));
    assert_eq!(json["cached"][0].as_str(), Some("abc"));

    let link_body = format!(
        r#"{{"service":"premiumize","apiKey":"{KEY}","hash":"abc","episode":{{"season":1,"episode":2,"work":{{"names":["Obra"],"year":2020,"pack":false}}}}}}"#
    );
    let (status, body) = call("segredo", Some("segredo"), "/debrid/link", &link_body).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["error"].as_str(), Some("no_video"));
    assert_eq!(json["kind"].as_str(), Some("no_video"));
    assert!(json["message"].is_string());

    let files_body =
        format!(r#"{{"service":"premiumize","apiKey":"{KEY}","hash":"abc","path":"filme.mkv"}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/files", &files_body).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body.trim(), "null");
    assert!(!body.contains(KEY));

    let account_body = format!(r#"{{"service":"premiumize","apiKey":"{KEY}"}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/account", &account_body).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["kind"].as_str(), Some("other"));
    assert!(json["message"].is_string());
}

#[tokio::test]
async fn torbox_e_alldebrid_respondem_no_http_sem_vazar_chave() {
    // TorBox e AllDebrid: mock em loopback (NUNCA a base real) → upstream 500
    // vira veredito known:false, sem "service_not_ported".
    let app = Router::new().fallback(any(async |_req: Request<Body>| {
        (StatusCode::INTERNAL_SERVER_ERROR, "fora do ar").into_response()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let _env = EnvVars::set(&[("TORBOX_API_BASE", &base), ("ALLDEBRID_API_BASE", &base)]);
    let torbox_body = format!(r#"{{"service":"torbox","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &torbox_body).await;
    assert_eq!(status, StatusCode::OK, "torbox: {body}");
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
    assert_eq!(json["unusable"], serde_json::Value::Null);

    let ad_body = format!(r#"{{"service":"alldebrid","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, body) = call("segredo", Some("segredo"), "/debrid/check", &ad_body).await;
    assert_eq!(status, StatusCode::OK, "alldebrid: {body}");
    assert!(!body.contains("service_not_ported"));
    assert!(!body.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
}

#[tokio::test]
async fn alldebrid_check_nativo_sem_vazar_chave() {
    let app = Router::new().fallback(any(fake_alldebrid));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let _env = EnvVars::set(&[("ALLDEBRID_API_BASE", &base)]);
    let body = format!(
        r#"{{"service":"alldebrid","apiKey":"{KEY}","hashes":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"timeoutMs":2000}}"#
    );
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK, "allDebrid nativo: {raw}");
    assert!(!raw.contains(KEY), "a chave não pode voltar no corpo");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        json["cached"][0].as_str(),
        Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    );
    assert_eq!(json["complete"].as_bool(), Some(true));
    assert_eq!(json["known"].as_bool(), Some(true));
    assert_eq!(json["unusable"], serde_json::Value::Null);
}

#[tokio::test]
async fn alldebrid_check_nativo_sem_chave_e_unknown() {
    let body = r#"{"service":"alldebrid","apiKey":"","hashes":["abc"]}"#;
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", body).await;
    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));
    assert_eq!(json["complete"].as_bool(), Some(false));
}

#[tokio::test]
async fn debridlink_check_vazio_e_rotas_sem_metodo_ficam_501() {
    let body = format!(r#"{{"service":"debridlink","apiKey":"{KEY}","hashes":["abc"]}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!raw.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["cached"].as_array().map(|rows| rows.len()), Some(0));
    // `cacheCheck=false` no Node: vazio é "não sei", nunca "nada em cache".
    assert_eq!(json["complete"].as_bool(), Some(false));
    assert_eq!(json["known"].as_bool(), Some(false));

    // Real-Debrid: sem entrada no ledger → known:false, nunca "nada em cache".
    let (status, raw) = call(
        "segredo",
        Some("segredo"),
        "/debrid/check",
        r#"{"service":"realdebrid","apiKey":"nao-logar","hashes":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}"#,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!raw.contains("service_not_ported"));
    assert!(!raw.contains(KEY));
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["known"].as_bool(), Some(false));

    for path in ["/debrid/account", "/debrid/files"] {
        let (status, raw) = call("segredo", Some("segredo"), path, &body).await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
        assert!(raw.contains("service_not_ported"));
        assert!(!raw.contains(KEY));
    }

    let (status, raw) = call(
        "segredo",
        Some("segredo"),
        "/debrid/check",
        r#"{"service":"outro"}"#,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(raw.contains("unknown_service"));
}

#[test]
fn escuta_fora_do_loopback_e_recusada() {
    assert!(super::parse_listen("0.0.0.0:8710").is_err());
    assert!(super::parse_listen("127.0.0.1:8710").is_ok());
}

// ── Limpeza nativa pela rota (fatos no corpo) ───────────────────────────────

struct CleanupScene {
    deletes: AtomicUsize,
    last_query: std::sync::Mutex<Option<String>>,
}

fn cleanup_scene() -> Arc<CleanupScene> {
    Arc::new(CleanupScene {
        deletes: AtomicUsize::new(0),
        last_query: std::sync::Mutex::new(None),
    })
}

/// Upload fixo: 'a' pronto (id 97) e 'c' frio (id 99).
async fn fake_alldebrid_cleanup(
    State(scene): State<Arc<CleanupScene>>,
    req: Request<Body>,
) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/upload") {
        return (
            StatusCode::OK,
            r#"{"status":"success","data":{"magnets":[
                {"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ready":true,"id":97},
                {"hash":"cccccccccccccccccccccccccccccccccccccccc","ready":false,"id":99}
            ]}}"#,
        )
            .into_response();
    }
    if path.ends_with("/magnet/delete") {
        scene.deletes.fetch_add(1, Ordering::SeqCst);
        *scene.last_query.lock().unwrap() = Some(query);
        return (StatusCode::OK, r#"{"status":"success","data":{}}"#).into_response();
    }
    (StatusCode::OK, r#"{"status":"success","data":{}}"#).into_response()
}

async fn local_cleanup_alldebrid() -> (String, Arc<CleanupScene>) {
    let scene = cleanup_scene();
    let app = Router::new()
        .fallback(any(fake_alldebrid_cleanup))
        .with_state(scene.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), scene)
}

async fn wait_deletes(scene: &CleanupScene, min: usize) -> bool {
    for _ in 0..100 {
        if scene.deletes.load(Ordering::SeqCst) >= min {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test]
async fn alldebrid_limpeza_pela_rota_usa_os_fatos_do_corpo() {
    let (base, scene) = local_cleanup_alldebrid().await;
    let dir = tempfile::tempdir().unwrap();
    let cache_str = dir.path().join("cache.db").to_string_lossy().to_string();
    let _env = EnvVars::set(&[
        ("ALLDEBRID_API_BASE", &base),
        ("DEBRID_AL_CLEANUP", "on"),
        ("CACHE_DB_PATH", cache_str.as_str()),
    ]);
    let hash_a = "a".repeat(40);
    let hash_c = "c".repeat(40);
    // `knownBefore` protege o pronto que já era do usuário; o frio novo sai.
    let body = format!(
        r#"{{"service":"alldebrid","apiKey":"nao-logar","hashes":["{hash_a}","{hash_c}"],
             "inventoryLoaded":true,"knownBefore":["{hash_a}"],"heldHashes":[],
             "holdsComplete":true}}"#
    );
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["cached"][0].as_str(), Some(hash_a.as_str()));
    assert!(
        wait_deletes(&scene, 1).await,
        "a fila de delete roda em fundo"
    );
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 1);
    let last = scene.last_query.lock().unwrap().clone().unwrap_or_default();
    assert!(last.contains("id=99"), "só o frio novo saiu: {last}");
}

#[tokio::test]
async fn torbox_link_nao_devolve_501() {
    // O 8710 precisa despachar o play do TorBox: antes caía em 501 e a chave
    // só voltava ao TS. O mock responde 500 (nunca a base real) — o que se
    // prova aqui é que a rota CHAMA o adaptador e não vaza a credencial.
    let app = Router::new().fallback(any(async |_req: Request<Body>| {
        (StatusCode::INTERNAL_SERVER_ERROR, "fora do ar").into_response()
    }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let _env = EnvVars::set(&[("TORBOX_API_BASE", &base)]);
    let body = format!(r#"{{"service":"torbox","apiKey":"{KEY}","hash":"abc"}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/link", &body).await;
    assert_ne!(status, StatusCode::NOT_IMPLEMENTED, "torbox link: {raw}");
    assert!(!raw.contains("service_not_ported"));
    assert!(!raw.contains(KEY));
}

#[tokio::test]
async fn alldebrid_limpeza_sem_holds_completos_nao_apaga() {
    let (base, scene) = local_cleanup_alldebrid().await;
    let dir = tempfile::tempdir().unwrap();
    let cache_str = dir.path().join("cache.db").to_string_lossy().to_string();
    let _env = EnvVars::set(&[
        ("ALLDEBRID_API_BASE", &base),
        ("DEBRID_AL_CLEANUP", "on"),
        ("CACHE_DB_PATH", cache_str.as_str()),
    ]);
    let body = format!(
        r#"{{"service":"alldebrid","apiKey":"nao-logar","hashes":["{}","{}"],
             "inventoryLoaded":true,"knownBefore":[],"heldHashes":[],
             "holdsComplete":false}}"#,
        "a".repeat(40),
        "c".repeat(40)
    );
    let (status, _raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert_eq!(
        scene.deletes.load(Ordering::SeqCst),
        0,
        "sem a prova dos holds do autofetch, ninguém sai"
    );
}
