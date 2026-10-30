//! Parte 2 dos testes da costura: feed de holds (`DEBRID_AL_HOLDS`) e
//! limpeza da conta AllDebrid. Corte mecânico, nenhum teste mudou.

use adom_debrid::alldebrid_cleanup::account_scope;
use adom_debrid::holds_feed::HoldsFacts;

use super::{native_stub, service, stream, HIT, MISS};
use crate::debrid_seam::{AdapterDebridCheck, HoldsFeed};
use crate::list_builder::{DebridAnswer, DebridCheck};

// ── Feed de holds (`DEBRID_AL_HOLDS`) ──────────────────────────────────────

const USER_KEY: &str = "chave-do-usuario";

/// Env com a trava única do crate; restaura no drop.
struct FeedEnv {
    prev: Vec<(&'static str, Option<String>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl FeedEnv {
    fn set(pairs: &[(&'static str, Option<&str>)]) -> Self {
        let lock = crate::test_env::lock();
        let mut prev = Vec::new();
        for (name, value) in pairs {
            prev.push((*name, std::env::var(name).ok()));
            unsafe {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
        Self { prev, _lock: lock }
    }
}

impl Drop for FeedEnv {
    fn drop(&mut self) {
        unsafe {
            for (name, value) in &self.prev {
                match value {
                    Some(raw) => std::env::set_var(name, raw),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
}

fn holds_facts(account: &str, complete: bool, evaluated: &[&str], held: &[&str]) -> HoldsFacts {
    HoldsFacts {
        account: account.to_string(),
        inventory_loaded: true,
        known_before: vec![],
        held: held.iter().map(|h| (*h).to_string()).collect(),
        evaluated: evaluated.iter().map(|h| (*h).to_string()).collect(),
        holds_complete: complete,
        drop_ready: Some(true),
        drop_uncached: Some(true),
    }
}

struct StubHolds {
    result: Result<HoldsFacts, String>,
    calls: std::sync::Mutex<usize>,
    hashes: std::sync::Mutex<Vec<String>>,
    api_key: std::sync::Mutex<String>,
}

impl StubHolds {
    fn ok(facts: HoldsFacts) -> Self {
        Self {
            result: Ok(facts),
            calls: std::sync::Mutex::new(0),
            hashes: std::sync::Mutex::new(Vec::new()),
            api_key: std::sync::Mutex::new(String::new()),
        }
    }
    fn err() -> Self {
        Self {
            result: Err("rota de holds fora".into()),
            calls: std::sync::Mutex::new(0),
            hashes: std::sync::Mutex::new(Vec::new()),
            api_key: std::sync::Mutex::new(String::new()),
        }
    }
}

impl HoldsFeed for StubHolds {
    fn facts(
        &self,
        api_key: &str,
        _service: &str,
        hashes: &[String],
    ) -> Result<HoldsFacts, String> {
        *self.calls.lock().unwrap() += 1;
        *self.hashes.lock().unwrap() = hashes.to_vec();
        *self.api_key.lock().unwrap() = api_key.to_string();
        self.result.clone()
    }
}

fn native_check() -> AdapterDebridCheck {
    let mut debrid = AdapterDebridCheck::new("alldebrid", USER_KEY);
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    debrid
}

/// `DEBRID_AL_HOLDS=on` (feed injetado) + `DEBRID_AL_CLEANUP=on`: os fatos do
/// lote chegam à nativa, uma vez, com o lote INTEIRO.
#[test]
fn alldebrid_on_com_feed_completo_entrega_os_fatos() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = native_check();
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope(USER_KEY),
        true,
        &[HIT, MISS],
        &[MISS],
    )));
    debrid.holds = Some(feed.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);

    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(*feed.calls.lock().unwrap(), 1, "um feed por lote");
    assert_eq!(
        *feed.hashes.lock().unwrap(),
        vec![HIT.to_string(), MISS.to_string()],
        "o feed recebe o lote inteiro, não a 1ª stream"
    );
    assert_eq!(
        *feed.api_key.lock().unwrap(),
        USER_KEY,
        "a chave da conta vai ao feed"
    );
    let facts = debrid.last_facts().expect("fatos entregues à nativa");
    assert!(facts.covers(&[HIT.into(), MISS.into()]));
    assert_eq!(debrid.local_checks(), 1);
}

/// `DEBRID_AL_HOLDS=off` (sem feed) + limpeza ligada: o comportamento atual
/// fica preservado — a nativa responde e nenhum fato é entregue (read-only).
#[test]
fn alldebrid_on_sem_feed_continua_read_only() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = native_check();
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert!(debrid.last_facts().is_none());
    assert_eq!(debrid.local_checks(), 1);
}

/// Feed falhou: a nativa CONTINUA respondendo (nada de Unknown por causa do
/// feed) e nenhum fato é entregue — read-only.
#[test]
fn alldebrid_on_feed_fora_mantem_a_nativa_read_only() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = native_check();
    let feed = std::sync::Arc::new(StubHolds::err());
    debrid.holds = Some(feed.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(*feed.calls.lock().unwrap(), 1);
    assert!(debrid.last_facts().is_none(), "sem fatos = read-only");
}

/// Fatos de OUTRA conta não são aproveitados (nunca limpar com prova alheia).
#[test]
fn alldebrid_on_feed_de_outra_conta_e_descartado() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = native_check();
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope("outra-chave"),
        true,
        &[HIT, MISS],
        &[],
    )));
    debrid.holds = Some(feed);
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert!(debrid.last_facts().is_none());
}

/// Cobertura parcial: os fatos chegam (o que foi provado protege), mas o
/// `verdict` reconfere e NÃO autoriza (fail-closed).
#[test]
fn alldebrid_on_feed_incompleto_nao_autoriza_limpeza() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = native_check();
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope(USER_KEY),
        true,
        &[HIT],
        &[],
    )));
    debrid.holds = Some(feed);
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    let facts = debrid.last_facts().expect("fatos presentes");
    assert!(
        !facts.covers(&[HIT.into(), MISS.into()]),
        "evaluated sem MISS não cobre o lote"
    );
}

/// `DEBRID_AL_CLEANUP=off` (default): os fatos não têm uso — nem o feed é
/// consultado. Custo zero.
#[test]
fn sem_limpeza_o_feed_nao_e_consultado() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", None)]);
    let mut debrid = native_check();
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope(USER_KEY),
        true,
        &[HIT, MISS],
        &[],
    )));
    debrid.holds = Some(feed.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    assert_eq!(*feed.calls.lock().unwrap(), 0, "limpeza OFF não lê holds");
    assert!(debrid.last_facts().is_none());
}

/// Serviço diferente da AllDebrid nunca consulta o feed.
#[test]
fn outro_servico_nao_consulta_o_feed() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = AdapterDebridCheck::new("torbox", USER_KEY);
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope(USER_KEY),
        true,
        &[HIT],
        &[],
    )));
    debrid.holds = Some(feed.clone());
    let _ = debrid.check(&stream(HIT));
    assert_eq!(*feed.calls.lock().unwrap(), 0);
}
