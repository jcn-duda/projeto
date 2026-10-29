//! Regressão do pool de conexões do proxy (o 502 intermitente do painel).
//!
//! O gateway reusava a conexão ociosa por até 90 s (default do `hyper_util`)
//! enquanto o upstream — o http server do Node — fecha a dele em 5 s. Com o poll
//! do painel a cada 10 s, a requisição caía numa conexão já morta e o `dispatch`
//! devolvia `bad_gateway` em ~100 ms, 1 em ~17 rodadas. Aqui o prazo do pool é
//! injetado curto para a propriedade ficar observável sem esperar 2 s.

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener as StdListener;
use std::time::Duration;

const OK_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok";

/// Upstream HTTP/1.1 mínimo com keep-alive, contando conexões ACEITAS (não
/// requests): é a única forma de observar se o pool reusou ou abriu de novo.
/// Thread de `std` de propósito — o teste não precisa de `io-util` no tokio.
fn spawn_keepalive_upstream() -> (SocketAddr, Arc<AtomicU32>) {
    let accepted = Arc::new(AtomicU32::new(0));
    let counter = accepted.clone();
    let listener = StdListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            counter.fetch_add(1, Ordering::SeqCst);
            std::thread::spawn(move || {
                // Acumula até o fim do cabeçalho: um `read` pode trazer só parte
                // da requisição e responder duas vezes embaralharia o pipeline.
                let mut pending: Vec<u8> = Vec::new();
                let mut buf = [0u8; 1024];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) => break,
                        Ok(read) => pending.extend_from_slice(&buf[..read]),
                        Err(_) => break,
                    }
                    while let Some(end) = pending.windows(4).position(|w| w == b"\r\n\r\n") {
                        pending.drain(..end + 4);
                        if stream.write_all(OK_RESPONSE).is_err() || stream.flush().is_err() {
                            return;
                        }
                    }
                }
            });
        }
    });
    (addr, accepted)
}

fn get(path: &str) -> Request<Body> {
    Request::builder().uri(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn pool_descarta_conexao_ociosa_antes_de_reusar() {
    let (upstream, accepted) = spawn_keepalive_upstream();
    let mut state = gateway_state(upstream, false);
    state.client = proxy::client_with(Duration::from_millis(200));
    let gateway = spawn_gateway_state(state).await;

    let (status, body) = call(gateway, get("/a")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body, "ok");
    assert_eq!(accepted.load(Ordering::SeqCst), 1);

    let (status, body) = call(gateway, get("/b")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        1,
        "conexão quente tem que ser reusada"
    );

    // Passou do `pool_idle_timeout`: o pool DESCARTA. Era exatamente o que
    // faltava — sem isso ele reusava depois do keep-alive do Node e o request
    // morria com 502 `bad_gateway`.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (status, body) = call(gateway, get("/c")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        2,
        "conexão ociosa além do prazo tem que ser descartada, não reusada"
    );
}

/// O prazo de produção tem que caber no keep-alive do Node (5 s) com folga:
/// quem mexer nele para cima reabre o 502 do painel.
#[test]
fn pool_idle_cabe_no_keepalive_do_upstream() {
    assert!(proxy::POOL_IDLE <= Duration::from_secs(3));
    assert!(proxy::POOL_IDLE >= Duration::from_millis(500));
}
