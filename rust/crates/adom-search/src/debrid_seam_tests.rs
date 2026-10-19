//! Testes da costura: mapeamento veredito→resposta, lote/memo, reserva só
//! para serviço fora do despacho, e Unknown honesto sem re-upload AD.

use std::time::Duration;

use adom_core::RankingStream;
use adom_debrid::verdict::{CheckOutcome, UnusableKind};
use tokio::runtime::{Handle, Runtime};

use super::{answer_of, AdapterDebridCheck, FallbackCheck};
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

/// Serviço conhecido (AllDebrid): Ok(Unknown) local NÃO dispara reserva —
/// nunca segundo upload / re-consulta Node.
#[test]
fn alldebrid_conhecido_nunca_cai_no_fallback() {
    let mut debrid = AdapterDebridCheck::new("alldebrid", "chave-do-usuario");
    debrid.encoded = Some(ENCODED.into());
    debrid.deadline_at = Some(deadline());
    debrid.timeout = Some(Duration::from_millis(50));
    let stub = std::sync::Arc::new(StubFallback::ok(outcome(vec![HIT.into()], true, None)));
    debrid.fallback = Some(stub.clone());
    debrid.prepare(&[HIT.into(), MISS.into()]);
    let a = debrid.check(&stream(HIT));
    let b = debrid.check(&stream(MISS));
    assert!(matches!(
        a,
        DebridAnswer::Unknown
            | DebridAnswer::Cached { .. }
            | DebridAnswer::Missing
            | DebridAnswer::Unusable
    ));
    assert!(matches!(
        b,
        DebridAnswer::Unknown
            | DebridAnswer::Cached { .. }
            | DebridAnswer::Missing
            | DebridAnswer::Unusable
    ));
    assert_eq!(
        *stub.calls.lock().unwrap(),
        0,
        "AD conhecido: zero fallback"
    );
    assert_eq!(debrid.local_checks(), 1, "um check local em lote");
    assert_eq!(debrid.fallback_checks(), 0);
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
