use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::extract::State;

use super::*;

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

// ── Anti-reenchimento (`adrm:v1`) pela rota ─────────────────────────────────

/// AllDebrid falso que CONTA os uploads e guarda a query (o que trafegou).
struct UploadScene {
    uploads: AtomicUsize,
    last_query: std::sync::Mutex<Option<String>>,
}

async fn fake_alldebrid_upload(
    State(scene): State<Arc<UploadScene>>,
    req: Request<Body>,
) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/upload") {
        scene.uploads.fetch_add(1, Ordering::SeqCst);
        *scene.last_query.lock().unwrap() = Some(query);
        return (
            StatusCode::OK,
            r#"{"status":"success","data":{"magnets":[{"hash":"cccccccccccccccccccccccccccccccccccccccc","ready":true,"id":99}]}}"#,
        )
            .into_response();
    }
    (StatusCode::OK, r#"{"status":"success","data":{}}"#).into_response()
}

/// `cache.db` mínimo do Node com as chaves dadas (todas vivas).
fn cache_db_with(dir: &std::path::Path, keys: &[String]) -> PathBuf {
    let path = dir.join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    let expires = crate::error::now_ms() as i64 + 60_000;
    for key in keys {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![key, expires],
        )
        .unwrap();
    }
    path
}

/// O hash com `adrm:v1` vivo NÃO chega ao `/magnet/upload` da checagem — que é
/// a própria consulta de cache. Vale com a limpeza OFF (é filtro de upload) e
/// o hash livre segue sendo perguntado normalmente.
#[tokio::test]
async fn alldebrid_adrm_nao_sobe_hash_bloqueado_pela_rota() {
    let scene = Arc::new(UploadScene {
        uploads: AtomicUsize::new(0),
        last_query: std::sync::Mutex::new(None),
    });
    let app = Router::new()
        .fallback(any(fake_alldebrid_upload))
        .with_state(scene.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{addr}");
    let blocked = "a".repeat(40);
    let free = "c".repeat(40);
    let account = crate::alldebrid_cleanup::account_scope(KEY);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db_with(
        dir.path(),
        &[crate::alldebrid_cleanup::adrm_key(&account, &blocked)],
    );
    let cache_str = path.to_string_lossy().to_string();
    let _env = EnvVars::set(&[
        ("ALLDEBRID_API_BASE", &base),
        ("CACHE_DB_PATH", cache_str.as_str()),
        ("DEBRID_AL_CLEANUP", "off"),
    ]);
    let body = format!(
        r#"{{"service":"alldebrid","apiKey":"{KEY}","hashes":["{blocked}","{free}"],"timeoutMs":2000}}"#
    );
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/check", &body).await;
    assert_eq!(status, StatusCode::OK, "{raw}");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(json["known"].as_bool(), Some(true));
    assert_eq!(json["cached"].as_array().map(|rows| rows.len()), Some(1));
    assert_eq!(json["cached"][0].as_str(), Some(free.as_str()));
    assert_eq!(
        scene.uploads.load(Ordering::SeqCst),
        1,
        "só o hash livre foi ao upload"
    );
    let query = scene.last_query.lock().unwrap().clone().unwrap_or_default();
    assert!(
        !query.contains(&blocked),
        "o hash bloqueado não pode ir ao /magnet/upload: {query}"
    );
    assert!(query.contains(&free), "o hash livre precisa ir: {query}");
}
