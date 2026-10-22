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

use super::{alldebrid_opts, check_service, is_cached, outcome_json, UnusableKind};
use crate::alldebrid_cleanup::{account_scope, adrm_key, CleanupMode, DurablePeek};
use crate::holds_feed::HoldsFacts;
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
        assert!(!is_cached(&outcome, MISS));
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
    assert!(is_cached(&outcome, HIT));
    assert!(!is_cached(&outcome, MISS));
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
    // O kill-switch é global: sem a trava, `realdebrid_ledger_off...` pode
    // rodar em paralelo e derrubar o ledger deste teste (flaky).
    let _env = EnvGuard::set(&[("DEBRID_RD_LEDGER", None)]);
    let store = store_with(&[(HIT, "hit"), (MISS, "miss"), (DARK, "blocked")]);
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
    assert!(is_cached(&outcome, HIT), "hit do ledger é ⚡");
    assert!(!is_cached(&outcome, MISS), "miss medido é Missing");
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
    let store = store_with(&[(HIT, "hit")]);
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
    assert!(is_cached(&outcome, HIT));

    let outcome = check_service("qualquer", KEY, &[HIT.into()], None, None)
        .await
        .unwrap_err();
    assert_eq!(outcome, super::UNKNOWN_SERVICE);
}

/// Debrid-Link não publica cache (`cacheCheck = false`): a resposta vazia é
/// "não sei", igual ao Node — nunca `known:true`/`Missing`.
#[tokio::test]
async fn debridlink_sem_endpoint_de_cache_e_unknown() {
    let outcome = check_service("debridlink", KEY, &[HIT.into()], None, None)
        .await
        .unwrap();
    assert!(!outcome.known, "Debrid-Link não sabe informar o cache");
    assert!(outcome.cached.is_empty());
    assert!(outcome.unusable.is_none());
}

#[test]
fn outcome_json_carrega_known_e_unusable() {
    let outcome = super::CheckOutcome {
        cached: vec![HIT.into()],
        known: true,
        unusable: None,
    };
    // `blocked` é transporte da checagem: sempre presente, mesmo vazio.
    let json = outcome_json(&outcome, &[]);
    assert_eq!(json["known"], json!(true));
    assert_eq!(json["complete"], json!(true));
    assert_eq!(json["cached"][0], json!(HIT));
    assert_eq!(json["unusable"], Value::Null);
    assert_eq!(json["blocked"], json!([]));

    let json = outcome_json(&outcome, &[MISS.into()]);
    assert_eq!(json["blocked"][0], json!(MISS), "filtrados saem no corpo");
    assert_eq!(json["known"], json!(true), "blocked não mexe em known");
    assert_eq!(
        json["complete"],
        json!(true),
        "blocked não mexe em complete"
    );

    let outcome = super::CheckOutcome {
        cached: Vec::new(),
        known: false,
        unusable: Some((UnusableKind::Quota, "limite".into())),
    };
    let json = outcome_json(&outcome, &[]);
    assert_eq!(json["unusable"]["reason"], json!("quota"));
    assert!(!json.to_string().contains(KEY));
}

// ── Fatos do feed de holds → CheckOpts (AllDebrid) ──────────────────────────

const ACCOUNT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const BATCH: [&str; 2] = [HIT, MISS];

fn holds_facts(complete: bool, evaluated: &[&str]) -> HoldsFacts {
    HoldsFacts {
        account: ACCOUNT.into(),
        inventory_loaded: true,
        known_before: vec![DARK.into()],
        held: vec![MISS.into()],
        evaluated: evaluated.iter().map(|h| (*h).to_string()).collect(),
        holds_complete: complete,
        drop_ready: Some(false),
        drop_uncached: Some(true),
    }
}

fn batch() -> Vec<String> {
    BATCH.iter().map(|h| (*h).to_string()).collect()
}

/// Leitor de um `cache.db` que não existe: sem `adrm`, sem `adprot`/`adsub`.
/// Caminho relativo ao crate (cwd do `cargo test`) e nunca criado.
fn no_peek() -> DurablePeek {
    DurablePeek::new("cache.db.inexistente")
}

