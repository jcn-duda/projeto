//! Fase 1 do warmer: freio ocioso, gate RD único do processo e dreno do
//! operador (lote padrão + pausa). Nada de HTTP: a porta é um duplo.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use crate::harvest::StreamTraffic;
use crate::rd_warmer::{NoMagnet, RamQueue, WarmConfig, WarmDeps, Warmer};

use super::{payload, FakeKey, FakeLedger, FakePort, HASH_DOWN, HASH_ERR, HASH_READY, RD_SCOPE_A};

fn warmer_with_traffic(
    config: WarmConfig,
    traffic: Option<StreamTraffic>,
) -> (Arc<Warmer>, Arc<FakePort>) {
    let port = Arc::new(FakePort::default());
    let warm = Warmer::with_deps(WarmDeps {
        config,
        key: FakeKey::some("k"),
        port: port.clone(),
        ledger: Arc::new(FakeLedger::default()),
        magnet: Arc::new(NoMagnet),
        queue: Arc::new(RamQueue),
        traffic,
    });
    (warm, port)
}

#[tokio::test]
async fn freio_ocioso_segura_o_dreno_ate_a_janela_passar() {
    let now = adom_sources::now_ms();
    let last = Arc::new(AtomicI64::new(now));
    let traffic = StreamTraffic::new(Arc::clone(&last), 60_000);
    let (warm, port) = warmer_with_traffic(WarmConfig::fixture(10, 100, 300), Some(traffic));

    assert_eq!(warm.enqueue(&payload(&[HASH_READY]), RD_SCOPE_A), 1);
    assert_eq!(
        warm.drain_if_idle().await,
        0,
        "tráfego recente não vira sonda"
    );
    assert_eq!(warm.pending(), 1, "o trabalho continua na fila");
    assert!(
        port.batches().is_empty(),
        "nem uma chamada durante a janela"
    );

    // Fora da janela de 60 s: o MESMO warmer drena.
    last.store(now - 120_000, Ordering::Relaxed);
    assert_eq!(warm.drain_if_idle().await, 1);
    assert_eq!(port.batches(), vec![vec![HASH_READY.to_string()]]);
    assert_eq!(warm.pending(), 0);
}

#[tokio::test]
async fn sem_freio_de_trafego_o_dreno_ocioso_trabalha() {
    let (warm, port) = warmer_with_traffic(WarmConfig::fixture(10, 100, 300), None);
    assert_eq!(warm.enqueue(&payload(&[HASH_READY]), RD_SCOPE_A), 1);
    assert_eq!(warm.drain_if_idle().await, 1);
    assert_eq!(port.batches(), vec![vec![HASH_READY.to_string()]]);
}

#[test]
fn gate_rd_do_processo_e_uma_instancia_so() {
    // `shared_gate` é global: a prova é a instância, nunca a contagem.
    let first = crate::autofetch::shared_gate();
    let second = crate::autofetch::shared_gate();
    assert!(first.same_instance(&second));
}

#[tokio::test]
async fn dreno_do_operador_usa_o_lote_padrao_e_respeita_a_pausa() {
    let (warm, port) = warmer_with_traffic(WarmConfig::fixture(2, 100, 300), None);
    assert_eq!(
        warm.enqueue(&payload(&[HASH_READY, HASH_DOWN, HASH_ERR]), RD_SCOPE_A),
        3
    );

    // `max == 0` = lote padrão (`batch`), como no `drain(max)` do Node.
    assert_eq!(warm.drain_admin(0).await, 2);
    assert_eq!(warm.pending(), 1, "o resto fica para a próxima rodada");
    assert_eq!(
        port.batches(),
        vec![vec![HASH_READY.to_string(), HASH_DOWN.to_string()]]
    );

    warm.set_paused(true);
    assert!(warm.is_paused());
    assert_eq!(warm.drain().await, 0, "pausa bloqueia o dreno");
    assert_eq!(warm.drain_admin(0).await, 0);
    assert_eq!(warm.pending(), 1);
    assert_eq!(port.batches().len(), 1, "nenhuma sonda nova");

    warm.set_paused(false);
    assert_eq!(warm.drain_admin(5).await, 1);
    assert_eq!(warm.pending(), 0);
}
