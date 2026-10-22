//! Fixtures da checagem nativa da AllDebrid: upload por hash, lote/teto,
//! `known`/`unusable`, timeout parcial, auth/quota/rate limit e limpeza.
//!
//! O servidor falso mora em loopback e responde conforme o conteúdo do lote —
//! os lotes rodam em paralelo, então a decisão não pode depender da ordem.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::net::TcpListener;

use super::super::alldebrid_tests::{envelope, hash_of, open, values, API_KEY};
use super::MAX_HASHES;
use crate::alldebrid::AllDebrid;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Behavior {
    /// `ready` só para os hashes cujo primeiro char está no conjunto.
    ReadySet(char),
    AllReady,
    /// Nenhum hash pronto: resposta fechada e vazia (conhecido).
    AllUncached,
    /// HTTP 200 `status:error` com o código dado.
    PayloadError(&'static str, &'static str),
    /// HTTP 429 em todos os lotes.
    RateLimit,
    /// Lote com atraso além do timeout; os demais respondem prontos.
    SlowBatch(char),
    /// Lote com falha genérica; os demais respondem prontos.
    BrokenBatch(char),
}

struct Hit {
    path: String,
    query: String,
    auth_ok: bool,
    hashes: Vec<String>,
}

struct Scene {
    behavior: Behavior,
    delay: Duration,
    hits: Mutex<Vec<Hit>>,
    next_id: AtomicUsize,
    inflight: AtomicUsize,
    max_inflight: AtomicUsize,
    deletes: AtomicUsize,
}

fn scene(behavior: Behavior, delay: Duration) -> Arc<Scene> {
    Arc::new(Scene {
        behavior,
        delay,
        hits: Mutex::new(Vec::new()),
        next_id: AtomicUsize::new(100),
        inflight: AtomicUsize::new(0),
        max_inflight: AtomicUsize::new(0),
        deletes: AtomicUsize::new(0),
    })
}

