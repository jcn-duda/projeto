use adom_search::StreamsEntry;

use super::{Fence, StreamsStore};

fn entry() -> StreamsEntry {
    StreamsEntry::default()
}

fn key(suffix: &str) -> String {
    format!("streams:v21:{suffix}")
}

#[test]
fn invalidar_incrementa_a_geracao_da_obra() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:scope");
    store.set(&k, &entry(), 600, 1_000).unwrap();
    let antes = store.fence_for_key(&k).unwrap();
    assert_eq!(antes.obra, 0, "obra nunca invalidada começa em zero");
    assert_eq!(store.invalidate_for_obra("tt1").unwrap(), 1);
    let depois = store.fence_for_key(&k).unwrap();
    assert!(depois.obra > antes.obra, "{depois:?} > {antes:?}");
}

#[test]
fn escrita_com_fence_velha_e_descartada() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:scope");
    let velha = store.fence_for_key(&k).unwrap();
    store.invalidate_for_obra("tt1").unwrap();
    assert!(!store.set_fenced(&k, &entry(), 600, 1_000, &velha).unwrap());
    assert!(store.get(&k, 1_001).unwrap().is_none());
}

#[test]
fn escrita_com_fence_nova_e_aceita() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:scope");
    store.invalidate_for_obra("tt1").unwrap();
    let nova = store.fence_for_key(&k).unwrap();
    assert!(store.set_fenced(&k, &entry(), 600, 1_000, &nova).unwrap());
    assert!(store.get(&k, 1_001).unwrap().is_some());
}

#[test]
fn clear_all_incrementa_o_epoch_e_invalida_tudo() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:scope");
    store.set(&k, &entry(), 600, 1_000).unwrap();
    let velha = store.fence_for_key(&k).unwrap();
    assert_eq!(store.clear_all().unwrap(), 1);
    let nova = store.fence_for_key(&k).unwrap();
    assert!(nova.epoch > velha.epoch, "{nova:?} > {velha:?}");
    assert!(!store.set_fenced(&k, &entry(), 600, 1_000, &velha).unwrap());
    assert!(store.get(&k, 1_001).unwrap().is_none());
}

#[test]
fn clear_por_sufixo_incrementa_o_epoch() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:x:account:a");
    store.set(&k, &entry(), 600, 1_000).unwrap();
    let velha = store.fence_for_key(&k).unwrap();
    assert_eq!(store.clear_by_suffix(":account:a").unwrap(), 1);
    let nova = store.fence_for_key(&k).unwrap();
    assert!(nova.epoch > velha.epoch);
    assert!(!store.set_fenced(&k, &entry(), 600, 1_000, &velha).unwrap());
}

#[test]
fn invalidar_por_hash_incrementa_o_epoch() {
    let store = StreamsStore::open_memory().unwrap();
    let k = key("movie:tt1:x");
    let velha = store.fence_for_key(&k).unwrap();
    store.invalidate_for_hash(&"a".repeat(40)).unwrap();
    let nova = store.fence_for_key(&k).unwrap();
    assert!(nova.epoch > velha.epoch);
}

#[test]
fn movie_e_series_da_mesma_obra_tem_geracoes_distintas() {
    let store = StreamsStore::open_memory().unwrap();
    let filme = key("movie:tt1:x");
    let serie = key("series:tt1:x");
    store.set(&filme, &entry(), 600, 1_000).unwrap();
    store.set(&serie, &entry(), 600, 1_000).unwrap();
    store.invalidate_for_obra("tt1").unwrap();
    // A invalidação apaga as duas e ANDA as duas: escopos diferentes da mesma
    // obra compartilham o contador de obra, mas o tipo não.
    assert_eq!(store.fence_for_key(&filme).unwrap().obra, 1);
    assert_eq!(store.fence_for_key(&serie).unwrap().obra, 1);
    let outra = key("movie:tt2:x");
    assert_eq!(store.fence_for_key(&outra).unwrap().obra, 0);
}

#[test]
fn chave_fora_do_formato_nao_quebra() {
    let store = StreamsStore::open_memory().unwrap();
    assert_eq!(
        store.fence_for_key("davail:v1:x").unwrap(),
        Fence::default()
    );
    // A fence de uma chave fora do formato nunca avança; a escrita segue a
    // mesma regra do `set` (namespace errado é erro, não silêncio).
    let err = store
        .set_fenced("davail:v1:x", &entry(), 600, 1_000, &Fence::default())
        .expect_err("namespace errado");
    assert!(err.contains("namespace streams"), "{err}");
}
