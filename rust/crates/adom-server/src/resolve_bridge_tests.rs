//! Testes da ponte do `/resolve` nativo: forma dos corpos e o fio do
//! `resolve_native::handle` (hold pedido só na AllDebrid, efeito do erro
//! gravado ANTES da resposta, efeito do sucesso sem segurar o 302).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_core::{encode_config, PlayHint};
use adom_debrid::alldebrid::{PlayError, PlayFile};
use adom_debrid::play::PlayOutcome;
use adom_debrid::DebridError;
use adom_search::{ResolveSigner, WorkHint};
use http::StatusCode;
use serde_json::{json, Value};

use super::*;
use crate::resolve_native::{self, NativeContext, PlayFuture, PlayResolver};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const SECRET: &str = "segredo";

/// Ponte que grava o que recebe e responde um `held` fixo.
struct RecordingBridge {
    held: bool,
    held_calls: AtomicU32,
    applied: Mutex<Vec<Value>>,
}

impl RecordingBridge {
    fn new(held: bool) -> Arc<Self> {
        Arc::new(Self {
            held,
            held_calls: AtomicU32::new(0),
            applied: Mutex::new(Vec::new()),
        })
    }
}

impl PlayBridge for RecordingBridge {
    fn held<'a>(&'a self, _encoded: &'a str, _hash: &'a str) -> BridgeFuture<'a, bool> {
        self.held_calls.fetch_add(1, Ordering::SeqCst);
        let held = self.held;
        Box::pin(async move { held })
    }
    fn apply(&self, payload: Value) -> BridgeFuture<'_, ()> {
        self.applied.lock().unwrap().push(payload);
        Box::pin(async {})
    }
}

/// Resolvedor que devolve o desfecho fixo e grava o `held` recebido.
struct FixedResolver {
    outcome: Mutex<Option<Result<PlayOutcome, PlayError>>>,
    held_seen: Mutex<Vec<bool>>,
}

impl FixedResolver {
    fn new(outcome: Result<PlayOutcome, PlayError>) -> Arc<Self> {
        Arc::new(Self {
            outcome: Mutex::new(Some(outcome)),
            held_seen: Mutex::new(Vec::new()),
        })
    }
}

impl PlayResolver for FixedResolver {
    fn resolve<'a>(
        &'a self,
        _service: &'a str,
        _api_key: &'a str,
        _info_hash: &'a str,
        _hint: &'a PlayHint,
        held: bool,
    ) -> PlayFuture<'a> {
        self.held_seen.lock().unwrap().push(held);
        let outcome = self.outcome.lock().unwrap().take().expect("uma chamada só");
        Box::pin(async move { outcome })
    }
}

fn signed(service: &str) -> (String, Option<String>) {
    let segment = encode_config(&json!({ "ds": service, "dk": "chave-do-usuario" }));
    let signer = ResolveSigner {
        prefix: format!("/{segment}"),
        secret: SECRET.into(),
        season: Some(2),
        episode: Some(5),
        imdb_id: Some("tt0944947".into()),
        work_hint: Some(WorkHint {
            names: vec!["Serie".into()],
            year: Some(2011),
        }),
    };
    let url = signer.url(HASH, false, false);
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), Some(query.to_string())),
        None => (url, None),
    }
}

