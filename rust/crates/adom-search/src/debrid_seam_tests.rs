//! Testes da costura: mapeamento veredito→resposta, lote/memo, reserva só
//! para serviço fora do despacho, e Unknown honesto sem re-upload AD.

use std::sync::Arc;
use std::time::Duration;

use adom_core::RankingStream;
use adom_debrid::alldebrid_cleanup::account_scope;
use adom_debrid::alldebrid_mode::AlRustMode;
use adom_debrid::holds_feed::HoldsFacts;
use adom_debrid::verdict::{CheckOutcome, ServiceCheck, UnusableKind};
use tokio::runtime::{Handle, Runtime};

use super::{answer_of, AdapterDebridCheck, FallbackCheck, HoldsFeed};
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

struct StubFallback {
    result: Result<CheckOutcome, String>,
    calls: std::sync::Mutex<usize>,
    last_hashes: std::sync::Mutex<Vec<String>>,
}

impl StubFallback {
    fn ok(outcome: CheckOutcome) -> Self {
        Self {
            result: Ok(outcome),
            calls: std::sync::Mutex::new(0),
            last_hashes: std::sync::Mutex::new(Vec::new()),
        }
    }
    fn err() -> Self {
        Self {
            result: Err("rota interna fora".into()),
            calls: std::sync::Mutex::new(0),
            last_hashes: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl FallbackCheck for StubFallback {
    fn check(
        &self,
        _encoded: &str,
        _service: &str,
        hashes: &[String],
        _deadline_at: i64,
    ) -> Result<CheckOutcome, String> {
        *self.calls.lock().unwrap() += 1;
        *self.last_hashes.lock().unwrap() = hashes.to_vec();
        self.result.clone()
    }
}

/// Serviço fora do despacho local → reserva consultada UMA vez no lote.
#[test]
fn fallback_atende_servico_fora_do_despacho() {
    let mut debrid = AdapterDebridCheck::new("servico-que-ficou-501", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    let stub = std::sync::Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(*stub.calls.lock().unwrap(), 1, "um lote, não N");
    assert_eq!(stub.last_hashes.lock().unwrap().len(), 2);
    assert_eq!(debrid.local_checks(), 0);
    assert_eq!(debrid.fallback_checks(), 1);
}

/// Reserva em erro → Unknown, nunca Missing.
#[test]
fn fallback_falho_e_unknown() {
    let mut debrid = AdapterDebridCheck::new("servico-que-ficou-501", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.fallback = Some(std::sync::Arc::new(StubFallback::err()));
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);

    let mut debrid = AdapterDebridCheck::new("servico-que-ficou-501", "chave-do-usuario");
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
}

/// AllDebrid com reserva Node: a checagem é do Node (davail, hold e limpeza),
/// UM lote, zero upload local (o local não limpa a conta até a Fase C).
#[test]
fn alldebrid_vai_a_reserva_node_sem_upload_local() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    let stub = std::sync::Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(*stub.calls.lock().unwrap(), 1, "um lote, não N");
    assert_eq!(debrid.local_checks(), 0, "nenhum upload local");
    assert_eq!(debrid.fallback_checks(), 1);
}

/// Reserva Node falhou: "não sei" (Unknown), nunca o upload local — o Node
/// pode já ter enviado o lote, e um segundo upload dobraria o lixo na conta.
#[test]
fn alldebrid_reserva_falha_e_unknown_sem_upload_local() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.fallback = Some(std::sync::Arc::new(StubFallback::err()));
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 0);
    assert_eq!(debrid.fallback_checks(), 1);
}

/// Sem reserva configurada (sem rota interna): o check local continua, em
/// UM lote.
#[test]
fn alldebrid_sem_reserva_usa_o_local_em_lote() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.timeout = Some(Duration::from_millis(50));
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    let _ = debrid.check(&stream(MISS));
    assert_eq!(debrid.local_checks(), 1, "um check local em lote");
    assert_eq!(debrid.fallback_checks(), 0);
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

/// `DEBRID_AL_RUST=on`: a nativa responde e o Node NÃO é consultado.
#[test]
fn alldebrid_on_usa_nativa_e_nao_chama_o_node() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::On;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    let stub = Arc::new(StubFallback::ok(outcome(vec![MISS.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(debrid.local_checks(), 1);
    assert_eq!(
        *stub.calls.lock().unwrap(),
        0,
        "não repete o upload no Node"
    );
}

/// `on` sem upload enviado (base recusada/lista vazia) → fallback Node.
#[test]
fn alldebrid_on_cai_no_node_so_quando_nada_foi_enviado() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::On;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![], false, None, false)));
    let stub = Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(*stub.calls.lock().unwrap(), 1);
    assert_eq!(debrid.fallback_checks(), 1);
}

/// F4.6 — a reserva Node está APOSENTADA (410) no default do corte. Sem nada
/// enviado pela nativa, o fallback ainda é tentado; o 410 vira erro e a
/// resposta é `Unknown` honesto (nunca `Missing`, nunca segundo upload).
#[test]
fn alldebrid_on_reserva_aposentada_vira_unknown() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::On;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![], false, None, false)));
    debrid.fallback = Some(Arc::new(StubFallback::err()));
    debrid.prepare(&[HIT.into()]);
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
    assert_eq!(debrid.fallback_checks(), 1, "tentou a reserva uma vez");
}

/// `on` com upload tentado e lote perdido → Unknown, NUNCA segundo upload.
#[test]
fn alldebrid_on_falha_pos_upload_nao_repete_no_node() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::On;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![], false, None, true)));
    let stub = Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(*stub.calls.lock().unwrap(), 0);
}

