//! Testes do ciclo do colhedor SEM REDE: drain fake, teto horário e o
//! enqueue/dedupe da estrutura (a rota é só o parser + o handle).
//!
//! O que NÃO se testa aqui: `NetworkDrain` (Jackett/metadados reais), a thread
//! do ciclo e as rotas HTTP — esses exigem gateway e indexer de pé.

use std::future::Future;
use std::pin::Pin;

use adom_harvest::{
    load_hour, save_hour, DrainOutcome, HarvestDrainAsync, HarvestEntry, HarvestQueue,
    HarvestQueueConfig, HarvestRequest, HarvestStore, HarvestWorker, HarvestWorkerConfig,
    StubTraffic, TickOutcome,
};

use super::enqueue_with_dedupe;
use super::routes::request_from_body;

/// Drain fake: registra quem foi drenado e devolve as consultas pedidas.
struct FakeDrain {
    seen: Vec<String>,
    queries: u32,
}

impl HarvestDrainAsync for FakeDrain {
    fn drain_one<'a>(
        &'a mut self,
        entry: &'a HarvestEntry,
    ) -> Pin<Box<dyn Future<Output = DrainOutcome> + Send + 'a>> {
        self.seen.push(entry.imdb_id.clone());
        let queries = self.queries;
        Box::pin(async move { DrainOutcome::ok_with_queries(queries) })
    }
}

fn queue_with(ids: &[&str]) -> HarvestQueue {
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    for id in ids {
        assert!(queue.enqueue(HarvestRequest::movie(*id, "miss")).accepted);
    }
    queue
}

fn worker(max_per_hour: u32) -> HarvestWorker {
    HarvestWorker::new(HarvestWorkerConfig {
        enabled: true,
        max_per_hour,
    })
}

#[tokio::test]
async fn tick_drena_a_cabeca_e_grava_o_balde() {
    let store = HarvestStore::open_memory().unwrap();
    let now = 1_700_000_000_000;
    let mut queue = queue_with(&["tt0111161", "tt0068646"]);
    let mut worker = worker(120);
    let mut drain = FakeDrain {
        seen: Vec::new(),
        queries: 2,
    };

    let outcome = worker
        .tick_async(&mut queue, &StubTraffic::default(), &mut drain, now)
        .await;
    assert!(outcome.did_drain());
    // A CABEÇA saiu (FIFO) e só ela.
    assert_eq!(drain.seen, vec!["tt0111161"]);
    assert_eq!(queue.depth(), 1);
    // Consultas debitadas e o balde do L2 é o mesmo que o Node leria.
    assert_eq!(worker.queries_this_hour(now), 2);
    save_hour(&store, worker.queries_this_hour(now), now).unwrap();
    let hour = load_hour(&store, now).unwrap().expect("balde da hora");
    assert_eq!(hour.count, 2);
}

#[tokio::test]
async fn teto_horario_para_o_tick_sem_consumir_a_fila() {
    let now = 1_700_000_000_000;
    let mut queue = queue_with(&["tt0111161", "tt0068646"]);
    let mut worker = worker(1);
    let mut drain = FakeDrain {
        seen: Vec::new(),
        queries: 1,
    };

    assert!(worker
        .tick_async(&mut queue, &StubTraffic::default(), &mut drain, now)
        .await
        .did_drain());
    // O balde da hora já bateu o teto: o segundo tick não consome nada.
    assert_eq!(
        worker
            .tick_async(&mut queue, &StubTraffic::default(), &mut drain, now)
            .await,
        TickOutcome::SkippedHourlyCap
    );
    assert_eq!(queue.depth(), 1);
    assert_eq!(drain.seen, vec!["tt0111161"]);
}

#[test]
fn enqueue_pela_estrutura_respeita_fila_e_dedupe() {
    let store = HarvestStore::open_memory().unwrap();
    let mut queue = HarvestQueue::new(HarvestQueueConfig::default());
    let now = 1_700_000_000_000;

    let first = enqueue_with_dedupe(
        &mut queue,
        &store,
        HarvestRequest::movie("tt0111161", "miss"),
        now,
    );
    assert!(first.accepted);
    assert_eq!(first.reason, adom_harvest::EnqueueReason::Queued);

    // Mesma obra ainda na fila: duplicata, sem gravar outra entrada.
    let duplicate = enqueue_with_dedupe(
        &mut queue,
        &store,
        HarvestRequest::movie("tt0111161", "miss"),
        now,
    );
    assert!(duplicate.accepted);
    assert_eq!(duplicate.reason, adom_harvest::EnqueueReason::Duplicate);
    assert_eq!(queue.depth(), 1);

    // Saiu da fila (drenada): a janela de 12 h barra o reenqueue.
    queue.take_head();
    let dedupe = enqueue_with_dedupe(
        &mut queue,
        &store,
        HarvestRequest::movie("tt0111161", "miss"),
        now,
    );
    assert!(!dedupe.accepted);
    assert_eq!(dedupe.reason, adom_harvest::EnqueueReason::Dedupe);

    // Outra obra passa; IMDb inválido é recusado SEM gravar dedupe.
    let other = enqueue_with_dedupe(
        &mut queue,
        &store,
        HarvestRequest::movie("tt0068646", "miss"),
        now,
    );
    assert_eq!(other.reason, adom_harvest::EnqueueReason::Queued);
    let invalid = enqueue_with_dedupe(
        &mut queue,
        &store,
        HarvestRequest::movie("nao-e-imdb", "miss"),
        now,
    );
    assert_eq!(invalid.reason, adom_harvest::EnqueueReason::Invalid);
}

#[test]
fn corpo_da_rota_vira_pedido_com_os_campos_do_contrato() {
    let body = serde_json::json!({
        "imdbId": "tt0903747",
        "type": "series",
        "season": 5,
        "episode": 14,
        "reason": "next-episode",
        "brProbe": true,
    });
    let request = request_from_body(&body).expect("pedido válido");
    assert_eq!(request.imdb_id, "tt0903747");
    assert_eq!(request.media_type, adom_harvest::HarvestMediaType::Series);
    assert_eq!(request.season, Some(5));
    assert_eq!(request.episode, Some(14));
    assert_eq!(request.reason, "next-episode");
    assert!(request.br_probe);

    // Filme ignora S/E ausentes e o brProbe default é false.
    let movie = request_from_body(&serde_json::json!({
        "imdbId": "tt0111161",
        "type": "movie",
        "reason": "miss",
    }))
    .expect("filme válido");
    assert_eq!(movie.media_type, adom_harvest::HarvestMediaType::Movie);
    assert_eq!(movie.season, None);
    assert!(!movie.br_probe);

    // Tipo fora do enum, IMDb inválido e motivo vazio são `invalid`.
    for bad in [
        serde_json::json!({ "imdbId": "tt0111161", "type": "anime", "reason": "miss" }),
        serde_json::json!({ "imdbId": "0111161", "type": "movie", "reason": "miss" }),
        serde_json::json!({ "imdbId": "tt0111161", "type": "movie", "reason": " " }),
    ] {
        assert!(request_from_body(&bad).is_none(), "deveria recusar {bad}");
    }
}
