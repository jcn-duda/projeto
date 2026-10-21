//! Testes da costura: mapeamento veredito→resposta, lote/memo, reserva só
//! para serviço fora do despacho, e Unknown honesto sem re-upload AD.

use std::sync::Arc;
use std::time::Duration;

use adom_core::RankingStream;
use adom_debrid::alldebrid_cleanup::account_scope;
use adom_debrid::holds_feed::HoldsFacts;
use adom_debrid::verdict::{CheckOutcome, ServiceCheck, UnusableKind};
use tokio::runtime::{Handle, Runtime};

use super::{answer_of, AdapterDebridCheck, HoldsFeed};
use crate::list_builder::{DebridAnswer, DebridCheck};

const HIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MISS: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ENCODED: &str = "eyJwIjoiamFja2V0dCJ9";

fn outcome(
    cached: Vec<String>,
    known: bool,
    unusable: Option<(&'static str, &str)>,
) -> CheckOutcome {
    CheckOutcome {
        cached,
        known,
        unusable: unusable.map(|(reason, message)| {
            let kind = match reason {
                "auth" => UnusableKind::Auth,
                _ => UnusableKind::Quota,
            };
            (kind, message.to_string())
        }),
    }
}

fn stream(hash: &str) -> RankingStream {
    RankingStream {
        info_hash: Some(hash.to_string()),
        ..RankingStream::default()
    }
}

fn deadline() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 5_000
}

#[test]
fn mapeia_cached_missing_unknown_e_unusable() {
    assert_eq!(
        answer_of(&outcome(vec![HIT.into()], true, None), &HIT.to_uppercase()),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(
        answer_of(&outcome(vec![HIT.into()], true, None), HIT),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(
        answer_of(&outcome(vec![], true, None), MISS),
        DebridAnswer::Missing
    );
    assert_eq!(
        answer_of(&outcome(vec![], false, None), MISS),
        DebridAnswer::Unknown
    );
    // Hit parcial: known:false do lote NÃO apaga ⚡ do hash já em cached.
    assert_eq!(
        answer_of(&outcome(vec![HIT.into()], false, None), HIT),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(
        answer_of(&outcome(vec![HIT.into()], false, None), MISS),
        DebridAnswer::Unknown,
        "não-cached + !known → Unknown, nunca Missing"
    );
    assert_eq!(
        answer_of(&outcome(vec![], false, Some(("quota", "limite"))), MISS),
        DebridAnswer::Unusable
    );
    assert_eq!(
        answer_of(&outcome(vec![], true, Some(("auth", "chave ruim"))), HIT),
        DebridAnswer::Unusable
    );
}

/// A AllDebrid nativa checa o lote UMA vez; não há mais reserva Node.
#[test]
fn alldebrid_usa_a_nativa_em_lote() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    let _ = debrid.check(&stream(MISS));
    assert_eq!(debrid.local_checks(), 1, "um check nativo em lote");
}

fn service(
    cached: Vec<String>,
    known: bool,
    unusable: Option<(&'static str, &str)>,
    attempted: bool,
) -> Result<ServiceCheck, String> {
    Ok(ServiceCheck {
        outcome: outcome(cached, known, unusable),
        attempted,
    })
}

fn native_stub(
    result: Result<ServiceCheck, String>,
) -> Arc<dyn Fn() -> Result<ServiceCheck, String> + Send + Sync> {
    Arc::new(move || result.clone())
}

/// A nativa responde o lote e não há segundo caminho (a reserva Node saiu).
#[test]
fn alldebrid_usa_nativa_e_nao_tem_segundo_caminho() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(debrid.local_checks(), 1);
}

/// Upload tentado e lote perdido → Unknown (nunca `Missing`, nunca segundo
/// upload em outro caminho).
#[test]
fn alldebrid_falha_pos_upload_e_unknown() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![], false, None, true)));
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
}

/// Conta auth/quota na nativa: a lista volta P2P (Unusable).
#[test]
fn alldebrid_unusable_vira_unusable() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(
        vec![],
        false,
        Some(("quota", "cheio")),
        true,
    )));
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unusable);
}

/// Debrid-Link é conhecido no despacho, mas `cacheCheck=false`: o veredito é
/// `known:false` (Unknown), sem rede — o Node manda tudo pelo `/resolve`
/// degradado.
#[test]
fn debridlink_local_e_unknown_sem_rede() {
    let mut debrid = AdapterDebridCheck::new("debridlink", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.prepare(&[HIT.into()]);
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
}

/// RD sem store (ledger indisponível) é `Unknown`, não `Missing`: o finish
/// trata como lote degradado e o `cachedOnly` não pode cortar ninguém.
#[test]
fn realdebrid_sem_store_e_unknown_sem_rede() {
    let mut debrid = AdapterDebridCheck::new("realdebrid", "chave-do-usuario");
    debrid.prepare(&[HIT.into()]);
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
}

/// prepare + N checks = 1 local_checks (memo).
#[test]
fn memo_um_check_para_varios_streams() {
    let mut debrid = AdapterDebridCheck::new("debridlink", "chave");
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    let _ = debrid.check(&stream(MISS));
    let _ = debrid.check(&stream(HIT));
    assert_eq!(debrid.local_checks(), 1);
}

/// Sem hash não há o que checar: Unknown, sem rede.
#[test]
fn stream_sem_hash_e_unknown_sem_gastar_rede() {
    let mut debrid = AdapterDebridCheck::new("torbox", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    let vazio = RankingStream::default();
    assert_eq!(debrid.check(&vazio), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 0);
}

/// O `block_on` do seam NÃO pode usar `Handle::block_on` cru: `finish` roda
/// síncrono dentro de `run_search` (async). `block_in_place` é o contrato.
#[test]
fn check_dentro_de_runtime_tokio_nao_panica() {
    let runtime = Runtime::new().unwrap();
    runtime.block_on(async move {
        // Direto no worker async — espelha `Orchestrator::finish` no gateway.
        let mut debrid = AdapterDebridCheck::new("servico-que-ficou-501", "chave");
        debrid.timeout = Some(Duration::from_millis(100));
        assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
        let _ = Handle::try_current();
    });
}

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
    encoded: std::sync::Mutex<String>,
}

impl StubHolds {
    fn ok(facts: HoldsFacts) -> Self {
        Self {
            result: Ok(facts),
            calls: std::sync::Mutex::new(0),
            hashes: std::sync::Mutex::new(Vec::new()),
            encoded: std::sync::Mutex::new(String::new()),
        }
    }
    fn err() -> Self {
        Self {
            result: Err("rota de holds fora".into()),
            calls: std::sync::Mutex::new(0),
            hashes: std::sync::Mutex::new(Vec::new()),
            encoded: std::sync::Mutex::new(String::new()),
        }
    }
}

impl HoldsFeed for StubHolds {
    fn facts(
        &self,
        encoded: &str,
        _service: &str,
        hashes: &[String],
        _deadline_at: Option<i64>,
    ) -> Result<HoldsFacts, String> {
        *self.calls.lock().unwrap() += 1;
        *self.hashes.lock().unwrap() = hashes.to_vec();
        *self.encoded.lock().unwrap() = encoded.to_string();
        self.result.clone()
    }
}

fn native_check() -> AdapterDebridCheck {
    let mut debrid = AdapterDebridCheck::new("alldebrid", USER_KEY);
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
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
    assert_eq!(*feed.encoded.lock().unwrap(), ENCODED, "encoded do usuário");
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
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
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
