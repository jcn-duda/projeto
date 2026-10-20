use super::{
    default_streams_quota, is_streams_key, streams_prefix, StreamsStore, STREAMS_NAMESPACE,
};
use adom_search::{StoreHit, StreamItem, StreamsEntry, SwrStore, STREAM_STALE_GRACE_SECONDS};
use serde_json::json;

fn playable() -> StreamsEntry {
    StreamsEntry {
        streams: vec![StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..StreamItem::default()
        }],
        partial: false,
        debrid_known: Some(true),
        ..Default::default()
    }
}

/// Item já resolvido: perdeu `infoHash` e ficou com a URL relativa do play.
fn resolved(hash: &str, started: f64, finished: f64) -> StreamsEntry {
    StreamsEntry {
        streams: vec![StreamItem {
            name: Some("1080p".into()),
            url: Some(format!("e30/resolve/{hash}?s=1&e=2&sig=deadbeef&w=x")),
            ..StreamItem::default()
        }],
        debrid_known: Some(true),
        trace: Some(
            json!({ "startedAt": started, "finishedAt": finished, "stages": { "final": 1 } }),
        ),
        ..Default::default()
    }
}

fn key(suffix: &str) -> String {
    format!("{}{suffix}", streams_prefix())
}

#[test]
fn prefixo_e_cota_vem_do_core() {
    assert_eq!(streams_prefix(), "streams:v21:");
    assert_eq!(STREAMS_NAMESPACE, "streams");
    assert_eq!(default_streams_quota(), 2_000);
    assert!(is_streams_key(&key("movie:tt1:abc")));
    assert!(!is_streams_key("davail:v1:x"));
}

#[test]
fn get_set_roundtrip_e_get_duro_apaga_expirado() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k = key("a");
    store.set(&k, &playable(), 60, 1_000).unwrap();
    let hit = store.get(&k, 2_000).unwrap().expect("fresco");
    assert_eq!(hit.debrid_known, Some(true));
    assert_eq!(hit.streams.len(), 1);

    // TTL 60s: vence em 61_000. get duro apaga.
    assert!(store.get(&k, 61_001).unwrap().is_none());
    assert_eq!(store.len().unwrap(), 0);
}

#[test]
fn get_with_stale_serve_dentro_da_graca() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k = key("b");
    store.set(&k, &playable(), 60, 1_000).unwrap();

    let fresh = store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 30_000)
        .unwrap()
        .expect("fresco");
    assert!(!fresh.stale);

    let stale = store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 200_000)
        .unwrap()
        .expect("stale");
    assert!(stale.stale);
    assert_eq!(store.len().unwrap(), 1, "stale não apaga");

    // Um ms além da graça: miss + apaga.
    let past = 1_000 + 60_000 + STREAM_STALE_GRACE_SECONDS * 1000 + 1;
    assert!(store
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, past)
        .unwrap()
        .is_none());
    assert_eq!(store.len().unwrap(), 0);
}

#[test]
fn ttl_respeita_decisao_sem_teto_fixo() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k_completa = key("ttl_completa");
    store.set(&k_completa, &playable(), 900, 1_000).unwrap();
    // Lista completa sobrevive além de 60s (ex.: aos 61s e aos 899s ainda serve sem stale com graça 0).
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 61_000)
        .unwrap()
        .is_some());
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 899_000)
        .unwrap()
        .is_some());
    // Após 900s, com graça 0 expira.
    assert!(store
        .get_with_stale(&k_completa, 0, 1_000 + 900_001)
        .unwrap()
        .is_none());

    // Parcial expira em 60s quando gravada com ttl de 60s.
    let k_parcial = key("ttl_parcial");
    let mut parcial = playable();
    parcial.partial = true;
    store.set(&k_parcial, &parcial, 60, 1_000).unwrap();
    assert!(store
        .get_with_stale(&k_parcial, 0, 1_000 + 60_000)
        .unwrap()
        .is_some());
    assert!(store
        .get_with_stale(&k_parcial, 0, 1_000 + 60_001)
        .unwrap()
        .is_none());
}

#[test]
fn recusa_namespace_alheio() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let err = store.set("davail:v1:x", &playable(), 60, 0).unwrap_err();
    assert!(err.contains("fora do namespace"));
}

