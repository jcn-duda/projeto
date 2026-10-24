//! Testes da costura: mapeamento veredito→resposta, lote/memo, reserva só
//! para serviço fora do despacho, e Unknown honesto sem re-upload AD.

use std::sync::Arc;
use std::time::Duration;

use adom_core::RankingStream;
use adom_debrid::verdict::{CheckOutcome, ServiceCheck, UnusableKind};
use tokio::runtime::{Handle, Runtime};

use super::{answer_of, AdapterDebridCheck};
use crate::list_builder::{DebridAnswer, DebridCheck};

#[path = "debrid_seam_tests_part2.rs"]
mod part2;

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