async fn run(
    service: &str,
    resolver: Arc<FixedResolver>,
    bridge: Arc<RecordingBridge>,
) -> (StatusCode, String) {
    let (path, query) = signed(service);
    let ctx = NativeContext {
        resolve_secret: SECRET.into(),
        resolver,
        bridge,
    };
    let response = resolve_native::handle(&path, query.as_deref(), &ctx).await;
    let status = response.status();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn alldebrid_pergunta_o_hold_e_repassa_ao_adaptador() {
    let resolver = FixedResolver::new(Ok(PlayOutcome::default()));
    let bridge = RecordingBridge::new(false);
    run("alldebrid", resolver.clone(), bridge.clone()).await;
    assert_eq!(bridge.held_calls.load(Ordering::SeqCst), 1);
    assert_eq!(*resolver.held_seen.lock().unwrap(), vec![false]);

    // Os outros serviços não têm hold: nem pergunta, e o adaptador recebe `true`.
    let resolver = FixedResolver::new(Ok(PlayOutcome::default()));
    let bridge = RecordingBridge::new(false);
    run("torbox", resolver.clone(), bridge.clone()).await;
    assert_eq!(bridge.held_calls.load(Ordering::SeqCst), 0);
    assert_eq!(*resolver.held_seen.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn erro_grava_o_efeito_antes_de_responder() {
    let failure = PlayError {
        error: DebridError::NoVideo("sem vídeo".into()),
        files: Some(vec![PlayFile {
            path: "Pack/leia.txt".into(),
            size: 10.0,
        }]),
    };
    let bridge = RecordingBridge::new(true);
    let (status, body) = run(
        "alldebrid",
        FixedResolver::new(Err(failure)),
        bridge.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, "nenhum arquivo de vídeo no torrent");
    // `handle` só voltou depois do `apply`: o corpo já está gravado.
    let applied = bridge.applied.lock().unwrap();
    assert_eq!(applied.len(), 1);
    let sent = &applied[0];
    assert_eq!(sent["outcome"], "error");
    assert_eq!(sent["effect"]["mark"], "bad");
    assert_eq!(sent["effect"]["invalidate"], "obra");
    assert_eq!(sent["imdbId"], "tt0944947");
    assert_eq!(sent["season"], 2);
    assert_eq!(sent["episode"], 5);
    assert_eq!(sent["files"][0]["path"], "Pack/leia.txt");
    assert!(sent.get("apiKey").is_none(), "a chave nunca vai no corpo");
    assert!(sent["encoded"].as_str().is_some_and(|e| !e.is_empty()));
}

#[tokio::test]
async fn erro_neutro_sem_prova_nao_chama_o_node() {
    let failure = PlayError::from(DebridError::other("caiu"));
    let bridge = RecordingBridge::new(true);
    let (status, _) = run("torbox", FixedResolver::new(Err(failure)), bridge.clone()).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(bridge.applied.lock().unwrap().is_empty());
}

#[tokio::test]
async fn sucesso_responde_302_e_grava_vivo_em_fundo() {
    let outcome = PlayOutcome {
        url: Some("https://cdn.test/play.mkv".into()),
        ..PlayOutcome::default()
    };
    let bridge = RecordingBridge::new(true);
    let (status, _) = run("torbox", FixedResolver::new(Ok(outcome)), bridge.clone()).await;
    assert_eq!(status, StatusCode::FOUND);
    // O efeito do sucesso vai numa task: espera curta até ele chegar.
    for _ in 0..50 {
        if !bridge.applied.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let applied = bridge.applied.lock().unwrap();
    assert_eq!(applied.len(), 1);
    assert_eq!(applied[0]["outcome"], "ok");
    assert_eq!(applied[0]["alive"], true);
}

#[test]
fn ainda_baixando_nao_marca_vivo() {
    let target = EffectTarget {
        encoded: "",
        service: "alldebrid",
        hash: HASH,
        imdb: "",
        season: None,
        episode: None,
    };
    let frio = PlayOutcome {
        url: None,
        unavailable: true,
        files: None,
    };
    let body = ok_payload(&target, &frio);
    assert_eq!(body["alive"], false);
    assert_eq!(body["unavailable"], true);
}

#[test]
fn ponte_so_em_loopback() {
    assert!(is_loopback_base("http://127.0.0.1:7100"));
    assert!(is_loopback_base("http://localhost:7100/"));
    assert!(is_loopback_base("http://[::1]:7100"));
    assert!(!is_loopback_base("http://10.0.0.5:7100"));
    assert!(!is_loopback_base("https://127.0.0.1.example.com"));
    assert!(!is_loopback_base("127.0.0.1:7100"));
}