#[test]
fn cota_apaga_o_que_expira_primeiro() {
    let store = StreamsStore::open_memory_with_quota(2).unwrap();
    store.set(&key("a"), &playable(), 10, 0).unwrap(); // expira 10_000
    store.set(&key("b"), &playable(), 30, 0).unwrap(); // expira 30_000
    store.set(&key("c"), &playable(), 20, 0).unwrap(); // expira 20_000 → empurra a
    assert!(store.get(&key("a"), 0).unwrap().is_none());
    assert!(store.get(&key("b"), 0).unwrap().is_some());
    assert!(store.get(&key("c"), 0).unwrap().is_some());
    assert_eq!(store.len().unwrap(), 2);
}

#[test]
fn swr_store_trait_sobre_sqlite() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let as_trait: &dyn SwrStore = &store;
    let k = key("trait");
    as_trait.set(&k, &playable(), 60, 1_000);
    let hit: StoreHit = as_trait
        .get_with_stale(&k, STREAM_STALE_GRACE_SECONDS, 2_000)
        .expect("hit via trait");
    assert!(!hit.stale);
    assert_eq!(as_trait.len(), 1);
    as_trait.forget(&k);
    assert_eq!(as_trait.len(), 0);
}

#[test]
fn arquivo_temp_abre_e_persiste() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("streams.db");
    {
        let store = StreamsStore::open_with_quota(&path, 10).unwrap();
        store.set(&key("disk"), &playable(), 60, 1_000).unwrap();
        assert_eq!(store.quota(), 10);
    }
    let reopened = StreamsStore::open_with_quota(&path, 10).unwrap();
    let entry = reopened
        .get(&key("disk"), 2_000)
        .unwrap()
        .expect("persistiu");
    assert_eq!(entry.debrid_known, Some(true));
}

// ── F4.4a: invalidação / clear / trace da API administrativa ───────────────

#[test]
fn clear_all_apaga_so_o_namespace() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    store
        .set(&key("movie:tt1:a"), &playable(), 600, 1_000)
        .unwrap();
    store
        .set(&key("series:tt2:1:2:a"), &playable(), 600, 1_000)
        .unwrap();
    assert_eq!(store.clear_all().unwrap(), 2);
    assert_eq!(store.len().unwrap(), 0);
    // Idempotente.
    assert_eq!(store.clear_all().unwrap(), 0);
}

#[test]
fn invalidate_for_obra_pega_a_obra_e_nao_o_vizinho() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let alvo_filme = key("movie:tt123:{\"m\":2}:account:abc");
    let alvo_serie1 = key("series:tt123:1:1:{\"m\":2}:account:abc");
    let alvo_serie2 = key("series:tt123:2:5:{\"m\":4}:account:def");
    let vizinho = key("movie:tt1230:{\"m\":2}:account:abc");
    let outra = key("movie:tt999:{\"m\":2}:account:abc");
    for k in [&alvo_filme, &alvo_serie1, &alvo_serie2, &vizinho, &outra] {
        store.set(k, &playable(), 600, 1_000).unwrap();
    }
    assert_eq!(store.invalidate_for_obra("tt123").unwrap(), 3);
    assert!(store.get(&alvo_filme, 2_000).unwrap().is_none());
    assert!(store.get(&alvo_serie1, 2_000).unwrap().is_none());
    assert!(store.get(&alvo_serie2, 2_000).unwrap().is_none());
    assert!(store.get(&vizinho, 2_000).unwrap().is_some());
    assert!(store.get(&outra, 2_000).unwrap().is_some());
    // Maiúsculas no argumento são normalizadas, como no Node.
    assert_eq!(store.invalidate_for_obra("TT123").unwrap(), 0);
    // Sem formato tt\d+ não varre nada (nem apaga por engano).
    assert!(store.invalidate_for_obra("tt12a").is_err());
}

