//! Testes do cache/retry/refresh do catálogo — SEM rede: o fetcher é o duplo
//! `FakeFetch` e o relógio entra por parâmetro (`publish`/`needs_refresh`).

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use super::{payload_for, ttl_ms_from, with_virtual, CatalogFetch, CatalogHub};
use adom_sources::jackett::{CatalogCard, CatalogSnapshot, CatalogSource};

/// Duplo do fetcher: devolve o próximo snapshot da fila, sem rede. Fila vazia
/// devolve fallback vazio — nenhum teste precisa de refresh infinito.
pub(super) struct FakeFetch {
    queue: Mutex<Vec<CatalogSnapshot>>,
    calls: Mutex<usize>,
}

impl FakeFetch {
    pub(super) fn new(queue: Vec<CatalogSnapshot>) -> Self {
        Self {
            queue: Mutex::new(queue),
            calls: Mutex::new(0),
        }
    }

    pub(super) fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
    }
}

impl CatalogFetch for FakeFetch {
    fn fetch(&self) -> Pin<Box<dyn Future<Output = CatalogSnapshot> + Send + '_>> {
        Box::pin(async move {
            *self.calls.lock().unwrap() += 1;
            let mut queue = self.queue.lock().unwrap();
            if queue.is_empty() {
                CatalogSnapshot {
                    cards: Vec::new(),
                    source: CatalogSource::Fallback,
                }
            } else {
                queue.remove(0)
            }
        })
    }
}

pub(super) fn card(id: &str) -> CatalogCard {
    CatalogCard {
        id: id.to_string(),
        label: id.to_string(),
        language: "pt-BR".to_string(),
        is_br: true,
    }
}

pub(super) fn snapshot(source: CatalogSource, ids: &[&str]) -> CatalogSnapshot {
    CatalogSnapshot {
        cards: ids.iter().map(|id| card(id)).collect(),
        source,
    }
}

fn hub(fetch: FakeFetch, ttl_ms: u64, has_key: bool) -> CatalogHub {
    CatalogHub::new(
        Arc::new(fetch),
        snapshot(CatalogSource::Fallback, &["env-a"]),
        ttl_ms,
        has_key,
        true,
    )
}

#[test]
fn ttl_efetivo_espelha_o_cache_ttl_do_ts() {
    let h = hub(FakeFetch::new(vec![]), 900_000, true);
    // Fallback com chave: a vida do fallback é curta de propósito (30 s).
    assert_eq!(h.ttl_effective(CatalogSource::Fallback), 30_000);
    assert_eq!(h.ttl_effective(CatalogSource::Live), 900_000);
    // Sem chave não há o que refrescar: o TTL cheio manda.
    let sem_chave = hub(FakeFetch::new(vec![]), 900_000, false);
    assert_eq!(sem_chave.ttl_effective(CatalogSource::Fallback), 900_000);
}

#[test]
fn memo_do_load_respeita_o_ttl_efetivo() {
    let h = hub(FakeFetch::new(vec![]), 900_000, true);
    assert!(h.needs_refresh(1_000), "sem publicação refresca");
    h.publish(snapshot(CatalogSource::Fallback, &["a"]), 1_000);
    assert!(
        !h.needs_refresh(1_000 + 29_999),
        "29,999 s dentro dos 30 s do fallback com chave"
    );
    assert!(h.needs_refresh(1_000 + 30_000), "30 s completa: refresca");
    h.publish(snapshot(CatalogSource::Live, &["a"]), 5_000);
    assert!(!h.needs_refresh(5_000 + 899_999), "vivo vale o TTL cheio");
    assert!(h.needs_refresh(5_000 + 900_000));
}

#[test]
fn next_wait_retry_30s_no_fallback_e_piso_60s_no_vivo() {
    let h = hub(FakeFetch::new(vec![]), 900_000, true);
    assert_eq!(h.next_wait_ms(CatalogSource::Fallback), 30_000);
    assert_eq!(h.next_wait_ms(CatalogSource::Live), 900_000);
    // TTL menor que o piso: o vivo espera 60 s, não o TTL.
    let ttl_curto = hub(FakeFetch::new(vec![]), 10_000, true);
    assert_eq!(ttl_curto.next_wait_ms(CatalogSource::Live), 60_000);
}

