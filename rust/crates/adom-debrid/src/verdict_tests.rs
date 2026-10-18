//! Servidor falso em 127.0.0.1 + store em memória. Sem rede real; a chave
//! nunca aparece em assert de texto.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::ledger_key;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::{check_service, is_cached, outcome_json, UnusableKind};
use crate::store::Store;
use crate::verdict::{rd_gate_enabled, rd_ledger_enabled, rd_oracle_enabled};

const KEY: &str = "chave-nao-logar";
const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MISS: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DARK: &str = "cccccccccccccccccccccccccccccccccccccccc";

struct EnvGuard {
    prev: Vec<(&'static str, Option<String>)>,
    // Trava ÚNICA do crate: outros módulos de teste também mexem na env.
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let lock = crate::test_env::lock();
        let mut prev = Vec::new();
        for (name, value) in pairs {
            prev.push((*name, std::env::var(name).ok()));
            // SAFETY: a trava única serializa os testes; a env só aponta
            // loopback.
            unsafe {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
        Self { prev, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        // SAFETY: restauração dos valores guardados no set, com a trava
        // ainda segura pelo próprio guard.
        unsafe {
            for (name, value) in &self.prev {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

#[derive(Default)]
struct Upstream {
    hits: Mutex<Vec<(String, String)>>,
    status: Mutex<u16>,
    body: Mutex<String>,
}

async fn serve(app: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

async fn record(State(upstream): State<Arc<Upstream>>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    upstream.hits.lock().unwrap().push((path, query));
    let status = StatusCode::from_u16(*upstream.status.lock().unwrap()).unwrap_or(StatusCode::OK);
    (status, upstream.body.lock().unwrap().clone()).into_response()
}

fn upstream(status: u16, body: &str) -> (Arc<Upstream>, Router) {
    let upstream = Arc::new(Upstream {
        status: Mutex::new(status),
        body: Mutex::new(body.to_string()),
        ..Default::default()
    });
    let app = Router::new()
        .fallback(any(record))
        .with_state(upstream.clone());
    (upstream, app)
}

fn store_with(entries: &[(&str, &str)]) -> Store {
    let store = Store::open_memory(&[]).unwrap();
    // Relógio REAL: o store apaga o que expirou na leitura.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    for (hash, state) in entries {
        let value = json!({ "s": state, "at": (now as f64) / 1000.0, "n": 0 });
        store
            .put(&ledger_key(hash), &value.to_string(), now + 86_400_000, now)
            .unwrap();
    }
    store
}

#[tokio::test]
async fn torbox_cached_missing_e_falha() {
    let (up, app) = upstream(
        200,
        r#"{"success":true,"data":[{"hash":"AAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}]}"#,
    );
    // Escopos separados: EnvGuard segura a trava única do crate — aninhar
    // dois guards no mesmo teste deadlocks (HUNG em cargo test no Windows).
    {
        let _env = EnvGuard::set(&[("TORBOX_API_BASE", Some(&serve(app).await))]);
        let outcome = check_service(
            "torbox",
            KEY,
            &[
                "aaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                MISS.into(),
            ],
            Some(Duration::from_millis(2000)),
            None,
        )
        .await
        .unwrap();
        assert!(outcome.known, "resposta fechada é known");
        assert!(is_cached(
            &outcome,
            "AAAABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
        ));
        assert!(!is_cached(&outcome, &MISS));
        assert_eq!(outcome.unusable, None);
        assert!(!up.hits.lock().unwrap().is_empty());
    }

    // Falha total do upstream (nenhum lote respondeu) → Unknown, não Missing.
    let (_up2, app2) = upstream(500, "boom");
    {
        let _env = EnvGuard::set(&[("TORBOX_API_BASE", Some(&serve(app2).await))]);
        let outcome = check_service(
            "torbox",
            KEY,
            &[MISS.into()],
            Some(Duration::from_millis(2000)),
            None,
        )
        .await
        .unwrap();
        assert!(!outcome.known, "falha não prova ausência de cache");
    }
}

#[tokio::test]
async fn torbox_auth_e_quota_viram_unusable() {
    for (status, body, kind) in [
        (401u16, r#"{"error":"invalid api key"}"#, "auth"),
        (402, r#"{"error":"magnets limit reached"}"#, "quota"),
    ] {
        let _env = EnvGuard::set(&[(
            "TORBOX_API_BASE",
            Some(&serve(upstream(status, body).1).await),
        )]);
        let outcome = check_service(
            "torbox",
            KEY,
            &[HIT.into()],
            Some(Duration::from_millis(2000)),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            outcome.unusable.as_ref().map(|(k, _)| k.as_str()),
            Some(kind),
            "status {status}"
        );
        // Unusable não afirma nada sobre cache.
        assert!(!outcome.known);
        assert!(outcome.cached.is_empty());
    }
}

#[tokio::test]
async fn alldebrid_veredito_sem_limpeza() {
    let body = json!({
        "status": "success",
        "data": {
            "magnets": [
                { "hash": HIT, "ready": true, "id": 11 },
                { "hash": MISS, "ready": false, "id": 12 }
            ]
        }
    })
    .to_string();
    let (up, app) = upstream(200, &body);
    let _env = EnvGuard::set(&[("ALLDEBRID_API_BASE", Some(&serve(app).await))]);
    let outcome = check_service(
        "alldebrid",
        KEY,
        &[HIT.into(), MISS.into(), DARK.into()],
        Some(Duration::from_millis(2000)),
        None,
    )
    .await
    .unwrap();
    assert!(outcome.known);
    assert!(is_cached(&outcome, &HIT));
    assert!(!is_cached(&outcome, &MISS));
    // A PROVA: o upload é a consulta; delete NUNCA aconteceu (limpeza é Fase C,
    // o protected.ts ainda não está portado).
    let paths: Vec<String> = up
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|(path, _)| path.clone())
        .collect();
    assert!(
        paths.iter().any(|path| path.ends_with("/magnet/upload")),
        "a consulta é o upload: {paths:?}"
    );
    assert!(
        !paths.iter().any(|path| path.contains("delete")),
        "nenhuma limpeza sem o protected.ts portado: {paths:?}"
    );
}

#[tokio::test]
async fn realdebrid_ledger_hit_miss_e_blocked() {
    let store = store_with(&[(&HIT, "hit"), (&MISS, "miss"), (&DARK, "blocked")]);
    // Sem rede: o ledger responde sozinho (o adapter do RD não faz HTTP na
    // checagem) e o hit ganha refresh de TTL no store.
    let outcome = check_service(
        "realdebrid",
        KEY,
        &[HIT.into(), MISS.into()],
        None,
        Some(&store),
    )
    .await
    .unwrap();
    assert!(is_cached(&outcome, &HIT), "hit do ledger é ⚡");
    assert!(!is_cached(&outcome, &MISS), "miss medido é Missing");
    assert!(outcome.known, "miss NÃO derruba o known");
    assert_eq!(outcome.cached.len(), 1);

    // blocked NÃO condena: o hash sai sem veredito e o lote fica known:false
    // (Unknown de verdade — o passe tardio refaz), nunca "nada em cache".
    let outcome = check_service("realdebrid", KEY, &[DARK.into()], None, Some(&store))
        .await
        .unwrap();
    assert!(!outcome.known);
    assert!(outcome.cached.is_empty());
}

#[tokio::test]
async fn realdebrid_sem_entrada_e_unknown_nunca_missing() {
    let store = Store::open_memory(&[]).unwrap();
    let outcome = check_service("realdebrid", KEY, &[HIT.into()], None, Some(&store))
        .await
        .unwrap();
    assert!(!outcome.known, "sem entrada no ledger = Unknown");
    let outcome = check_service("realdebrid", KEY, &[HIT.into()], None, None)
        .await
        .unwrap();
    assert!(!outcome.known, "sem store = Unknown");
}

#[tokio::test]
async fn realdebrid_ledger_off_respeita_kill_switch() {
    let _env = EnvGuard::set(&[("DEBRID_RD_LEDGER", Some("off"))]);
    let store = store_with(&[(&HIT, "hit")]);
    let outcome = check_service("realdebrid", KEY, &[HIT.into()], None, Some(&store))
        .await
        .unwrap();
    assert!(!outcome.known, "kill-switch do ledger manda: Unknown");
    assert!(outcome.cached.is_empty());
}

#[test]
fn kill_switches_leem_env() {
    let _env = EnvGuard::set(&[
        ("DEBRID_RD_GATE", Some("off")),
        ("DEBRID_RD_ORACLE", Some("off")),
    ]);
    assert!(!rd_gate_enabled());
    assert!(!rd_oracle_enabled());
    assert!(rd_ledger_enabled(), "não setado = default ligado");
}

#[tokio::test]
async fn premiumize_via_verdict_e_servico_desconhecido() {
    let body = r#"{"status":"success","response":[true],"filesize":[4]}"#;
    let _env = EnvGuard::set(&[(
        "PREMIUMIZE_API_BASE",
        Some(&serve(upstream(200, body).1).await),
    )]);
    let outcome = check_service(
        "premiumize",
        KEY,
        &[HIT.into()],
        Some(Duration::from_millis(2000)),
        None,
    )
    .await
    .unwrap();
    assert!(outcome.known);
    assert!(is_cached(&outcome, &HIT));

    let outcome = check_service("qualquer", KEY, &[HIT.into()], None, None)
        .await
        .unwrap_err();
    assert_eq!(outcome, super::UNKNOWN_SERVICE);
}

#[test]
fn outcome_json_carrega_known_e_unusable() {
    let outcome = super::CheckOutcome {
        cached: vec![HIT.into()],
        known: true,
        unusable: None,
    };
    let json = outcome_json(&outcome);
    assert_eq!(json["known"], json!(true));
    assert_eq!(json["complete"], json!(true));
    assert_eq!(json["cached"][0], json!(HIT));
    assert_eq!(json["unusable"], Value::Null);

    let outcome = super::CheckOutcome {
        cached: Vec::new(),
        known: false,
        unusable: Some((UnusableKind::Quota, "limite".into())),
    };
    let json = outcome_json(&outcome);
    assert_eq!(json["unusable"]["reason"], json!("quota"));
    assert!(!json.to_string().contains(KEY));
}
