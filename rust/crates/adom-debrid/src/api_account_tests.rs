//! `/debrid/account` pela rota 8710: o corpo tem que ser indistinguível do que
//! o adaptador TS devolvia (o Node usa o `remote.json` direto). Mock sempre em
//! loopback, nunca a base real; a chave não volta no corpo.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use tokio::net::TcpListener;

use crate::api::api_test_support::{call, EnvVars};

/// Chave de mentira reconhecível: se vazar, o assert encontra.
const SECRET: &str = "chave-nao-pode-vazar-4242";

async fn serve(app: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn keys(json: &serde_json::Value) -> Vec<String> {
    let mut out: Vec<String> = json
        .as_object()
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    out.sort_unstable();
    out
}

/// `/magnet/status` com um pronto e um baixando (o mesmo shape da v4.1).
async fn fake_alldebrid_account(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/status") {
        return (
            StatusCode::OK,
            r#"{"status":"success","data":{"magnets":[
                {"id":1,"hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"Ready","ready":true,"uploadDate":1700000000,"size":100},
                {"id":2,"hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","status":"Downloading","uploadDate":1600000000,"size":50}
            ]}}"#,
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "ausente").into_response()
}

/// `/torrents/mylist` com uma linha pronta e uma de `download_state` que o
/// adaptador não conhece (sem prova de morte, ocupa vaga).
async fn fake_torbox_account(req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let _ = req.into_body().collect().await;
    if path.ends_with("/torrents/mylist") {
        return (
            StatusCode::OK,
            r#"{"success":true,"data":[
                {"id":1,"hash":"aaaa","download_state":"completed","download_finished":true,"download_present":true},
                {"id":2,"hash":"bbbb","download_state":"estado-que-o-addon-nao-conhece","download_finished":false,"download_present":false}
            ]}"#,
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "ausente").into_response()
}

#[tokio::test]
async fn alldebrid_account_tem_o_shape_do_ts() {
    let base = serve(Router::new().fallback(any(fake_alldebrid_account))).await;
    let _env = EnvVars::set(&[("ALLDEBRID_API_BASE", &base)]);
    let body = format!(r#"{{"service":"alldebrid","apiKey":"{SECRET}"}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/account", &body).await;
    assert_eq!(status, StatusCode::OK, "alldebrid account: {raw}");
    assert!(!raw.contains(SECRET), "a chave não pode voltar no corpo");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    // Nem campo a mais nem a menos: o TS devolve exatamente esta lista.
    assert_eq!(
        keys(&json),
        ["active", "error", "magnets", "oldestAt", "ready"]
    );
    assert_eq!(json["magnets"].as_u64(), Some(2));
    assert_eq!(json["ready"].as_u64(), Some(1));
    assert_eq!(json["active"].as_u64(), Some(1));
    assert_eq!(json["error"].as_u64(), Some(0));
    // Menor `uploadDate` em SEGUNDOS, cru da API (o TS não multiplica).
    assert_eq!(json["oldestAt"].as_i64(), Some(1_600_000_000));
}

#[tokio::test]
async fn torbox_account_tem_o_shape_do_ts() {
    let base = serve(Router::new().fallback(any(fake_torbox_account))).await;
    let _env = EnvVars::set(&[("TORBOX_API_BASE", &base)]);
    let body = format!(r#"{{"service":"torbox","apiKey":"{SECRET}"}}"#);
    let (status, raw) = call("segredo", Some("segredo"), "/debrid/account", &body).await;
    assert_eq!(status, StatusCode::OK, "torbox account: {raw}");
    assert!(!raw.contains(SECRET), "a chave não pode voltar no corpo");
    let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
    // Sem `error` e sem `premiumUntil`: o TS do TorBox não devolve nenhum dos dois.
    assert_eq!(keys(&json), ["active", "magnets", "ready"]);
    assert_eq!(json["magnets"].as_u64(), Some(2));
    assert_eq!(json["ready"].as_u64(), Some(1));
    assert_eq!(json["active"].as_u64(), Some(1));
}

/// Upstream fora do ar não pode voltar 501 (o Node cairia no TS e faria a
/// SEGUNDA chamada); vira erro de adaptador, sem a chave no corpo.
#[tokio::test]
async fn alldebrid_e_torbox_account_nao_ficam_501_com_upstream_fora() {
    let base = serve(Router::new().fallback(any(async |_req: Request<Body>| {
        (StatusCode::INTERNAL_SERVER_ERROR, "fora do ar").into_response()
    })))
    .await;
    let _env = EnvVars::set(&[("ALLDEBRID_API_BASE", &base), ("TORBOX_API_BASE", &base)]);
    for service in ["alldebrid", "torbox"] {
        let body = format!(r#"{{"service":"{service}","apiKey":"{SECRET}"}}"#);
        let (status, raw) = call("segredo", Some("segredo"), "/debrid/account", &body).await;
        assert_ne!(status, StatusCode::NOT_IMPLEMENTED, "{service}: {raw}");
        assert!(!raw.contains("service_not_ported"), "{service}: {raw}");
        assert!(
            !raw.contains(SECRET),
            "{service}: a chave não volta no corpo"
        );
    }
}

/// Sem `uploadDate` em nenhuma linha o TS devolve `oldestAt: null` (reduce com
/// `null`), nunca 0 nem o campo ausente.
#[test]
fn alldebrid_sem_upload_date_devolve_oldest_at_null() {
    let status = crate::alldebrid::AccountStatus {
        magnets: 1,
        ready: 0,
        active: 1,
        error: 0,
        oldest_at: None,
    };
    let json = super::alldebrid_json(status);
    assert_eq!(json["oldestAt"], serde_json::Value::Null);
    assert_eq!(json["magnets"].as_u64(), Some(1));
}