#[tokio::test]
async fn tick_publica_e_devolve_a_procedencia() {
    let h = hub(
        FakeFetch::new(vec![
            snapshot(CatalogSource::Fallback, &["a"]),
            snapshot(CatalogSource::Live, &["a", "b"]),
        ]),
        900_000,
        true,
    );
    let (live, wait) = h.tick().await;
    assert!(!live);
    assert_eq!(wait, 30_000, "fallback manda tentar de novo em 30 s");
    assert_eq!(h.current().source, CatalogSource::Fallback);
    // Envelhece a publicação (relógio real do tick): o memo de 30 s do
    // fallback completa e o próximo tick refresca de verdade.
    h.publish(h.current(), 1_000);
    let (live, wait) = h.tick().await;
    assert!(live);
    assert_eq!(wait, 900_000, "vivo passa a valer o TTL");
    assert_eq!(h.current().source, CatalogSource::Live);
    assert_eq!(h.current().cards.len(), 2);
}

#[tokio::test]
async fn sem_chave_nao_consulta_nem_refresca() {
    let fetch = Arc::new(FakeFetch::new(vec![snapshot(CatalogSource::Live, &["a"])]));
    let h = CatalogHub::new(
        fetch.clone(),
        snapshot(CatalogSource::Fallback, &["env-a"]),
        900_000,
        false,
        true,
    );
    let (live, wait) = h.tick().await;
    assert!(!live);
    assert_eq!(wait, 900_000);
    assert_eq!(fetch.calls(), 0, "sem chave o fetcher não é tocado");
    assert_eq!(h.current().source, CatalogSource::Fallback);
    assert_eq!(
        h.current().cards[0].id,
        "env-a",
        "o fallback do .env nasce com o hub"
    );
}

#[test]
fn mico_entra_virtual_no_fim_e_sem_duplicar() {
    let cards = vec![card("a"), card("b")];
    let out = with_virtual(&cards, true);
    assert_eq!(out.len(), 3);
    let mico = out.last().unwrap();
    assert_eq!(mico["id"], "mico");
    assert_eq!(mico["virtual"], true);
    assert_eq!(mico["label"], "Mico Leão Dublado");
    assert_eq!(mico["isBr"], true);
    assert_eq!(mico["language"], "pt-BR");
    // Cards da coleta não carregam o campo: o `virtual` é do Mico.
    assert!(out[0].get("virtual").is_none());
    // Catálogo que já tem "mico" (improvável, mas o TS guarda o mesmo id).
    let com_mico = vec![card("a"), card("mico")];
    assert_eq!(with_virtual(&com_mico, true).len(), 2);
    // Kill-switch desligado: nada entra.
    assert_eq!(with_virtual(&cards, false).len(), 2);
}

#[test]
fn ttl_ms_da_env_segundos_e_default_no_invalido() {
    assert_eq!(ttl_ms_from(None), 900_000);
    assert_eq!(ttl_ms_from(Some("30")), 30_000);
    assert_eq!(ttl_ms_from(Some(" 60 ")), 60_000);
    assert_eq!(ttl_ms_from(Some("abc")), 900_000);
    assert_eq!(ttl_ms_from(Some("")), 900_000);
}

#[test]
fn payload_da_rota_camel_case_com_source_e_mico() {
    // Antes do primeiro tick: fallback do .env + mico virtual.
    let h = Arc::new(CatalogHub::new(
        Arc::new(FakeFetch::new(vec![])),
        snapshot(CatalogSource::Fallback, &["env-a"]),
        900_000,
        true,
        true,
    ));
    let before = payload_for(Some(&h));
    assert_eq!(before["ok"], true);
    assert_eq!(before["source"], "fallback");
    assert_eq!(before["cards"].as_array().unwrap().len(), 2);
    // Sem hub instalado: vazio com fallback — nunca inventa medição.
    let none = payload_for(None);
    assert_eq!(none["cards"].as_array().unwrap().len(), 0);
    assert_eq!(none["source"], "fallback");
}
