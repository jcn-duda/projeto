use axum::body::Body;
use http::{Request, StatusCode};
use serde_json::{json, Value};

use crate::acervo::info_hash;
use crate::tests::{call, spawn_gateway, TOKEN};

const HASH: &str = "87f3ffe0d854a457122c42ace769fb261e78c7c0";

fn get(path: &str, token: Option<&str>) -> Request<Body> {
    let mut req = Request::builder().uri(path);
    if let Some(t) = token {
        req = req.header("X-Indexer-Test-Token", t);
    }
    req.body(Body::empty()).unwrap()
}

fn work(imdb: Option<&str>, status: &str) -> Value {
    json!({
        "url": "https://www.xfilmeshd.org/anjo-negro-2025/",
        "url_key": "/anjo-negro-2025",
        "site": "nerdfilmes",
        "status": status,
        "imdb": imdb,
        "title": "Anjo Negro",
        "year": 2025,
        "kind": "movie",
        "releases": [
            { "title": "Anjo Negro 1080p", "magnet": format!("magnet:?xt=urn:btih:{HASH}&dn=x"),
              "link": null, "size": null, "seeders": null, "tracker": "NerdFilmes", "is_br": true },
            { "title": "sem magnet", "magnet": null, "link": "https://x/link.php",
              "size": null, "seeders": null, "tracker": null, "is_br": true }
        ],
        "groups": [],
        "unlocated": [],
        "progress": null,
        "request_cost": 2,
        "error": ""
    })
}

fn post(body: &Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/internal/crawl-result")
        .header("X-Indexer-Test-Token", TOKEN)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

#[tokio::test]
async fn sem_node_rota_nao_portada_e_501_e_health_responde() {
    let server = spawn_gateway(None, true).await;
    let (status, _) = call(server, get("/manifest.json", None)).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, body) = call(server, get("/health", None)).await;
    assert_eq!((status, body.as_str()), (StatusCode::OK, r#"{"ok":true}"#));
}

#[tokio::test]
async fn rotas_internas_exigem_o_token() {
    let server = spawn_gateway(None, true).await;
    let (status, _) = call(server, get("/internal/activity", None)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(server, get("/acervo.json", Some("errado"))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn freio_ve_o_trafego_do_usuario() {
    let server = spawn_gateway(None, true).await;
    let path = "/internal/activity?window_ms=60000";
    let (_, body) = call(server, get(path, Some(TOKEN))).await;
    assert_eq!(body, r#"{"recent":false}"#, "ocioso no boot");
    let _ = call(server, get("/stream/movie/tt1.json", None)).await;
    let (_, body) = call(server, get(path, Some(TOKEN))).await;
    assert_eq!(body, r#"{"recent":true}"#);
}

#[tokio::test]
async fn pagina_raspada_vai_ao_acervo_sem_duplicar() {
    let server = spawn_gateway(None, true).await;
    let (status, body) = call(server, post(&work(Some("tt1234567"), "done"))).await;
    assert_eq!(status, StatusCode::OK);
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        (reply["kept"].as_u64(), reply["added"].as_u64()),
        (Some(1), Some(1))
    );
    let (_, body) = call(server, post(&work(Some("tt1234567"), "done"))).await;
    let reply: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(reply["added"], 0, "a mesma release não duplica");

    let (_, body) = call(server, get("/acervo.json?imdb=tt1234567", Some(TOKEN))).await;
    let listed: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(listed["count"], 1);
    assert_eq!(listed["releases"][0]["isBr"], true);
}

#[tokio::test]
async fn sem_imdb_guarda_e_erro_nao_grava() {
    let server = spawn_gateway(None, true).await;
    let (_, body) = call(server, post(&work(None, "done"))).await;
    assert!(
        body.contains(r#""added":1"#),
        "página sem IMDb não é descartada: {body}"
    );
    let (_, body) = call(server, post(&work(Some("tt7"), "error"))).await;
    assert!(body.contains(r#""added":0"#));
    let (_, body) = call(server, get("/acervo.json", Some(TOKEN))).await;
    let stats: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(stats["sites"][0]["releases"], 1);
    assert_eq!(stats["sites"][0]["sem_imdb"], 1);
}

#[test]
fn info_hash_hex_e_base32() {
    assert_eq!(
        info_hash(&format!("magnet:?xt=urn:btih:{}&dn=a", HASH.to_uppercase())).as_deref(),
        Some(HASH)
    );
    let b32 = "magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    assert_eq!(
        info_hash(b32).as_deref(),
        Some("abcdefghijklmnopqrstuvwxyz234567")
    );
    assert_eq!(info_hash("magnet:?xt=urn:btih:curto"), None);
    assert_eq!(info_hash("https://x/link.php"), None);
}
