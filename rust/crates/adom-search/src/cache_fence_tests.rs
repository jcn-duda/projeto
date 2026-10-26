//! T1-C2: a fence do `SwrStore`. O contador por obra nasceu no `StreamsStore`
//! (T1-C1); aqui o MESMO contrato vale para o store em memória — e é dele que
//! saem os testes determinísticos do orquestrador.
//!
//! A regra sob teste: a geração capturada junto da leitura (`get_fenced`) é a
//! única que pode gravar depois (`set_fenced`). Se a obra foi invalidada no
//! meio, a escrita é DESCARTADA — não é erro, é a corrida que a 5H quer fechar.

use super::*;
use serde_json::json;

fn playable() -> StreamsEntry {
    StreamsEntry {
        streams: vec![StreamItem {
            info_hash: Some("0123456789abcdef0123456789abcdef01234567".into()),
            ..StreamItem::default()
        }],
        debrid_known: Some(true),
        ..StreamsEntry::default()
    }
}

/// Chave REAL do cache (prefixo + tipo + id + escopo), não um `"k"` de teste:
/// a obra só é reconhecida nesse formato.
fn key(id: &str) -> String {
    adom_core::streams_cache_key("movie", id, &json!({ "maxResults": 40 }))
}

#[test]
fn fence_da_obra_sobe_na_invalidacao() {
    let store = MemorySwrStore::new();
    let alvo = key("tt1234567");
    assert_eq!(store.fence_for_key(&alvo), Fence::default());

    store.invalidate_for_obra("tt1234567");

    let fence = store.fence_for_key(&alvo);
    assert_eq!(fence.obra, 1, "a invalidação move a geração da obra");
    assert_eq!(fence.epoch, 0, "obra não move o epoch global");
    assert_eq!(
        store.fence_for_key(&key("tt9999999")).obra,
        0,
        "outra obra não pode ser afetada"
    );
}

#[test]
fn escrita_com_fence_velha_e_descartada() {
    let store = MemorySwrStore::new();
    let alvo = key("tt1234567");
    // A busca captura a geração ao começar...
    let fence = store.fence_for_key(&alvo);
    // ...e o operador invalida a obra enquanto ela coleta.
    store.invalidate_for_obra("tt1234567");

    assert!(
        !store.set_fenced(&alvo, &playable(), 60, 1_000, fence),
        "escrita de geração anterior tem que ser recusada"
    );
    assert!(
        store.get_with_stale(&alvo, 0, 1_000).is_none(),
        "nada pode sobrar no cache"
    );
}

#[test]
fn escrita_com_a_fence_da_leitura_grava_e_serve() {
    let store = MemorySwrStore::new();
    let alvo = key("tt1234567");
    // Miss também devolve a fence do instante: é ela que autoriza o commit.
    let (hit, fence) = store.get_fenced(&alvo, 0, 1_000);
    assert!(hit.is_none());

    assert!(store.set_fenced(&alvo, &playable(), 60, 1_000, fence));
    let (hit, fence_depois) = store.get_fenced(&alvo, 0, 1_000);
    assert!(hit.is_some_and(|h| !h.stale), "a lista gravada é servida");
    assert_eq!(fence_depois, fence, "gravar não move geração");
}

#[test]
fn limpar_tudo_invalida_qualquer_fence_anterior() {
    let store = MemorySwrStore::new();
    let alvo = key("tt1234567");
    store.set(&alvo, &playable(), 60, 1_000);
    let fence = store.fence_for_key(&alvo);

    store.clear_all();

    assert_eq!(store.len(), 0, "clear_all esvazia o namespace");
    assert!(
        !store.set_fenced(&alvo, &playable(), 60, 1_000, fence),
        "fence anterior ao clear_all não grava"
    );
    assert_eq!(store.fence_for_key(&alvo).epoch, 1);
}

#[test]
fn invalidacao_apaga_as_listas_da_obra() {
    let store = MemorySwrStore::new();
    let alvo = key("tt1234567");
    let outra = key("tt9999999");
    store.set(&alvo, &playable(), 60, 1_000);
    store.set(&outra, &playable(), 60, 1_000);

    store.invalidate_for_obra("tt1234567");

    assert!(store.get_with_stale(&alvo, 0, 1_000).is_none());
    assert!(
        store.get_with_stale(&outra, 0, 1_000).is_some(),
        "a lista de outra obra não é da conta"
    );
}

#[test]
fn chave_sem_obra_nao_quebra_a_fence() {
    // Módulo com chave fora do formato (`"k"`, como nos testes de SWR): sem
    // obra, a geração é a global — e continua valendo enquanto o epoch não anda.
    let store = MemorySwrStore::new();
    let fence = store.fence_for_key("k");
    assert!(store.set_fenced("k", &playable(), 60, 1_000, fence));
    store.clear_all();
    assert!(!store.set_fenced("k", &playable(), 60, 1_000, fence));
}
