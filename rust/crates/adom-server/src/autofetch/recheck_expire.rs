//! Expiração do lote em settle — a parte DESTRUTIVA do recheck, isolada.
//!
//! O settle venceu (`createdAt + autoFetchTtl`): cada hash precisa de PROVA de
//! posse antes de sair da conta (`adom_core::expired_removal_allowed`):
//!
//! - fora da AllDebrid: remoção histórica preservada (exige ao menos o id do
//!   transfer, senão não há o que remover);
//! - AllDebrid: exige marker (`autofetch:v3:m:`) ou adsub E o snapshot de
//!   pré-existentes carregado. Como estes dois ainda não são lidos por este
//!   worker, o resultado é a REPRESA (`sup:`), nunca a remoção cega.
//!
//! Nada aqui inventa id: hash sem transfer só sai do lote, sem chamada de rede.

use adom_autofetch::v3::{recheck_step, QueueV3, RecheckAction, RecheckInput, SuppressedV3};
use adom_core::ExpiredFacts;
use adom_index::NativeKv;

use super::recheck::{StepReport, DEAD_THRESHOLD};
use super::{lot_key, Policy, QUEUE_PREFIX};

/// Fatos de posse. `has_snapshot`/`in_snapshot` entram na leva do flip: sem o
/// inventário da conta não há como provar que o hash não é acervo do usuário.
pub(super) fn expired_facts(alldebrid: bool, has_marker: bool, has_adsub: bool) -> ExpiredFacts {
    ExpiredFacts {
        hash_empty: false,
        is_cleanup_protected: false,
        adapter_is_alldebrid: alldebrid,
        has_marker,
        has_adsub,
        has_snapshot: false,
        in_snapshot: false,
    }
}

/// Expira o lote inteiro. `finished` quando não sobrou hash (o caso normal);
/// hash cuja remoção falhou volta para o lote, para a próxima passagem.
pub(super) async fn expire(
    kv: &NativeKv,
    policy: Policy,
    debrid: &dyn adom_autofetch::v3::AutofetchDebrid<Error = String>,
    adapter_is_alldebrid: bool,
    lot: &super::recheck::Lot,
    now_ms: i64,
) -> Result<StepReport, String> {
    let queue = QueueV3::new(kv);
    let suppressed = SuppressedV3::new(kv);
    let mut report = StepReport::outcome("expired");
    let mut kept = Vec::new();
    for hash in &lot.info_hashes {
        let transfer = lot.transfers.get(hash).cloned();
        let has_marker = queue
            .marker(&lot.adapter_id, &lot.account, hash, now_ms)?
            .is_some();
        let input = RecheckInput {
            cached: false,
            // Não é passagem de status: o settle venceu, `expired` decide.
            status_ok: false,
            state: None,
            stalled: false,
            derived_stalled: false,
            dead_streak: 0,
            stall_streak: 0,
            dead_threshold: DEAD_THRESHOLD,
            stall_threshold: 0,
            expired: true,
            expired_facts: expired_facts(adapter_is_alldebrid, has_marker, false),
            remove_supported: true,
            via_id: false,
            remove_by_id_enabled: false,
            id_present: transfer.is_some(),
        };
        match recheck_step(&input) {
            RecheckAction::RemoveExpired => {
                let Some(id) = transfer else {
                    kept.push(hash.clone());
                    continue;
                };
                match debrid.remove(&id).await {
                    Ok(true) => report.expired += 1,
                    // Remoção recusada/instável: o hash continua no lote.
                    _ => kept.push(hash.clone()),
                }
            }
            RecheckAction::SuppressExpired => {
                if let Some(id) = transfer {
                    suppressed.note(
                        &lot.adapter_id,
                        &lot.account,
                        hash,
                        &id,
                        policy.lot_ttl_seconds,
                        now_ms,
                    )?;
                }
                report.suppressed += 1;
            }
            // Sem prova de posse não há remoção: o hash só sai do lote.
            _ => report.expired += 1,
        }
    }
    if kept.is_empty() {
        // Fila cai com o lote (`dropQueue`): nada do settle pode sobrar armado.
        if queue.drop_queue(&lot.search_key)? && !lot.search_key.is_empty() {
            eprintln!(
                "[autofetch] settle expirado: fila de {}* descartada",
                QUEUE_PREFIX
            );
        }
        kv.forget(&lot_key(&lot.search_key))?;
        report.outcome = Some("finished");
    } else {
        let mut next = lot.clone();
        next.info_hashes = kept.clone();
        next.transfers.retain(|hash, _| kept.contains(hash));
        super::recheck::write(kv, &next, policy, now_ms)?;
    }
    report.remaining = kept.len();
    Ok(report)
}