async fn listen(scene: Arc<Scene>) -> SocketAddr {
    let app = Router::new().fallback(any(respond)).with_state(scene);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn rows(batch: &[String], ready: impl Fn(&str) -> bool, scene: &Scene) -> Value {
    let list: Vec<Value> = batch
        .iter()
        .map(|hash| {
            json!({
                "hash": hash,
                "ready": ready(hash),
                "id": scene.next_id.fetch_add(1, Ordering::SeqCst),
            })
        })
        .collect();
    json!({ "magnets": list })
}

async fn respond(State(scene): State<Arc<Scene>>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let auth_ok = req
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        == Some(format!("Bearer {API_KEY}").as_str());
    let _ = req.into_body().collect().await;
    if path.ends_with("/magnet/delete") {
        scene.deletes.fetch_add(1, Ordering::SeqCst);
        return (StatusCode::OK, envelope(json!({}))).into_response();
    }
    let hashes = values(&query, "magnets[]");
    let first = hashes
        .first()
        .and_then(|hash| hash.chars().next())
        .unwrap_or('?');
    scene.hits.lock().unwrap().push(Hit {
        path: path.clone(),
        query: query.clone(),
        auth_ok,
        hashes: hashes.clone(),
    });
    let now = scene.inflight.fetch_add(1, Ordering::SeqCst) + 1;
    scene.max_inflight.fetch_max(now, Ordering::SeqCst);
    // Atraso do cenário (fora dos lotes lentos, que têm o próprio sleep).
    if !scene.delay.is_zero()
        && !matches!(
            scene.behavior,
            Behavior::SlowBatch(_) | Behavior::BrokenBatch(_)
        )
    {
        tokio::time::sleep(scene.delay).await;
    }
    let response = match scene.behavior {
        Behavior::ReadySet(ch) => {
            let body = envelope(rows(&hashes, |hash| hash.starts_with(ch), &scene));
            (StatusCode::OK, body).into_response()
        }
        Behavior::AllReady => {
            let body = envelope(rows(&hashes, |_| true, &scene));
            (StatusCode::OK, body).into_response()
        }
        Behavior::AllUncached => {
            let body = envelope(rows(&hashes, |_| false, &scene));
            (StatusCode::OK, body).into_response()
        }
        Behavior::PayloadError(code, message) => (
            StatusCode::OK,
            json!({"status": "error", "error": {"code": code, "message": message}}).to_string(),
        )
            .into_response(),
        Behavior::RateLimit => (StatusCode::TOO_MANY_REQUESTS, "slow down").into_response(),
        Behavior::SlowBatch(ch) | Behavior::BrokenBatch(ch) if first == ch => {
            tokio::time::sleep(scene.delay).await;
            if matches!(scene.behavior, Behavior::BrokenBatch(_)) {
                (StatusCode::INTERNAL_SERVER_ERROR, "quebrou").into_response()
            } else {
                (StatusCode::OK, envelope(rows(&hashes, |_| true, &scene))).into_response()
            }
        }
        _ => {
            let body = envelope(rows(&hashes, |_| true, &scene));
            (StatusCode::OK, body).into_response()
        }
    };
    scene.inflight.fetch_sub(1, Ordering::SeqCst);
    response
}

async fn open_scene(behavior: Behavior, delay: Duration) -> (AllDebrid, Arc<Scene>) {
    let scene = scene(behavior, delay);
    let ad = open(listen(scene.clone()).await);
    (ad, scene)
}

fn opts(batch: usize, timeout_ms: u64) -> super::CheckOpts {
    super::CheckOpts {
        batch_size: Some(batch),
        timeout: Some(Duration::from_millis(timeout_ms)),
        // Sem env global: o kill-switch é fato injetado.
        kill_switch: Some(false),
        ..super::CheckOpts::default()
    }
}

fn hashes(n: usize, ch: char) -> Vec<String> {
    (0..n).map(|i| format!("{ch}{i:039}")).collect()
}

fn hits(scene: &Scene) -> Vec<Hit> {
    std::mem::take(&mut *scene.hits.lock().unwrap())
}

fn upload_hits(scene: &Scene) -> Vec<Hit> {
    hits(scene)
        .into_iter()
        .filter(|hit| hit.path.ends_with("/magnet/upload"))
        .collect()
}

#[tokio::test]
async fn cached_e_uncached_por_hash_sem_vazar_chave() {
    let (ad, scene) = open_scene(Behavior::ReadySet('a'), Duration::ZERO).await;
    let asked = vec![hash_of('a'), hash_of('b'), hash_of('a'), String::new()];
    let report = ad
        .check_cached(API_KEY, &asked, &opts(25, 2_000))
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a')]);
    assert!(report.complete);
    assert!(report.attempted);
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 1);
    assert!(uploads.iter().all(|hit| hit.auth_ok));
    // A chave nunca entra na URL; o header Authorization é o único lugar.
    for hit in &uploads {
        assert!(!hit.query.contains(API_KEY), "chave vazou na query");
        assert_eq!(hit.hashes.len(), 3, "hash vazio é filtrado");
    }
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn lotes_de_25_rodam_em_paralelo() {
    // Lotes em paralelo: o atraso do cenário garante a sobreposição.
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::from_millis(150)).await;
    let asked = hashes(60, 'c');
    let report = ad
        .check_cached(API_KEY, &asked, &opts(25, 5_000))
        .await
        .unwrap();
    assert_eq!(report.cached.len(), 60);
    assert!(report.complete);
    let uploads = upload_hits(&scene);
    let mut sizes: Vec<usize> = uploads.iter().map(|hit| hit.hashes.len()).collect();
    sizes.sort_unstable();
    assert_eq!(sizes, vec![10, 25, 25]);
    assert!(
        scene.max_inflight.load(Ordering::SeqCst) >= 2,
        "os lotes precisam sobrepor: max_inflight={}",
        scene.max_inflight.load(Ordering::SeqCst)
    );
}

#[tokio::test]
async fn teto_de_500_hashes_marca_incompleto_e_nao_envia_o_excedente() {
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let asked = hashes(MAX_HASHES + 1, 'd');
    let report = ad
        .check_cached(API_KEY, &asked, &opts(100, 5_000))
        .await
        .unwrap();
    assert_eq!(report.cached.len(), MAX_HASHES);
    assert!(!report.complete, "excedente não perguntado não é 'frio'");
    let sent: usize = upload_hits(&scene).iter().map(|hit| hit.hashes.len()).sum();
    assert_eq!(sent, MAX_HASHES);
}

