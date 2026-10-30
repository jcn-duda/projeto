//! Régua nativa dos fatos da limpeza AllDebrid: cobertura do lote, holds do
//! KV (`adhold`/`adprot`), inventário entregue e o `held` do play. Tudo com KV
//! em memória; nenhum teste toca o `data/cache.db`.

use std::collections::HashSet;
use std::sync::Arc;

use adom_debrid::alldebrid_cleanup::{account_scope, adhold_key, adprot_key};
use adom_debrid::HttpClient;
use adom_index::NativeKv;
use adom_search::HoldsFeed;
use serde_json::json;

use super::*;

const KEY: &str = "chave-da-conta-de-teste";
const OUTRA_KEY: &str = "chave-de-outra-conta";
const HASH: &str = "0123456789abcdef0123456789abcdef01234567";
const OUTRO: &str = "fedcba9876543210fedcba9876543210fedcba98";
const NOW: i64 = 1_000_000;

fn kv() -> NativeKv {
    NativeKv::open_memory().expect("kv em memória")
}

/// Registro vivo por `ttl_s` segundos a partir de `NOW`.
fn put(kv: &NativeKv, key: &str, ttl_s: i64) {
    kv.put_json(key, &json!({ "at": NOW }), ttl_s, NOW)
        .expect("gravar registro");
}

fn hashes(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| item.to_string()).collect()
}

fn input<'a>(
    kv: Option<&'a NativeKv>,
    lote: &'a [String],
    inventory: Option<HashSet<String>>,
    protect_br: bool,
) -> FactsInput<'a> {
    FactsInput {
        api_key: KEY,
        hashes: lote,
        inventory: inventory.map(Arc::new),
        kv,
        protect_br,
        drop_ready: true,
        drop_uncached: true,
        now_ms: NOW,
    }
}

#[test]
fn sem_kv_nao_prova_cobertura_e_nao_segura_nada() {
    let lote = hashes(&[HASH]);
    let facts = build_facts(&input(None, &lote, None, true));
    assert!(!facts.holds_complete, "sem KV não há prova do hold");
    assert!(facts.held.is_empty());
    assert!(facts.evaluated.is_empty());
    assert!(
        !facts.covers(&lote),
        "sem prova o seam não autoriza limpeza"
    );
}

#[test]
fn lote_sem_holds_fica_completo_e_cobre_o_lote() {
    let kv = kv();
    let lote = hashes(&[HASH, OUTRO]);
    let facts = build_facts(&input(Some(&kv), &lote, None, true));
    assert!(facts.holds_complete);
    assert!(facts.held.is_empty());
    assert_eq!(facts.evaluated, vec![HASH.to_string(), OUTRO.to_string()]);
    assert_eq!(facts.account, account_scope(KEY));
    assert!(facts.covers(&lote));
}

#[test]
fn adhold_vivo_protege_o_hash_e_a_prova_continua_completa() {
    let kv = kv();
    put(&kv, &adhold_key(&account_scope(KEY), HASH), 60);
    let lote = hashes(&[HASH, OUTRO]);
    let facts = build_facts(&input(Some(&kv), &lote, None, false));
    assert_eq!(facts.held, vec![HASH.to_string()]);
    assert!(facts.holds_complete);
}

#[test]
fn adprot_so_protege_com_a_flag_ligada() {
    let kv = kv();
    put(&kv, &adprot_key(&account_scope(KEY), HASH), 60);
    let lote = hashes(&[HASH]);
    let desligada = build_facts(&input(Some(&kv), &lote, None, false));
    assert!(
        desligada.held.is_empty(),
        "adprot ignorado com a flag desligada"
    );
    let ligada = build_facts(&input(Some(&kv), &lote, None, true));
    assert_eq!(ligada.held, vec![HASH.to_string()]);
}

#[test]
fn registro_vencido_nao_protege() {
    let kv = kv();
    // TTL de 1 s gravado em NOW; a leitura é 5 s depois.
    put(&kv, &adhold_key(&account_scope(KEY), HASH), 1);
    let lote = hashes(&[HASH]);
    let mut tarde = input(Some(&kv), &lote, None, true);
    tarde.now_ms = NOW + 5_000;
    let facts = build_facts(&tarde);
    assert!(facts.held.is_empty(), "hold vencido não protege");
    assert!(facts.holds_complete);
}

