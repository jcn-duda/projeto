use super::*;

fn config() -> RdSchedulerConfig {
    RdSchedulerConfig {
        min_gap_ms: 0.0,
        max_gap_ms: 100.0,
        cooldown_ms: 100.0,
        play_max_wait_ms: 10.0,
        success_threshold: 2,
        enabled: true,
    }
}

#[tokio::test]
async fn tarefas_da_mesma_conta_sao_serializadas_e_outras_contas_passam() {
    let gate = RdGateExecutor::new(config());
    let first = gate.acquire("a", GatePriority::Autofetch).await.unwrap();
    let second_gate = gate.clone();
    let second = tokio::spawn(async move {
        second_gate
            .acquire("a", GatePriority::Cleanup)
            .await
            .unwrap()
    });
    let other = tokio::time::timeout(
        Duration::from_secs(1),
        gate.acquire("b", GatePriority::Play),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert!(!second.is_finished());
    first.finish(RdOutcome::Success);
    let second = tokio::time::timeout(Duration::from_secs(1), second)
        .await
        .unwrap()
        .unwrap();
    second.finish(RdOutcome::Success);
    drop(other);
}

#[tokio::test]
async fn cancelar_espera_e_permit_nao_deixa_conta_travada() {
    let gate = RdGateExecutor::new(config());
    let first = gate.acquire("a", GatePriority::Play).await.unwrap();
    let copy = gate.clone();
    let waiting = tokio::spawn(async move { copy.acquire("a", GatePriority::Cleanup).await });
    tokio::time::sleep(Duration::from_millis(10)).await;
    waiting.abort();
    let _ = waiting.await;
    drop(first);
    let next = tokio::time::timeout(
        Duration::from_secs(1),
        gate.acquire("a", GatePriority::Autofetch),
    )
    .await
    .unwrap()
    .unwrap();
    drop(next);
    assert!(tokio::time::timeout(
        Duration::from_secs(1),
        gate.acquire("a", GatePriority::Play)
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn rate_limit_nega_autofetch_e_cleanup_ainda_passa() {
    let gate = RdGateExecutor::new(config());
    let first = gate.acquire("a", GatePriority::Autofetch).await.unwrap();
    first.finish(RdOutcome::RateLimit(Some(500.0)));
    assert!(matches!(
        gate.acquire("a", GatePriority::Autofetch).await,
        Err(CooldownDenied)
    ));
    let cleanup = tokio::time::timeout(
        Duration::from_secs(1),
        gate.acquire("a", GatePriority::Cleanup),
    )
    .await
    .unwrap()
    .unwrap();
    drop(cleanup);
}

#[tokio::test]
async fn cancelamento_de_chamador_nao_libera_escrita_em_voo() {
    use axum::{extract::State, routing::post, Router};
    use tokio::net::TcpListener;

    #[derive(Clone)]
    struct ServerState {
        received: Arc<Notify>,
        reply: Arc<Notify>,
    }
    async fn controlled(State(state): State<ServerState>) -> &'static str {
        state.received.notify_one();
        state.reply.notified().await;
        "ok"
    }

    let state = ServerState {
        received: Arc::new(Notify::new()),
        reply: Arc::new(Notify::new()),
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/write", post(controlled))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let gate = RdGateExecutor::new(config());
    let running_gate = gate.clone();
    let first = tokio::spawn(async move {
        running_gate
            .run("account", GatePriority::Autofetch, move || async move {
                let ok = reqwest::Client::new()
                    .post(format!("http://{addr}/write"))
                    .send()
                    .await
                    .is_ok();
                (
                    ok,
                    if ok {
                        RdOutcome::Success
                    } else {
                        RdOutcome::Error
                    },
                )
            })
            .await
    });
    tokio::time::timeout(Duration::from_secs(2), state.received.notified())
        .await
        .unwrap();
    first.abort();
    let _ = first.await;
    let next_gate = gate.clone();
    let second = tokio::spawn(async move {
        next_gate
            .run("account", GatePriority::Cleanup, || async {
                (42, RdOutcome::Success)
            })
            .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !second.is_finished(),
        "uma segunda escrita entrou antes da resposta"
    );
    state.reply.notify_one();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        42
    );
    server.abort();
}