#[tokio::test]
async fn uncached_conhecido_nao_vira_cache_nem_unknown() {
    let (ad, _scene) = open_scene(Behavior::AllUncached, Duration::ZERO).await;
    let report = ad
        .check_cached(API_KEY, &[hash_of('a')], &opts(25, 1_000))
        .await
        .unwrap();
    assert!(report.cached.is_empty());
    assert!(report.complete, "resposta fechada: 'frio' é conhecido");
    assert!(report.attempted);
}

#[tokio::test]
async fn timeout_de_um_lote_preserva_o_hit_do_outro() {
    let (ad, scene) = open_scene(Behavior::SlowBatch('b'), Duration::from_millis(400)).await;
    let asked = vec![hash_of('a'), hash_of('b')];
    let report = ad
        .check_cached_report(API_KEY, &asked, &opts(1, 120))
        .await
        .unwrap();
    assert!(!report.complete);
    assert!(report.attempted);
    assert_eq!(report.cached, vec![hash_of('a')], "hit parcial sobrevive");
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 2);
}

#[tokio::test]
async fn auth_quota_e_rate_limit_sobem_classificados() {
    let cases = [
        (
            Behavior::PayloadError("AUTH_BAD_APIKEY", "chave recusada"),
            "auth",
        ),
        (
            Behavior::PayloadError("MAGNET_TOO_MANY_ACTIVE", "cheio"),
            "quota",
        ),
        (Behavior::RateLimit, "rate_limit"),
    ];
    for (behavior, kind) in cases {
        let (ad, _scene) = open_scene(behavior, Duration::ZERO).await;
        let failure = ad
            .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 1_000))
            .await
            .unwrap_err();
        assert_eq!(failure.error.kind(), kind);
        assert!(failure.attempted, "{kind}: o upload foi enviado");
        assert!(!failure.error.message().contains(API_KEY));
    }
}

#[tokio::test]
async fn lote_quebrado_nao_derruba_o_hit_do_outro_e_todos_quebrados_e_erro() {
    let (ad, _scene) = open_scene(Behavior::BrokenBatch('b'), Duration::ZERO).await;
    let report = ad
        .check_cached_report(API_KEY, &[hash_of('a'), hash_of('b')], &opts(1, 2_000))
        .await
        .unwrap();
    assert!(!report.complete);
    assert_eq!(report.cached, vec![hash_of('a')]);

    let (ad, _scene) = open_scene(Behavior::BrokenBatch('a'), Duration::ZERO).await;
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 2_000))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "other");
    assert_eq!(
        failure.error.message(),
        "nenhum lote de checagem de cache respondeu"
    );
}

#[tokio::test]
async fn bloqueado_nao_e_enviado_e_o_resto_sobe() {
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    let opts = super::CheckOpts {
        blocked: HashSet::from([hash_of('a')]),
        ..opts(25, 1_000)
    };
    // Lote 100% bloqueado: nada sobe e o vazio conhecido continua verdadeiro.
    let sozinho = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap();
    assert!(sozinho.cached.is_empty());
    assert_eq!(sozinho.blocked, vec![hash_of('a')]);
    assert!(sozinho.complete, "vazio conhecido, não 'não sei'");
    assert!(!sozinho.attempted);
    assert!(upload_hits(&scene).is_empty());

    // Misturado: só o não bloqueado vai ao `/magnet/upload`; o filtrado volta no
    // relatório para o escape do Node (prova de pronto no inventário).
    let misto = ad
        .check_cached_report(API_KEY, &[hash_of('a'), hash_of('b')], &opts)
        .await
        .unwrap();
    assert_eq!(misto.cached, vec![hash_of('b')]);
    assert_eq!(misto.blocked, vec![hash_of('a')]);
    assert!(misto.complete);
    assert!(misto.attempted);
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 1);
    assert_eq!(uploads[0].hashes, vec![hash_of('b')], "bloqueado não sobe");
}

