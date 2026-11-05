use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::Memo;

const HOUR: Duration = Duration::from_secs(3600);
const BTN: &str = "https://vaqueirofilmes.com/enc/go.php?id=abc";

async fn call(
    memo: &Memo,
    ttl: Duration,
    site: &str,
    url: &str,
    calls: &AtomicUsize,
    ok: bool,
) -> Result<String, String> {
    memo.through(ttl, site, url, || async {
        calls.fetch_add(1, Ordering::SeqCst);
        if ok {
            Ok("magnet:?xt=urn:btih:aa".to_string())
        } else {
            Err("HTTP 429".to_string())
        }
    })
    .await
}

#[tokio::test]
async fn segunda_busca_nao_refaz_a_cadeia() {
    let memo = Memo::new(10);
    let calls = AtomicUsize::new(0);
    assert!(call(&memo, HOUR, "vacatorrent", BTN, &calls, true)
        .await
        .is_ok());
    assert_eq!(
        call(&memo, HOUR, "vacatorrent", BTN, &calls, false)
            .await
            .as_deref(),
        Ok("magnet:?xt=urn:btih:aa")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn falha_nao_fica_guardada() {
    let memo = Memo::new(10);
    let calls = AtomicUsize::new(0);
    assert!(call(&memo, HOUR, "vacatorrent", BTN, &calls, false)
        .await
        .is_err());
    assert!(call(&memo, HOUR, "vacatorrent", BTN, &calls, true)
        .await
        .is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn chave_separa_site_e_ttl_zero_desliga() {
    let memo = Memo::new(10);
    let calls = AtomicUsize::new(0);
    call(&memo, HOUR, "vacatorrent", BTN, &calls, true)
        .await
        .unwrap();
    call(&memo, HOUR, "bludv", BTN, &calls, true).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    call(&memo, Duration::ZERO, "vacatorrent", BTN, &calls, true)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn vencido_refaz_e_teto_tira_o_mais_velho() {
    let memo = Memo::new(2);
    let calls = AtomicUsize::new(0);
    call(&memo, HOUR, "s", "https://a/1", &calls, true)
        .await
        .unwrap();
    call(&memo, HOUR, "s", "https://a/2", &calls, true)
        .await
        .unwrap();
    call(&memo, HOUR, "s", "https://a/3", &calls, true)
        .await
        .unwrap();
    call(&memo, HOUR, "s", "https://a/1", &calls, true)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 4, "o 1 saiu pelo teto");
    tokio::time::sleep(Duration::from_millis(5)).await;
    call(
        &memo,
        Duration::from_millis(1),
        "s",
        "https://a/3",
        &calls,
        true,
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 5, "vencido refaz");
}

#[tokio::test]
async fn magnet_cru_nao_passa_pela_memoria() {
    let memo = Memo::new(10);
    let calls = AtomicUsize::new(0);
    call(&memo, HOUR, "s", "magnet:?xt=urn:btih:bb", &calls, true)
        .await
        .unwrap();
    call(&memo, HOUR, "s", "magnet:?xt=urn:btih:bb", &calls, true)
        .await
        .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