/// Conta auth/quota na nativa: a lista volta P2P (Unusable) sem Node.
#[test]
fn alldebrid_on_unusable_nao_consulta_o_node() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::On;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(
        vec![],
        false,
        Some(("quota", "cheio")),
        true,
    )));
    let stub = Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unusable);
    assert_eq!(*stub.calls.lock().unwrap(), 0);
}

/// `shadow`: a nativa responde (caminho vivo) e o Node é a REFERÊNCIA em
/// fundo — o cliente não espera a comparação.
#[test]
fn alldebrid_shadow_responde_nativo_e_compara_em_fundo() {
    // Amostra 0: a thread de referência não chama o Node (o par é coberto
    // nos testes do módulo da sombra). O que importa aqui é a resposta e o
    // disparo.
    let _lock = crate::test_env::lock();
    let _env = shadow_env::Saved::set(&[("DEBRID_AL_SHADOW_PERCENT", "0")]);
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.mode = AlRustMode::Shadow;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    // A referência diz outra coisa: se ela vencesse, HIT não seria Cached.
    let stub = Arc::new(StubFallback::ok(outcome(vec![MISS.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    assert_eq!(
        debrid.check(&stream(HIT)),
        DebridAnswer::Cached { url: None }
    );
    assert_eq!(debrid.check(&stream(MISS)), DebridAnswer::Missing);
    assert_eq!(debrid.local_checks(), 1, "a nativa é o lado vivo");
    assert_eq!(
        debrid.fallback_checks(),
        0,
        "a referência não passa pelo caminho bloqueante"
    );
    // Dá tempo de a thread da sombra ler a amostra 0 antes do guard restaurar
    // a env (o teste não espera a task: o contrato é não segurar o cliente).
    std::thread::sleep(Duration::from_millis(50));
}

mod shadow_env {
    pub struct Saved(Vec<(&'static str, Option<String>)>);

    impl Saved {
        pub fn set(pairs: &[(&'static str, &str)]) -> Self {
            let saved = pairs
                .iter()
                .map(|(name, value)| {
                    let prev = std::env::var(name).ok();
                    unsafe { std::env::set_var(name, value) };
                    (*name, prev)
                })
                .collect();
            Self(saved)
        }
    }

    impl Drop for Saved {
        fn drop(&mut self) {
            for (name, prev) in &self.0 {
                unsafe {
                    match prev {
                        Some(value) => std::env::set_var(name, value),
                        None => std::env::remove_var(name),
                    }
                }
            }
        }
    }
}

/// Debrid-Link é conhecido no despacho, mas `cacheCheck=false`: o veredito é
/// `known:false` (Unknown), sem reserva Node e sem rede — o Node manda tudo
/// pelo `/resolve` degradado.
#[test]
fn debridlink_local_e_unknown_sem_rede() {
    let mut debrid = AdapterDebridCheck::new("debridlink", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.prepare(&[HIT.into()]);
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
    assert_eq!(debrid.fallback_checks(), 0);
}

/// RD sem store (ledger indisponível) é `Unknown`, não `Missing`: o finish
/// trata como lote degradado e o `cachedOnly` não pode cortar ninguém.
#[test]
fn realdebrid_sem_store_e_unknown_sem_rede() {
    let mut debrid = AdapterDebridCheck::new("realdebrid", "chave-do-usuario");
    debrid.prepare(&[HIT.into()]);
    assert_eq!(debrid.check(&stream(HIT)), DebridAnswer::Unknown);
    assert_eq!(debrid.local_checks(), 1);
    assert_eq!(debrid.fallback_checks(), 0);
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

/// Sem hash não há o que checar: Unknown, sem rede e sem reserva.
#[test]
fn stream_sem_hash_e_unknown_sem_gastar_rede() {
    let mut debrid = AdapterDebridCheck::new("torbox", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    let stub = std::sync::Arc::new(StubFallback::err());
    debrid.fallback = Some(stub.clone());
    let vazio = RankingStream::default();
    assert_eq!(debrid.check(&vazio), DebridAnswer::Unknown);
    assert_eq!(*stub.calls.lock().unwrap(), 0);
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
    debrid.mode = AlRustMode::On;
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
    assert_eq!(debrid.fallback_checks(), 0, "nativa respondeu; Node não");
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

/// `shadow` é observação: a nativa responde, mas NÃO limpa — o feed fica de
/// fora mesmo com a limpeza ligada.
#[test]
fn shadow_nao_consulta_o_feed() {
    let _env = FeedEnv::set(&[
        ("DEBRID_AL_CLEANUP", Some("on")),
        ("DEBRID_AL_SHADOW_PERCENT", Some("0")),
    ]);
    let mut debrid = AdapterDebridCheck::new("alldebrid", USER_KEY);
    debrid.mode = AlRustMode::Shadow;
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.local_stub = Some(native_stub(service(vec![HIT.into()], true, None, true)));
    let feed = std::sync::Arc::new(StubHolds::ok(holds_facts(
        &account_scope(USER_KEY),
        true,
        &[HIT, MISS],
        &[],
    )));
    debrid.holds = Some(feed.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let _ = debrid.check(&stream(HIT));
    assert_eq!(*feed.calls.lock().unwrap(), 0);
    assert!(debrid.last_facts().is_none());
}

/// Serviço diferente da AllDebrid nunca consulta o feed.
#[test]
fn outro_servico_nao_consulta_o_feed() {
    let _env = FeedEnv::set(&[("DEBRID_AL_CLEANUP", Some("on"))]);
    let mut debrid = AdapterDebridCheck::new("torbox", USER_KEY);
    debrid.mode = AlRustMode::On;
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