#[tokio::test]
async fn falha_de_delete_nao_muda_o_veredito() {
    let (ad, scene) = open_scene(Behavior::AllReady, Duration::ZERO).await;
    // O mock sempre responde 200 no delete; este teste garante que a limpeza
    // pedida (inventário carregado) não segura nem altera o cache. A fila roda
    // DEPOIS, fora do prazo da checagem.
    let opts = super::CheckOpts {
        drop_ready: true,
        drop_uncached: true,
        inventory_loaded: true,
        cleanup: crate::alldebrid_cleanup::CleanupMode::On,
        holds_complete: true,
        ..opts(25, 1_000)
    };
    let report = ad
        .check_cached(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap();
    assert_eq!(report.cached, vec![hash_of('a')]);
    assert!(report.complete);
    assert_eq!(report.deleted.len(), 1);
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 0);
    let queue = crate::alldebrid_delete::delete_with_backoff(
        &ad,
        API_KEY,
        &report.deleted,
        crate::alldebrid_delete::DeleteConfig::fast(),
    )
    .await;
    assert_eq!(queue.removed, vec![report.deleted[0].clone()]);
    assert!(queue.failed.is_empty());
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn quota_na_checagem_nao_agenda_limpeza() {
    // Conta no teto: o upload devolve quota (unusable) e não há magnet ecoado
    // para apagar. A limpeza nunca é a saída para a conta cheia.
    let (ad, scene) = open_scene(
        Behavior::PayloadError("MAGNET_TOO_MANY_ACTIVE", "cheio"),
        Duration::ZERO,
    )
    .await;
    let opts = super::CheckOpts {
        drop_ready: true,
        drop_uncached: true,
        inventory_loaded: true,
        cleanup: crate::alldebrid_cleanup::CleanupMode::On,
        holds_complete: true,
        ..opts(25, 1_000)
    };
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts)
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "quota");
    assert!(failure.attempted);
    assert_eq!(scene.deletes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn env_controla_lote_e_timeout() {
    // O servidor sobe ANTES do lock: `open()` também pega o lock de env, e
    // pegá-lo duas vezes no mesmo teste trava a suíte.
    let scene = scene(Behavior::AllReady, Duration::ZERO);
    let addr = listen(scene.clone()).await;
    let _lock = crate::test_env::lock();
    let previous_base = std::env::var("ALLDEBRID_API_BASE").ok();
    let previous_batch = std::env::var("DEBRID_BATCH_SIZE").ok();
    let previous_timeout = std::env::var("DEBRID_CACHE_CHECK_TIMEOUT_MS").ok();
    unsafe {
        std::env::set_var("ALLDEBRID_API_BASE", format!("http://{addr}"));
        std::env::set_var("DEBRID_BATCH_SIZE", "2");
        std::env::set_var("DEBRID_CACHE_CHECK_TIMEOUT_MS", "2000");
    }
    let ad = AllDebrid::new(crate::http::HttpClient::new().unwrap());
    let asked = hashes(5, 'e');
    let opts = super::CheckOpts {
        batch_size: None,
        timeout: None,
        ..super::CheckOpts::default()
    };
    let report = ad.check_cached(API_KEY, &asked, &opts).await.unwrap();
    assert!(report.complete);
    let uploads = upload_hits(&scene);
    assert_eq!(uploads.len(), 3, "5 hashes / 2 por lote");
    restore("ALLDEBRID_API_BASE", previous_base);
    restore("DEBRID_BATCH_SIZE", previous_batch);
    restore("DEBRID_CACHE_CHECK_TIMEOUT_MS", previous_timeout);
}

fn restore(name: &str, value: Option<String>) {
    unsafe {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn base_recusada_nao_tenta_upload() {
    let _lock = crate::test_env::lock();
    let previous = std::env::var("ALLDEBRID_API_BASE").ok();
    unsafe { std::env::set_var("ALLDEBRID_API_BASE", "http://evil.test") };
    let ad = AllDebrid::new(crate::http::HttpClient::new().unwrap());
    let failure = ad
        .check_cached_report(API_KEY, &[hash_of('a')], &opts(25, 1_000))
        .await
        .unwrap_err();
    assert_eq!(failure.error.kind(), "other");
    assert!(!failure.attempted);
    restore("ALLDEBRID_API_BASE", previous);
}
