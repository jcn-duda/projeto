//! Expiração do lote em settle — a parte DESTRUTIVA do recheck, isolada.
//!
//! O settle venceu (`createdAt + autoFetchTtl`): cada hash precisa de PROVA de
//! posse antes de sair da conta (`adom_core::expired_removal_allowed`):
//!
//! - retenção viva (`adhold:v1:` volátil / `adprot:v1:` durável do pool BR)
//!   em QUALQUER serviço: o hash vai para a REPRESA, nunca para o `remove` — é o
//!   `held.isCleanupProtected(h, account, adapter.id)` do oráculo
//!   (`git show HEAD:src/providers/autofetch-expired.ts`), invariante 6 do
//!   `AGENTS.md`;
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

/// Fatos de posse SEM retenção viva. Usado pela passagem de status
/// (`recheck_poll`), onde `expired` é `false` e os fatos não decidem nada.
pub(super) fn expired_facts(alldebrid: bool, has_marker: bool, has_adsub: bool) -> ExpiredFacts {
    expired_facts_protected(alldebrid, has_marker, has_adsub, false)
}

/// Mesma régua com a retenção viva injetada. `is_cleanup_protected` barra a
/// remoção em QUALQUER serviço (hold volátil ou proteção do pool BR), então o
/// hash vai para a represa em vez de virar `remove`.
///
/// `has_snapshot`/`in_snapshot` continuam `false` DE PROPÓSITO: sem o inventário
/// da conta a AllDebrid não remove nada (fail-safe de posse) — este worker
/// ainda não lê o snapshot, e inventá-lo seria remoção cega.
pub(super) fn expired_facts_protected(
    alldebrid: bool,
    has_marker: bool,
    has_adsub: bool,
    is_cleanup_protected: bool,
) -> ExpiredFacts {
    ExpiredFacts {
        hash_empty: false,
        is_cleanup_protected,
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
        // Retenção viva: `adhold`/`adprot` barram a remoção em qualquer serviço.
        let protected =
            super::suppressed_step::defended(kv, &lot.adapter_id, &lot.account, hash, now_ms)?;
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
            expired_facts: expired_facts_protected(
                adapter_is_alldebrid,
                has_marker,
                false,
                protected,
            ),
            remove_supported: true,
            // `policyOk` do settle do TS (`autofetch-recheck.ts:340`):
            // `st.via !== 'id' || config.debrid.removeById`. O `via` vem da
            // ÚLTIMA passagem de status do lote (`recheck_poll` grava em
            // `lot.via_id`) — este passo não consulta o serviço, e hash sem
            // observação por id remove normal, como no Node.
            via_id: lot.via_id.contains(hash),
            remove_by_id_enabled: policy.remove_by_id,
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
        // O `via` segue o hash que ficou: marca órfã voltaria a barrar remoção
        // de um hash reenfileirado depois.
        next.via_id.retain(|hash| kept.contains(hash));
        super::recheck::write(kv, &next, policy, now_ms)?;
    }
    report.remaining = kept.len();
    Ok(report)
}
