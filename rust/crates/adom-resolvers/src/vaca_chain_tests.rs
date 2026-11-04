use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;

use super::run_limited;

#[tokio::test]
async fn limita_cadeias_simultaneas() {
    let sem = Arc::new(Semaphore::new(2));
    let live = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let tasks: Vec<_> = (0..9)
        .map(|_| {
            let (sem, live, peak) = (sem.clone(), live.clone(), peak.clone());
            tokio::spawn(async move {
                run_limited(&sem, Duration::ZERO, || {
                    let (live, peak) = (live.clone(), peak.clone());
                    async move {
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        live.fetch_sub(1, Ordering::SeqCst);
                        Ok::<_, String>("magnet:?xt=urn:btih:x".to_string())
                    }
                })
                .await
            })
        })
        .collect();
    for t in tasks {
        assert!(t.await.unwrap().is_ok());
    }
    assert_eq!(peak.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn repete_uma_vez_no_429() {
    let sem = Semaphore::new(1);
    let calls = AtomicUsize::new(0);
    let out = run_limited(&sem, Duration::from_millis(1), || async {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Err("HTTP 429".to_string())
        } else {
            Ok("magnet:?xt=urn:btih:y".to_string())
        }
    })
    .await;
    assert_eq!(out.as_deref(), Ok("magnet:?xt=urn:btih:y"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn nao_entra_em_laco_nem_repete_outros_erros() {
    let sem = Semaphore::new(1);
    let calls = AtomicUsize::new(0);
    let out = run_limited(&sem, Duration::from_millis(1), || async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err::<String, _>("HTTP 429".to_string())
    })
    .await;
    assert_eq!(out, Err("HTTP 429".to_string()));
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    let calls = AtomicUsize::new(0);
    let out = run_limited(&sem, Duration::from_millis(1), || async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err::<String, _>("HTTP 403".to_string())
    })
    .await;
    assert_eq!(out, Err("HTTP 403".to_string()));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn espera_zero_desliga_a_nova_tentativa() {
    let sem = Semaphore::new(1);
    let calls = AtomicUsize::new(0);
    let _ = run_limited(&sem, Duration::ZERO, || async {
        calls.fetch_add(1, Ordering::SeqCst);
        Err::<String, _>("HTTP 429".to_string())
    })
    .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
