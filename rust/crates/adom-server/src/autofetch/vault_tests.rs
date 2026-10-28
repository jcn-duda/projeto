//! Testes do cofre em RAM: TTL, LRU, escopo por conta e — o mais importante —
//! a chave NUNCA em `Debug` nem no status do painel.

use std::sync::Arc;

use adom_index::NativeKv;
use adom_sources::now_ms;
use serde_json::json;

use super::super::worker::AutofetchHandle;
use super::super::Policy;
use super::Vault;

const KEY: &str = "chave-secreta-do-usuario-42";

/// Segmento `encoded` de busca com a chave crua (texto puro, como o install
/// URL antigo): o mesmo caminho do `/resolve` aceita sem selo. Dentro do
/// segmento as chaves são as CURTAS do `SCHEMA` (`ds`/`dk`).
fn encoded_config(service: &str, api_key: &str) -> String {
    adom_core::encode_config(&json!({ "ds": service, "dk": api_key }))
}

#[test]
fn escopo_e_adapter_mais_digest_da_conta() {
    let scope = Vault::scope_of("AllDebrid", KEY).unwrap();
    let digest = adom_core::account_scope(&json!(KEY));
    assert_eq!(scope, format!("alldebrid:{digest}"));
    // Serviço ou chave vazios não entram no cofre.
    assert!(Vault::scope_of("", KEY).is_none());
    assert!(Vault::scope_of("alldebrid", "").is_none());
}

#[test]
fn chave_vence_com_o_ttl_e_o_sweep_poda() {
    let vault = Vault::new(1_000, 4, "");
    let start = now_ms();
    let scope = vault.put("alldebrid", KEY, start).unwrap();
    assert_eq!(vault.key(&scope, start + 999).as_deref(), Some(KEY));
    // Vencida: sai na leitura, sem depender do sweep.
    assert!(vault.key(&scope, start + 1_000).is_none());
    assert_eq!(vault.len(), 0);

    assert!(vault.put("alldebrid", KEY, start).is_some());
    assert_eq!(vault.sweep(start + 2_000), 1);
    assert_eq!(vault.sweep(start + 2_000), 0);
}

#[test]
fn lru_derruba_o_mais_antigo_em_uso_e_preserva_o_recente() {
    let vault = Vault::new(60_000, 2, "");
    let now = now_ms();
    let a = vault.put("alldebrid", "chave-a", now).unwrap();
    let b = vault.put("realdebrid", "chave-b", now).unwrap();
    // Uso toca o LRU: `a` passa a ser o mais recente.
    assert!(vault.key(&a, now).is_some());
    let c = vault.put("torbox", "chave-c", now).unwrap();
    assert_eq!(vault.len(), 2);
    assert!(vault.key(&a, now).is_some(), "o mais usado fica");
    assert!(vault.key(&c, now).is_some(), "o recém-inserido fica");
    assert!(vault.key(&b, now).is_none(), "o LRU levou o mais antigo");
}

#[test]
fn forget_derruba_so_o_escopo_pedido() {
    let vault = Vault::new(60_000, 4, "");
    let now = now_ms();
    let a = vault.put("alldebrid", "chave-a", now).unwrap();
    let b = vault.put("realdebrid", "chave-b", now).unwrap();
    assert!(vault.forget(&a));
    assert!(vault.key(&a, now).is_none());
    assert!(vault.key(&b, now).is_some());
    assert!(!vault.forget(&a), "esquecer duas vezes não inventa conta");
}

#[test]
fn ingest_le_o_mesmo_segmento_da_busca() {
    let vault = Vault::new(60_000, 4, "");
    let now = now_ms();
    let scope = vault
        .ingest(&encoded_config("alldebrid", KEY), now)
        .expect("segmento válido ensina a conta ao cofre");
    assert_eq!(vault.key(&scope, now).as_deref(), Some(KEY));
    // Segmento que não é config, serviço fora do vocabulário e vazio: nada.
    assert!(vault.ingest("nao-e-um-segmento-de-config", now).is_none());
    assert!(vault
        .ingest(&encoded_config("servico-inexistente", KEY), now)
        .is_none());
    assert!(vault.ingest("", now).is_none());
    assert_eq!(vault.len(), 1);
}

/// OBRIGATÓRIO: nem `Debug` nem o JSON do painel carregam a chave.
#[test]
fn debug_e_status_nao_vazam_a_chave() {
    let vault = Arc::new(Vault::new(60_000, 4, ""));
    let now = now_ms();
    let kv = Arc::new(NativeKv::open_memory().unwrap());
    assert!(vault
        .ingest(&encoded_config("alldebrid", KEY), now)
        .is_some());

    let debug = format!("{vault:?}");
    assert!(!debug.contains(KEY), "{debug}");
    assert!(!debug.contains("chave-secreta"), "{debug}");
    // Contagem redigida: o painel sabe QUANTAS contas, não quais.
    assert!(debug.contains("contas: 1"), "{debug}");

    let handle = AutofetchHandle::build(kv, &Policy::fixture(), Some(vault.clone()), None);
    let status = handle.status();
    assert_eq!(status.vault_accounts, 1);
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains(KEY), "{json}");
    assert!(!json.contains("chave-secreta"), "{json}");
    assert!(!format!("{status:?}").contains(KEY));
}
