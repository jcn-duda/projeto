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

/// A chave tem de sobreviver ao horizonte do lote: o passo `Expired` roda na
/// primeira passagem de settle DEPOIS do horizonte e precisa da credencial.
#[test]
fn chave_do_cofre_sobrevive_ao_horizonte_do_lote() {
    let policy = Policy::fixture();
    let ttl = super::vault_ttl_ms(&policy);
    assert!(
        ttl >= policy.settle_horizon_ms + policy.settle_interval_ms,
        "cofre {ttl} ms x horizonte {} + settle {}",
        policy.settle_horizon_ms,
        policy.settle_interval_ms
    );
}

// --- Cópia selada (sobrevive a restart) ---------------------------------

const SECRET: &str = "segredo-do-operador";

fn temp_kv() -> (tempfile::TempDir, Arc<NativeKv>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let kv = Arc::new(NativeKv::open(&dir.path().join("cache.db")).expect("cache.db"));
    (dir, kv)
}

#[test]
fn restart_restaura_a_conta_com_o_mesmo_vencimento() {
    let (_dir, kv) = temp_kv();
    let now = now_ms();
    let antes = Vault::new(60_000, 4, SECRET);
    antes.attach_store(Arc::clone(&kv), now);
    let scope = antes.put("alldebrid", KEY, now).unwrap();

    // A linha do KV é o selo, nunca a chave aberta.
    let linha = kv
        .get_json(&super::vault_store::key_for(&scope), now)
        .unwrap()
        .expect("cópia selada gravada");
    let texto = linha.to_string();
    assert!(!texto.contains(KEY), "chave aberta no KV: {texto}");
    assert!(texto.contains("enc.v1."));

    let depois = Vault::new(60_000, 4, SECRET);
    assert_eq!(depois.attach_store(Arc::clone(&kv), now + 1_000), 1);
    assert_eq!(depois.key(&scope, now + 59_999).as_deref(), Some(KEY));
    // Restaurar não estende o prazo original.
    assert!(depois.key(&scope, now + 60_000).is_none());
}

#[test]
fn sem_resolve_secret_nada_vai_ao_kv() {
    let (_dir, kv) = temp_kv();
    let now = now_ms();
    let vault = Vault::new(60_000, 4, "");
    vault.attach_store(Arc::clone(&kv), now);
    let scope = vault.put("alldebrid", KEY, now).unwrap();
    assert!(kv
        .get_json(&super::vault_store::key_for(&scope), now)
        .unwrap()
        .is_none());
    assert!(kv.keys_matching(super::vault_store::PREFIX, now).unwrap().is_empty());
}

#[test]
fn segredo_trocado_apaga_a_copia_e_nao_restaura() {
    let (_dir, kv) = temp_kv();
    let now = now_ms();
    let antes = Vault::new(60_000, 4, SECRET);
    antes.attach_store(Arc::clone(&kv), now);
    antes.put("alldebrid", KEY, now).unwrap();

    let outro = Vault::new(60_000, 4, "outro-segredo");
    assert_eq!(outro.attach_store(Arc::clone(&kv), now), 0);
    assert_eq!(outro.len(), 0);
    assert!(kv.keys_matching(super::vault_store::PREFIX, now).unwrap().is_empty());
}

#[test]
fn forget_apaga_a_copia_selada() {
    let (_dir, kv) = temp_kv();
    let now = now_ms();
    let vault = Vault::new(60_000, 4, SECRET);
    vault.attach_store(Arc::clone(&kv), now);
    let scope = vault.put("alldebrid", KEY, now).unwrap();
    assert!(vault.forget(&scope));
    let depois = Vault::new(60_000, 4, SECRET);
    assert_eq!(depois.attach_store(Arc::clone(&kv), now), 0);
}

#[test]
fn busca_repetida_nao_regrava_antes_do_intervalo() {
    let (_dir, kv) = temp_kv();
    let now = now_ms();
    let ttl = 6 * 60 * 60 * 1000;
    let vault = Vault::new(ttl, 4, SECRET);
    vault.attach_store(Arc::clone(&kv), now);
    let scope = vault.put("alldebrid", KEY, now).unwrap();
    let key = super::vault_store::key_for(&scope);
    let exp_de = |kv: &NativeKv| {
        kv.get_json(&key, now).unwrap().unwrap()["exp"].as_i64().unwrap()
    };
    let primeiro = exp_de(&kv);
    vault.put("alldebrid", KEY, now + 60_000).unwrap();
    assert_eq!(exp_de(&kv), primeiro, "1 min depois não regrava");
    vault.put("alldebrid", KEY, now + super::vault_store::REFRESH_MS).unwrap();
    assert_eq!(exp_de(&kv), primeiro + super::vault_store::REFRESH_MS);
}