#[test]
fn invalidate_for_hash_acha_o_hash_dentro_da_url_resolvida() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let outro = "ffffffffffffffffffffffffffffffffffffffff";
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let com_hash = key("movie:tt1:escopo");
    let sem_hash = key("movie:tt2:escopo");
    store
        .set(&com_hash, &resolved(hash, 1.0, 2.0), 600, 1_000)
        .unwrap();
    // Item P2P do MESMO lote com outro hash: não pode sair junto.
    store
        .set(&sem_hash, &resolved(outro, 1.0, 2.0), 600, 1_000)
        .unwrap();
    assert_eq!(store.invalidate_for_hash(hash).unwrap(), 1);
    assert!(store.get(&com_hash, 2_000).unwrap().is_none());
    assert!(store.get(&sem_hash, 2_000).unwrap().is_some());
    assert_eq!(
        store
            .invalidate_for_hash("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .unwrap(),
        0
    );
    assert!(store.invalidate_for_hash("nao-e-hash").is_err());
    // Minúsculas/maiúsculas do MESMO hash encontram a mesma entrada.
    store
        .set(&com_hash, &resolved(hash, 1.0, 2.0), 600, 1_000)
        .unwrap();
    assert_eq!(store.invalidate_for_hash(&hash.to_uppercase()).unwrap(), 1);
    assert!(store.get(&com_hash, 2_000).unwrap().is_none());
}

#[test]
fn clear_by_suffix_mira_a_instalacao() {
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let conta_a = key("movie:tt1:{\"m\":2}:account:aaa");
    let serie_a = key("series:tt2:1:1:{\"m\":2}:account:aaa");
    let conta_b = key("movie:tt1:{\"m\":2}:account:bbb");
    for k in [&conta_a, &serie_a, &conta_b] {
        store.set(k, &playable(), 600, 1_000).unwrap();
    }
    assert_eq!(store.clear_by_suffix(":account:aaa").unwrap(), 2);
    assert!(store.get(&conta_a, 2_000).unwrap().is_none());
    assert!(store.get(&serie_a, 2_000).unwrap().is_none());
    assert!(store.get(&conta_b, 2_000).unwrap().is_some());
    // Sufixo vazio = clear-all (o painel não manda sufixo no escopo global).
    assert_eq!(store.clear_by_suffix("").unwrap(), 1);
    assert_eq!(store.len().unwrap(), 0);
}

#[test]
fn latest_trace_escolhe_o_mais_recente_e_respeita_a_graca() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let antigo = key("movie:tt7:escopoA");
    let novo = key("movie:tt7:escopoB");
    store
        .set(&antigo, &resolved(hash, 1_000.0, 2_000.0), 60, 1_000)
        .unwrap();
    store
        .set(&novo, &resolved(hash, 3_000.0, 4_000.0), 60, 1_000)
        .unwrap();
    let hit = store
        .latest_trace("movie", "tt7", 0, 2_000)
        .unwrap()
        .expect("algum escopo");
    assert_eq!(
        hit.value.trace.as_ref().unwrap()["finishedAt"],
        json!(4_000.0)
    );
    assert!(!hit.stale);
    assert_eq!(hit.remaining_s, 59);
    // Fora da graça as duas somem — inclusive apagando (como o getWithStale).
    let past = 1_000 + 60_000 + STREAM_STALE_GRACE_SECONDS * 1000 + 1;
    assert!(store
        .latest_trace("movie", "tt7", 0, past)
        .unwrap()
        .is_none());
    assert_eq!(store.len().unwrap(), 0);
    // Obra diferente não aparece.
    store
        .set(&key("movie:tt8:x"), &resolved(hash, 1.0, 2.0), 60, 1_000)
        .unwrap();
    assert!(store
        .latest_trace("movie", "tt7", 0, 2_000)
        .unwrap()
        .is_none());
}

#[test]
fn trace_entry_por_chave_exata_devolve_ttl_e_stale() {
    let hash = "0123456789abcdef0123456789abcdef01234567";
    let store = StreamsStore::open_memory_with_quota(10).unwrap();
    let k = key("movie:tt9:escopo");
    store
        .set(&k, &resolved(hash, 1_000.0, 2_000.0), 60, 1_000)
        .unwrap();
    let fresh = store
        .trace_entry(&k, STREAM_STALE_GRACE_SECONDS, 30_000)
        .unwrap()
        .expect("fresco");
    assert!(!fresh.stale);
    // Vence em 61_000 (set em 1_000 com TTL 60): restam 31 s inteiros.
    assert_eq!(fresh.remaining_s, 31);
    let stale = store
        .trace_entry(&k, STREAM_STALE_GRACE_SECONDS, 200_000)
        .unwrap()
        .expect("na graça");
    assert!(stale.stale);
    assert_eq!(stale.remaining_s, 0);
    assert!(store
        .trace_entry(&key("movie:tt0:outra"), STREAM_STALE_GRACE_SECONDS, 2_000)
        .unwrap()
        .is_none());
}
