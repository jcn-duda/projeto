//! Piso de TTL do registro `pending`: `BR_PROBE_TTL_S` curto não pode apagar
//! o gate de seeds antes do lease de 10 min terminar. O estado final NÃO herda
//! esse piso — ele obedece o env (ver `probe::tests`).

use super::*;

use crate::queue::{HarvestQueue, HarvestQueueConfig};
use crate::store::HarvestStore;

/// Instante fixo: nada aqui depende de relógio real.
const NOW: i64 = 1_700_000_000_000;

fn store() -> HarvestStore {
    HarvestStore::open_memory().expect("store em memória")
}

/// Sonda operante com TTL de 60 s — o menor valor que o env aceita.
fn ttl_curto() -> BrProbe {
    BrProbe::new(ProbeConfig {
        index_only_indexers: vec!["comando".into()],
        pt_br_indexers: vec!["comando".into()],
        ttl_seconds: 60,
        ..ProbeConfig::default()
    })
}

#[test]
fn pending_com_ttl_curto_sobrevive_ao_lease_inteiro() {
    let store = store();
    let probe = ttl_curto();
    let mut queue = HarvestQueue::with_clock(HarvestQueueConfig::default(), || NOW);
    let work = BrProbeWork::movie("tt0111161");

    let result = probe.request(&store, &mut queue, &work, NOW).unwrap();
    assert!(result.probe && result.pending, "sonda aceita na fila");

    let key = probe_key(&work);
    // Faltando 1 s para o lease vencer, o registro ainda existe: sem o piso o
    // KV já teria apagado (60 s) e o gate de seeds cairia em silêncio.
    let vivo = store
        .get_value(&key, NOW + PENDING_LEASE_MS - 1_000)
        .unwrap();
    assert!(vivo.is_some(), "TTL do pending tem que cobrir o lease");
    let record: BrProbeRecord = serde_json::from_str(&vivo.unwrap()).expect("json");
    assert_eq!(record.state, BrProbeState::Pending);

    // No instante do piso (= lease em segundos) expira como qualquer registro.
    assert!(store
        .get_value(&key, NOW + PENDING_LEASE_MS)
        .unwrap()
        .is_none());
}