/// `cache.db` mínimo do Node (`src/utils/cache-db-open.ts`) com `expires_at`
/// explícito por chave.
fn cache_db(dir: &std::path::Path, rows: &[(&str, i64)]) -> std::path::PathBuf {
    let path = dir.join("cache.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);",
    )
    .unwrap();
    for (key, expires_at) in rows {
        conn.execute(
            "INSERT INTO cache (key, value, expires_at) VALUES (?1, '{}', ?2)",
            rusqlite::params![key, expires_at],
        )
        .unwrap();
    }
    path
}

/// Limpeza OFF (default): read-only de verdade — fatos e drops ignorados, nem
/// inventário nem guarda durável são montados. O filtro de upload (`adrm`) é a
/// exceção: leitura read-only que vale SEMPRE.
#[test]
fn alldebrid_opts_limpeza_off_ignora_fatos() {
    let facts = holds_facts(true, &BATCH);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::Off, None, Some(&facts), &batch(), KEY, &peek);
    assert!(!opts.cleanup.is_on());
    assert!(!opts.drop_ready);
    assert!(!opts.drop_uncached);
    assert!(!opts.inventory_loaded);
    assert!(!opts.holds_complete);
    assert!(opts.known_before.is_empty());
    assert!(opts.held.is_empty());
    assert!(
        opts.durable.is_none(),
        "flag OFF não entrega a guarda `adprot`/`adsub` à limpeza"
    );
    assert!(opts.blocked.is_empty(), "sem cache.db não há bloqueio");
}

/// Limpeza ON sem feed: comportamento anterior preservado (read-only por
/// `holds_incomplete`), com os drops do ambiente.
#[test]
fn alldebrid_opts_sem_fatos_continua_read_only() {
    let _env = EnvGuard::set(&[
        ("DEBRID_DROP_READY", None),
        ("DEBRID_DROP_UNCACHED", Some("false")),
    ]);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::On, None, None, &batch(), KEY, &peek);
    assert!(opts.drop_ready, "default do ambiente é true");
    assert!(!opts.drop_uncached, "env manda quando não há fato");
    assert!(!opts.inventory_loaded);
    assert!(!opts.holds_complete, "sem prova o plano nasce suprimido");
    assert!(opts.durable.is_some());
}

/// Fatos completos: drops/inventário/hold do Node viajam e `holds_complete`
/// só fica verdadeiro porque `evaluated` cobre o lote.
#[test]
fn alldebrid_opts_fatos_completos_autorizam_o_plano() {
    let facts = holds_facts(true, &BATCH);
    let peek = no_peek();
    let opts = alldebrid_opts(
        CleanupMode::On,
        Some(Duration::from_millis(123)),
        Some(&facts),
        &batch(),
        KEY,
        &peek,
    );
    assert_eq!(opts.timeout, Some(Duration::from_millis(123)));
    assert!(!opts.drop_ready);
    assert!(opts.drop_uncached);
    assert!(opts.inventory_loaded);
    assert!(opts.holds_complete);
    assert!(opts.known_before.contains(DARK));
    assert!(opts.held.contains(MISS));
    assert!(opts.durable.is_some());
}

/// `holdsComplete:true` com `evaluated` parcial NÃO autoriza: a cobertura é
/// reconferida no Rust (fail-closed).
#[test]
fn alldebrid_opts_fatos_incompletos_nao_autorizam() {
    let partial = holds_facts(true, &[HIT]);
    let peek = no_peek();
    let opts = alldebrid_opts(CleanupMode::On, None, Some(&partial), &batch(), KEY, &peek);
    assert!(!opts.holds_complete, "evaluated não cobre o lote");
    // O que foi provado (held/inventário) continua indo: protege mais, nunca
    // menos.
    assert!(opts.held.contains(MISS));
    assert!(opts.inventory_loaded);

    let lying = holds_facts(false, &BATCH);
    let opts = alldebrid_opts(CleanupMode::On, None, Some(&lying), &batch(), KEY, &peek);
    assert!(!opts.holds_complete, "flag falso do Node nunca vira prova");
}

