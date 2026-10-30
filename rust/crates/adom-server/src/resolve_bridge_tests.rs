//! Testes da ponte do `/resolve` nativo: o `held` (só AllDebrid) e o fio da
//! rota (`resolve_native::handle`): o efeito do erro chega ao aplicador ANTES
//! da resposta, e o do sucesso não segura o 302.

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
use crate::play_effects_native::{PlayEffects, PlayJob};
use crate::resolve_native::{self, NativeContext, PlayFuture, PlayResolver};

const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const SECRET: &str = "segredo";

/// Ponte que responde um `held` fixo e conta as perguntas.
struct RecordingBridge {
    held: bool,
    held_calls: AtomicU32,
}

impl RecordingBridge {
    fn new(held: bool) -> Arc<Self> {
        Arc::new(Self {
            held,
            held_calls: AtomicU32::new(0),
        })
    }
}

impl PlayBridge for RecordingBridge {
    fn held<'a>(&'a self, _api_key: &'a str, _hash: &'a str) -> BridgeFuture<'a, bool> {
        self.held_calls.fetch_add(1, Ordering::SeqCst);
        let held = self.held;
        Box::pin(async move { held })
    }
}

type OkCall = (PlayJob, bool, bool, Option<Vec<PlayFile>>);
type ErrCall = (PlayJob, Value, Option<Vec<PlayFile>>);

/// Gravador de faz de conta: guarda o que o aplicador receberia.
#[derive(Default)]
struct RecordingEffects {
    ok: Mutex<Vec<OkCall>>,
    error: Mutex<Vec<ErrCall>>,
}

impl PlayEffects for RecordingEffects {
    fn apply_ok(&self, job: PlayJob, alive: bool, unavailable: bool, files: Option<Vec<PlayFile>>) {
        self.ok
            .lock()
            .unwrap()
            .push((job, alive, unavailable, files));
    }
    fn apply_error(&self, job: PlayJob, effect: Value, files: Option<Vec<PlayFile>>) {
        self.error.lock().unwrap().push((job, effect, files));
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
    effects: Arc<RecordingEffects>,
) -> (StatusCode, String) {
    let (path, query) = signed(service);
    let ctx = NativeContext {
        resolve_secret: SECRET.into(),
        resolver,
        bridge,
        effects,
    };
    let response = resolve_native::handle(&path, query.as_deref(), &ctx).await;
    let status = response.status();
    let bytes = http_body_util::BodyExt::collect(response.into_body())
        .await
        .unwrap()
        .to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

/// O efeito do sucesso vai numa task: espera curta até ele chegar.
async fn espera_ok(effects: &RecordingEffects) {
    for _ in 0..50 {
        if !effects.ok.lock().unwrap().is_empty() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn alldebrid_pergunta_o_hold_e_repassa_ao_adaptador() {
    let resolver = FixedResolver::new(Ok(PlayOutcome::default()));
    let bridge = RecordingBridge::new(false);
    run(
        "alldebrid",
        resolver.clone(),
        bridge.clone(),
        Arc::default(),
    )
    .await;
    assert_eq!(bridge.held_calls.load(Ordering::SeqCst), 1);
    assert_eq!(*resolver.held_seen.lock().unwrap(), vec![false]);

    // Os outros serviços não têm hold: nem pergunta, e o adaptador recebe `true`.
    let resolver = FixedResolver::new(Ok(PlayOutcome::default()));
    let bridge = RecordingBridge::new(false);
    run("torbox", resolver.clone(), bridge.clone(), Arc::default()).await;
    assert_eq!(bridge.held_calls.load(Ordering::SeqCst), 0);
    assert_eq!(*resolver.held_seen.lock().unwrap(), vec![true]);
}

#[tokio::test]
async fn erro_chega_ao_aplicador_antes_de_responder() {
    let failure = PlayError {
        error: DebridError::NoVideo("sem vídeo".into()),
        files: Some(vec![PlayFile {
            path: "Pack/leia.txt".into(),
            size: 10.0,
        }]),
    };
    let effects = Arc::new(RecordingEffects::default());
    let (status, body) = run(
        "alldebrid",
        FixedResolver::new(Err(failure)),
        RecordingBridge::new(true),
        effects.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, "nenhum arquivo de vídeo no torrent");
    // `handle` só voltou depois da escrita: o efeito já está registrado.
    let errors = effects.error.lock().unwrap();
    assert_eq!(errors.len(), 1);
    let (job, effect, files) = &errors[0];
    assert_eq!(effect["mark"], "bad");
    assert_eq!(effect["invalidate"], "obra");
    assert_eq!(job.imdb, "tt0944947");
    assert_eq!(job.season, Some(2));
    assert_eq!(job.episode, Some(5));
    assert_eq!(job.service, "alldebrid");
    assert_eq!(files.as_ref().unwrap()[0].path, "Pack/leia.txt");
}

#[tokio::test]
async fn erro_neutro_chega_sem_marcar_nada() {
    let failure = PlayError::from(DebridError::other("caiu"));
    let effects = Arc::new(RecordingEffects::default());
    let (status, _) = run(
        "torbox",
        FixedResolver::new(Err(failure)),
        RecordingBridge::new(true),
        effects.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let errors = effects.error.lock().unwrap();
    assert_eq!(errors.len(), 1);
    assert!(errors[0].1["mark"].is_null());
    assert_eq!(errors[0].1["invalidate"], "none");
}

#[tokio::test]
async fn sucesso_responde_302_e_grava_vivo_em_fundo() {
    let outcome = PlayOutcome {
        url: Some("https://cdn.test/play.mkv".into()),
        ..PlayOutcome::default()
    };
    let effects = Arc::new(RecordingEffects::default());
    let (status, _) = run(
        "torbox",
        FixedResolver::new(Ok(outcome)),
        RecordingBridge::new(true),
        effects.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    espera_ok(&effects).await;
    let oks = effects.ok.lock().unwrap();
    assert_eq!(oks.len(), 1);
    assert!(oks[0].1, "alive: o play devolveu link");
    assert!(!oks[0].2, "sem frio medido");
}

#[tokio::test]
async fn ainda_baixando_registra_frio_sem_marcar_vivo() {
    let outcome = PlayOutcome {
        url: None,
        unavailable: true,
        files: None,
    };
    let effects = Arc::new(RecordingEffects::default());
    let (status, _) = run(
        "torbox",
        FixedResolver::new(Ok(outcome)),
        RecordingBridge::new(true),
        effects.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    espera_ok(&effects).await;
    let oks = effects.ok.lock().unwrap();
    assert_eq!(oks.len(), 1);
    assert!(!oks[0].1, "sem link não é vivo");
    assert!(oks[0].2, "frio medido vai ao aplicador");
}