#[test]
fn hash_vazio_derruba_a_cobertura_do_lote() {
    let kv = kv();
    let lote = hashes(&["", HASH]);
    let facts = build_facts(&input(Some(&kv), &lote, None, true));
    assert!(!facts.holds_complete, "hash ilegível não é avaliado");
    assert_eq!(facts.evaluated, vec![HASH.to_string()]);
    assert!(!facts.covers(&lote));
}

#[test]
fn lote_vazio_e_conta_vazia_nao_provam_nada() {
    let kv = kv();
    let vazio: Vec<String> = Vec::new();
    let sem_lote = build_facts(&input(Some(&kv), &vazio, None, true));
    assert!(!sem_lote.holds_complete);

    let lote = hashes(&[HASH]);
    let mut sem_conta = input(Some(&kv), &lote, None, true);
    sem_conta.api_key = "";
    let facts = build_facts(&sem_conta);
    assert!(!facts.holds_complete);
    assert!(facts.account.is_empty());
    assert!(!facts.inventory_loaded);
}

#[test]
fn inventario_entra_como_known_before_ou_nao_carregado() {
    let kv = kv();
    let lote = hashes(&[HASH]);
    let carregado = build_facts(&input(
        Some(&kv),
        &lote,
        Some(HashSet::from([OUTRO.to_string()])),
        true,
    ));
    assert!(carregado.inventory_loaded);
    assert_eq!(carregado.known_before, vec![OUTRO.to_string()]);

    let ausente = build_facts(&input(Some(&kv), &lote, None, true));
    assert!(!ausente.inventory_loaded);
    assert!(ausente.known_before.is_empty());
}

#[test]
fn flags_de_drop_saem_no_fato() {
    let kv = kv();
    let lote = hashes(&[HASH]);
    let mut entrada = input(Some(&kv), &lote, None, true);
    entrada.drop_ready = false;
    entrada.drop_uncached = true;
    let facts = build_facts(&entrada);
    assert_eq!(facts.drop_ready, Some(false));
    assert_eq!(facts.drop_uncached, Some(true));
}

#[test]
fn flag_de_ambiente_so_liga_com_o_literal_true() {
    assert!(literal_true(None), "ausente liga");
    assert!(literal_true(Some("")), "vazio liga");
    assert!(literal_true(Some("true")));
    assert!(!literal_true(Some("false")));
    assert!(!literal_true(Some("1")), "1 não é o literal do Node");
    assert!(!literal_true(Some("TRUE")));
}

#[test]
fn play_held_sem_chave_ou_sem_kv_nao_apaga() {
    let kv = kv();
    assert!(
        play_held_with(None, KEY, HASH, true, NOW),
        "sem KV: frio fica"
    );
    assert!(
        play_held_with(Some(&kv), "", HASH, true, NOW),
        "sem chave: frio fica"
    );
}

#[test]
fn play_held_sem_registro_libera_a_limpeza() {
    let kv = kv();
    assert!(!play_held_with(Some(&kv), KEY, HASH, true, NOW));
}

#[test]
fn play_held_respeita_adhold_e_adprot_com_flag() {
    let kv = kv();
    put(&kv, &adprot_key(&account_scope(KEY), HASH), 60);
    assert!(
        !play_held_with(Some(&kv), KEY, HASH, false, NOW),
        "adprot sem flag não protege"
    );
    assert!(
        play_held_with(Some(&kv), KEY, HASH, true, NOW),
        "adprot com flag protege"
    );

    let kv2 = self::kv();
    put(&kv2, &adhold_key(&account_scope(KEY), HASH), 60);
    assert!(
        play_held_with(Some(&kv2), KEY, HASH, false, NOW),
        "adhold protege sempre"
    );
}

#[test]
fn play_held_nao_vaza_entre_contas() {
    let kv = kv();
    put(&kv, &adhold_key(&account_scope(OUTRA_KEY), HASH), 60);
    assert!(
        !play_held_with(Some(&kv), KEY, HASH, true, NOW),
        "hold de outra conta não vale"
    );
}

#[test]
fn feed_nativo_recusa_outro_servico() {
    let feed = NativeHoldsFeed::new(HttpClient::new().expect("http"));
    let lote = hashes(&[HASH]);
    assert!(feed.facts(KEY, "torbox", &lote).is_err());
}
