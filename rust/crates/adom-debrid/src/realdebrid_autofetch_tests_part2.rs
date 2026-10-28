//! Casos de contrato dos primitivos RD: quarentena, gate compartilhado,
//! posse, entrada inválida e falha de store (fail-closed).

use super::super::RdHashSnapshot;
use super::*;
use crate::rd_gate_executor::RdGateExecutor;
use crate::rd_scheduler::{RdOutcome, RdSchedulerConfig};
use adom_core::GatePriority;

fn account_scope() -> String {
    super::super::transport::validate(KEY, HASH).unwrap().0
}

fn gate_with(cooldown_ms: f64) -> RdGateExecutor {
    RdGateExecutor::new(RdSchedulerConfig {
        min_gap_ms: 0.0,
        max_gap_ms: 0.0,
        cooldown_ms,
        play_max_wait_ms: 0.0,
        success_threshold: 2,
        enabled: true,
    })
}

#[tokio::test]
async fn intent_pendente_recusa_enqueue_e_delete_sem_tocar_a_rede() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    store.seed_intent(&key());
    store.seed_owned(&account_scope(), HASH, "42");
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    assert_eq!(
        manager
            .enqueue(
                rd.clone(),
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await
            .unwrap_err(),
        RdAutofetchError::Quarantined
    );
    assert_eq!(
        manager.remove(rd, KEY, HASH, "42").await.unwrap_err(),
        RdAutofetchError::Quarantined,
        "a quarentena também barra o delete"
    );
    assert!(
        state.requests.lock().unwrap().is_empty(),
        "quarentena nunca faz HTTP"
    );
    assert!(store.has(&key()), "o intent só sai com prova");
    server.abort();
}

