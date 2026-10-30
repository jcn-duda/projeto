use std::sync::Arc;
use std::time::Duration;

use adom_harvest::HarvestStore;
use serde_json::{json, Map, Value};

use super::{offer, HarvestOffer, HarvestSlot};
use crate::harvest::{persist_inner, HarvestHandle};

fn payload(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("objeto")
}

fn bound_slot() -> (HarvestSlot, HarvestHandle) {
    let store = Arc::new(HarvestStore::open_memory().unwrap());
    let handle = HarvestHandle {
        inner: persist_inner(store),
    };
    let slot: HarvestSlot = Default::default();
    assert!(slot.set(handle.clone()).is_ok());
    (slot, handle)
}

#[test]
fn slot_vazio_segue_ao_node() {
    let slot: HarvestSlot = Default::default();
    let out = offer(
        &slot,
        &payload(json!({"imdbId": "tt0944947", "type": "series", "reason": "miss"})),
    );
    assert_eq!(out, HarvestOffer::Unbound);
}

#[tokio::test]
async fn payload_sem_tipo_ou_motivo_e_rejeitado() {
    let (slot, _) = bound_slot();
    for bad in [
        json!({"imdbId": "tt0944947", "reason": "miss"}),
        json!({"imdbId": "tt0944947", "type": "series"}),
        json!({"imdbId": "abc", "type": "movie", "reason": "miss"}),
    ] {
        assert_eq!(offer(&slot, &payload(bad)), HarvestOffer::Invalid);
    }
}

#[tokio::test]
async fn pedido_valido_entra_na_fila_do_colhedor() {
    let (slot, handle) = bound_slot();
    let out = offer(
        &slot,
        &payload(json!({
            "imdbId": "tt0944947", "type": "series", "season": 1, "episode": 2,
            "reason": "next-episode"
        })),
    );
    assert_eq!(out, HarvestOffer::Spawned);
    // O enfileiramento roda em fundo: espera a task assentar na fila.
    let mut depth = 0;
    for _ in 0..50 {
        depth = handle.inner.queue.lock().await.depth();
        if depth > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(depth, 1);
    let queue = handle.inner.queue.lock().await;
    let entry = &queue.entries()[0];
    assert_eq!(entry.imdb_id, "tt0944947");
    assert_eq!(entry.season, Some(1));
    assert_eq!(entry.episode, Some(2));
}