/// O `blocked` vem do `adrm:v1` do `cache.db` do Node e vale MESMO com a
/// limpeza OFF — é filtro de upload, não guarda da limpeza. O expirado não
/// bloqueia (o TTL de 3 dias é quem manda) e o `durable` da limpeza continua
/// `None` até a flag ligar.
#[test]
fn alldebrid_opts_blocked_vem_do_adrm_com_limpeza_off() {
    let account = account_scope(KEY);
    let now = crate::error::now_ms() as i64;
    let vivo = adrm_key(&account, HIT);
    let expirado = adrm_key(&account, MISS);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(
        dir.path(),
        &[(&vivo, now + 60_000), (&expirado, now - 1_000)],
    );
    let peek = DurablePeek::new(path);
    let opts = alldebrid_opts(CleanupMode::Off, None, None, &batch(), KEY, &peek);
    assert!(opts.blocked.contains(HIT), "adrm vivo sai do upload");
    assert!(!opts.blocked.contains(MISS), "adrm expirado não bloqueia");
    assert!(opts.durable.is_none(), "a guarda da limpeza segue OFF");

    let opts = alldebrid_opts(CleanupMode::On, None, None, &batch(), KEY, &peek);
    assert!(
        opts.blocked.contains(HIT),
        "o mesmo bloqueio vale com a limpeza ON"
    );
    assert!(opts.durable.is_some(), "ON entrega a guarda à limpeza");
}

/// Prova de ponta: o hash com `adrm` vivo NÃO chega ao `/magnet/upload` (que é
/// a própria consulta de cache) — o mock conta o que trafegou.
#[tokio::test]
async fn adrm_tira_o_hash_do_upload_mesmo_com_limpeza_off() {
    let body = json!({
        "status": "success",
        "data": { "magnets": [{ "hash": MISS, "ready": true, "id": 12 }] }
    })
    .to_string();
    let (up, app) = upstream(200, &body);
    let base = serve(app).await;
    let account = account_scope(KEY);
    let now = crate::error::now_ms() as i64;
    let vivo = adrm_key(&account, HIT);
    let expirado = adrm_key(&account, DARK);
    let dir = tempfile::tempdir().unwrap();
    let path = cache_db(
        dir.path(),
        &[(&vivo, now + 60_000), (&expirado, now - 1_000)],
    );
    let cache_str = path.to_string_lossy().to_string();
    let _env = EnvGuard::set(&[
        ("ALLDEBRID_API_BASE", Some(&base)),
        ("CACHE_DB_PATH", Some(cache_str.as_str())),
        ("DEBRID_AL_CLEANUP", None),
    ]);
    let outcome = check_service(
        "alldebrid",
        KEY,
        &[HIT.into(), DARK.into(), MISS.into()],
        Some(Duration::from_millis(2_000)),
        None,
    )
    .await
    .unwrap();
    assert!(
        is_cached(&outcome, MISS),
        "o hash livre foi perguntado e é ⚡"
    );
    assert!(
        !is_cached(&outcome, HIT),
        "bloqueado não é ⚡: ele nem foi ao upload"
    );
    let queries: Vec<String> = up
        .hits
        .lock()
        .unwrap()
        .iter()
        .map(|(_, query)| query.clone())
        .collect();
    assert!(
        queries.iter().all(|query| !query.contains(HIT)),
        "o hash com `adrm` vivo não pode ir ao /magnet/upload: {queries:?}"
    );
    assert!(
        queries.iter().any(|query| query.contains(DARK)),
        "`adrm` expirado não bloqueia (o hash volta ao upload): {queries:?}"
    );
    assert!(queries.iter().any(|query| query.contains(MISS)));
}

/// A checagem com fatos atravessa `check_service_report_with` sem mexer no
/// veredito: o plano é só um efeito do corpo, nunca da resposta.
#[tokio::test]
async fn check_com_fatos_mantem_o_veredito() {
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
    let base = serve(upstream(200, &body).1).await;
    // Cache durável inexistente: o teste não pode depender do cache.db do host.
    let cache_db =
        std::env::temp_dir().join(format!("adom-holds-verdict-{}.db", std::process::id()));
    let _env = EnvGuard::set(&[
        ("ALLDEBRID_API_BASE", Some(&base)),
        (
            "CACHE_DB_PATH",
            Some(cache_db.to_str().unwrap_or("nao-existe.db")),
        ),
        ("DEBRID_AL_CLEANUP", Some("on")),
    ]);
    let facts = holds_facts(true, &BATCH);
    let report = super::check_service_report_with(
        "alldebrid",
        KEY,
        &[HIT.into(), MISS.into()],
        Some(Duration::from_millis(2000)),
        None,
        Some(&facts),
    )
    .await
    .unwrap();
    assert!(report.outcome.known);
    assert!(is_cached(&report.outcome, HIT));
    assert!(!is_cached(&report.outcome, MISS));
}