#[tokio::test]
async fn intent_que_aparece_dentro_do_gate_tambem_e_quarentena() {
    let store = Arc::new(FakeStore::default());
    *store.reject_put.lock().unwrap() = true;
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    assert_eq!(
        manager
            .enqueue(
                rd,
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await
            .unwrap_err(),
        RdAutofetchError::Quarantined,
        "perder a corrida para outro intent é quarentena, não erro de serviço"
    );
    assert!(state.requests.lock().unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn cooldown_do_gate_recusa_enqueue_sem_rede() {
    let store = Arc::new(FakeStore::default());
    let manager = RealDebridAutofetch::new(gate_with(60_000.0), store.clone());
    let state = Arc::new(MockState::default());
    *state.add_status.lock().unwrap() = Some(StatusCode::TOO_MANY_REQUESTS);
    let (rd, server) = service(state.clone()).await;
    let hint = PlayHint::default();

    // 429 no addMagnet: recusa definitiva, intent liberado e gate em cooldown.
    assert!(matches!(
        manager
            .enqueue(
                rd.clone(),
                KEY,
                HASH,
                None,
                &hint,
                std::time::Duration::ZERO
            )
            .await,
        Err(RdAutofetchError::Debrid(_))
    ));
    assert!(
        !store.has(&key()),
        "429 é recusa definitiva: solta o intent"
    );
    let seen = state.requests.lock().unwrap().len();
    assert_eq!(seen, 1);

    // Autofetch em cooldown é DENY: nem intent, nem HTTP.
    assert_eq!(
        manager
            .enqueue(rd, KEY, HASH, None, &hint, std::time::Duration::ZERO)
            .await
            .unwrap_err(),
        RdAutofetchError::Cooldown
    );
    assert_eq!(
        state.requests.lock().unwrap().len(),
        seen,
        "cooldown não faz HTTP"
    );
    server.abort();
}

#[tokio::test]
async fn remove_espera_o_gate_compartilhado_com_o_play() {
    let gate = gate();
    let store = Arc::new(FakeStore::default());
    // O clone é a instância do play: um gate novo aqui não serializaria nada.
    let manager = RealDebridAutofetch::new(gate.clone(), store.clone());
    store.seed_owned(&account_scope(), HASH, "42");
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let holder = {
        let gate = gate.clone();
        let account = account_scope();
        tokio::spawn(async move {
            gate.run(&account, GatePriority::Play, move || async move {
                let _ = started_tx.send(());
                let _ = release_rx.await;
                ((), RdOutcome::Success)
            })
            .await
        })
    };
    started_rx.await.unwrap();

    let remove_task = {
        let manager = manager.clone();
        let rd = rd.clone();
        tokio::spawn(async move { manager.remove(rd, KEY, HASH, "42").await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        state.requests.lock().unwrap().is_empty(),
        "remove tem que esperar o job do play"
    );
    assert!(!remove_task.is_finished());

    release_tx.send(()).unwrap();
    assert!(holder.await.unwrap().is_ok());
    assert!(remove_task.await.unwrap().unwrap());
    let requests = state.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "DELETE");
    assert_eq!(requests[0].1, "/torrents/delete/42");
    server.abort();
}

#[tokio::test]
async fn posse_ausente_bloqueia_delete_sem_gravar_intent() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    // Marker de OUTRO transfer: existe dono, mas não deste id.
    store.seed_owned(&account_scope(), HASH, "43");
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    assert!(!manager.remove(rd, KEY, HASH, "42").await.unwrap());
    assert!(
        state.requests.lock().unwrap().is_empty(),
        "sem posse não há DELETE"
    );
    assert!(!store.has(&key()), "sem posse não grava intent");
    server.abort();
}

#[tokio::test]
async fn entrada_invalida_nao_toca_rede_nem_store() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;
    let hint = PlayHint::default();
    let wait = std::time::Duration::ZERO;
    let non_hex = "z".repeat(40);

    for (api_key, hash) in [("", HASH), (KEY, ""), (KEY, "abc"), (KEY, non_hex.as_str())] {
        let case = format!("{api_key:?}/{hash:?}");
        assert_eq!(
            manager
                .enqueue(rd.clone(), api_key, hash, None, &hint, wait)
                .await
                .unwrap_err(),
            RdAutofetchError::InvalidInput,
            "enqueue inválido: {case}"
        );
        assert_eq!(
            manager
                .remove(rd.clone(), api_key, hash, "42")
                .await
                .unwrap_err(),
            RdAutofetchError::InvalidInput,
            "remove inválido: {case}"
        );
        assert_eq!(
            manager.acknowledge_marker(api_key, hash, "42").unwrap_err(),
            RdAutofetchError::InvalidInput,
            "marker inválido: {case}"
        );
        assert_eq!(
            manager
                .reconcile(api_key, hash, RdHashSnapshot::CompleteAbsent)
                .unwrap_err(),
            RdAutofetchError::InvalidInput,
            "reconcile inválido: {case}"
        );
    }

    // ID do torrent também é entrada: digitos, nunca vazio nem zero.
    for id in ["", "0", "42a", "../42"] {
        assert_eq!(
            manager.remove(rd.clone(), KEY, HASH, id).await.unwrap_err(),
            RdAutofetchError::InvalidInput,
            "id inválido: {id:?}"
        );
    }

    assert!(state.requests.lock().unwrap().is_empty());
    assert!(!store.has(&key()), "entrada inválida não grava intent");
    server.abort();
}

#[tokio::test]
async fn falha_de_leitura_do_store_vira_store_unavailable() {
    let store = Arc::new(FakeStore::default());
    store.seed_owned(&account_scope(), HASH, "42");
    *store.fail_read.lock().unwrap() = true;
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    assert_eq!(
        manager
            .enqueue(
                rd,
                KEY,
                HASH,
                None,
                &PlayHint::default(),
                std::time::Duration::ZERO
            )
            .await
            .unwrap_err(),
        RdAutofetchError::StoreUnavailable
    );
    assert_eq!(
        manager.acknowledge_marker(KEY, HASH, "42").unwrap_err(),
        RdAutofetchError::StoreUnavailable,
        "sem leitura não há como provar a posse"
    );
    assert!(state.requests.lock().unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn falha_ao_limpar_intent_nao_libera_a_quarentena() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    let (rd, server) = service(state.clone()).await;

    let id = manager
        .enqueue(
            rd,
            KEY,
            HASH,
            None,
            &PlayHint::default(),
            std::time::Duration::ZERO,
        )
        .await
        .unwrap();
    assert_eq!(id.as_deref(), Some("42"));

    store.seed_owned(&account_scope(), HASH, "42");
    *store.fail_clear.lock().unwrap() = true;
    assert_eq!(
        manager.acknowledge_marker(KEY, HASH, "42").unwrap_err(),
        RdAutofetchError::StoreUnavailable
    );
    assert!(
        store.has(&key()),
        "limpeza falhou: o intent fica (fail-closed, nunca segue sem intent)"
    );
    server.abort();
}

#[tokio::test]
async fn acknowledge_marker_de_id_estranho_nao_libera_intent() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    store.seed_intent(&key());
    store.seed_owned(&account_scope(), HASH, "42");

    assert!(!manager.acknowledge_marker(KEY, HASH, "43").unwrap());
    assert!(store.has(&key()), "marker de outro transfer não libera");
    assert!(manager.acknowledge_marker(KEY, HASH, "42").unwrap());
    assert!(!store.has(&key()));
}

#[tokio::test]
async fn timeout_ou_5xx_no_delete_preserva_quarentena_ate_reconciliacao() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    *state.delete_status.lock().unwrap() = Some(StatusCode::BAD_GATEWAY);
    let (rd, server) = service(state.clone()).await;
    store.seed_owned(&account_scope(), HASH, "42");

    assert!(manager.remove(rd, KEY, HASH, "42").await.is_err());
    assert!(store.has(&key()));
    assert!(!manager
        .reconcile(KEY, HASH, RdHashSnapshot::Present)
        .unwrap());
    assert!(!manager
        .reconcile(KEY, HASH, RdHashSnapshot::Unknown)
        .unwrap());
    assert!(manager
        .reconcile(KEY, HASH, RdHashSnapshot::CompleteAbsent)
        .unwrap());
    assert!(!store.has(&key()));
    server.abort();
}

#[tokio::test]
async fn resposta_429_no_delete_e_recusa_definitiva_e_libera_intent() {
    let store = Arc::new(FakeStore::default());
    let manager = make_manager(&store);
    let state = Arc::new(MockState::default());
    *state.delete_status.lock().unwrap() = Some(StatusCode::TOO_MANY_REQUESTS);
    let (rd, server) = service(state).await;
    store.seed_owned(&account_scope(), HASH, "42");

    assert!(manager.remove(rd, KEY, HASH, "42").await.is_err());
    assert!(!store.has(&key()));
    server.abort();
}
