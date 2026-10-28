//! Dreno do PRÓXIMO candidato de uma busca (o `drainNext` do Node).
//!
//! Chamado depois de um terminal do recheck (`dead`, parado ou progresso): uma
//! fila que só cresce nunca mais baixa nada. A decisão é PURA
//! (`adom_autofetch::v3::drain_next` + `finish_drain_selection`); aqui moram o
//! I/O e a fila, com a MESMA ordem do Node:
//!
//! 1. portões ANTES de tocar a fila (`DrainGates`);
//! 2. obsoleto sai (hash morto ou já aceito — o marker é a prova do aceite);
//! 3. hold ANTES do `enqueue`, marker só depois do aceite;
//! 4. aceito sai da fila; falha devolve o candidato na FRENTE (nunca se perde).
//!
//! Sem `searchKey`/escopo não há o que drenar: a resposta é vazia, sem escrita.

use adom_autofetch::v3::{
    drain_next, finish_drain_selection, marker_value, DrainBlock, DrainDecision, DrainGates,
    DrainNext, QueueCandidate, QueueV3,
};
use adom_core::SkipReason;
use adom_index::NativeKv;

use super::enqueue::Holds;
use super::Policy;

/// Resultado de um dreno: o que começou, o que bloqueou e o tamanho da fila.
/// `blocked`/`remaining` são diagnóstico: só o painel da leva do flip os lê.
#[allow(dead_code)]
#[derive(Debug, Default)]
pub(crate) struct DrainReport {
    pub(crate) started: Option<String>,
    pub(crate) blocked: Option<&'static str>,
    pub(crate) remaining: usize,
}

/// Dreno com os fatos desta leva: conta/orçamento/cooldown ainda não são
/// medidos (entram desbloqueados); o que barra de verdade é a pausa, a fila
/// vazia e o obsoleto.
#[allow(clippy::too_many_arguments)] // um dono por eixo: KV, réguas, hold, pausa, adaptador, escopo, busca, relógio
pub(crate) async fn drain_one(
    kv: &NativeKv,
    policy: Policy,
    holds: &Holds,
    paused: bool,
    debrid: &dyn adom_autofetch::v3::AutofetchDebrid<Error = String>,
    scope: &str,
    search_key: &str,
    now_ms: i64,
) -> Result<DrainReport, String> {
    let Some((adapter, account)) = scope.split_once(':') else {
        return Ok(DrainReport::default());
    };
    if adapter.is_empty() || account.is_empty() {
        return Ok(DrainReport::default());
    }
    let queue = QueueV3::new(kv);
    let live = queue.read_queue(search_key, now_ms)?;
    let gates = DrainGates {
        search_key_present: !search_key.is_empty(),
        queue_enabled: true,
        paused,
        adapter_available: true,
        budget_blocked: false,
        rd_cooldown: false,
        account_blocked: false,
        refusals: 0,
        max_refusals: 3,
    };
    let selected = drain_next::<(), String>(
        &gates,
        live,
        |candidate| {
            Ok(
                queue.is_dead(adapter, account, &candidate.info_hash, now_ms)?
                    || queue
                        .marker(adapter, account, &candidate.info_hash, now_ms)?
                        .is_some(),
            )
        },
        |_| Ok(false),
        |_| Ok(Some(())),
    )?;
    let selection = match selected {
        DrainNext::Blocked { reason, queue } => {
            return Ok(DrainReport {
                started: None,
                blocked: Some(block_label(reason)),
                remaining: queue.len(),
            })
        }
        DrainNext::Selected(selection) => selection,
    };
    match finish_drain_selection(*selection, true, true) {
        DrainDecision::Start {
            candidate,
            remaining,
            ..
        } => {
            let started = start(
                &queue,
                policy,
                holds,
                debrid,
                (adapter, account),
                search_key,
                &candidate,
                remaining,
                now_ms,
            )
            .await?;
            Ok(started)
        }
        DrainDecision::Empty { remaining } => {
            persist(
                &queue,
                policy,
                (adapter, account),
                search_key,
                &remaining,
                now_ms,
            )?;
            Ok(DrainReport {
                blocked: Some("empty"),
                remaining: remaining.len(),
                ..DrainReport::default()
            })
        }
        DrainDecision::Requeue { queue: rest, .. } => {
            persist(
                &queue,
                policy,
                (adapter, account),
                search_key,
                &rest,
                now_ms,
            )?;
            Ok(DrainReport {
                blocked: Some("requeue"),
                remaining: rest.len(),
                ..DrainReport::default()
            })
        }
        DrainDecision::InvalidSelection { queue: rest } => {
            persist(
                &queue,
                policy,
                (adapter, account),
                search_key,
                &rest,
                now_ms,
            )?;
            Ok(DrainReport {
                blocked: Some("invalid-selection"),
                remaining: rest.len(),
                ..DrainReport::default()
            })
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn start(
    queue: &QueueV3<'_>,
    policy: Policy,
    holds: &Holds,
    debrid: &dyn adom_autofetch::v3::AutofetchDebrid<Error = String>,
    scope: (&str, &str),
    search_key: &str,
    candidate: &QueueCandidate,
    remaining: Vec<QueueCandidate>,
    now_ms: i64,
) -> Result<DrainReport, String> {
    let (adapter, account) = scope;
    // Hold ANTES do enqueue: o mesmo invariante do lote.
    holds.acquire(&candidate.info_hash);
    let outcome = debrid.enqueue(candidate).await;
    let transfer = match &outcome {
        Ok(evidence) if evidence.accepted => evidence.transfer_id.clone(),
        _ => None,
    };
    let started = matches!(&outcome, Ok(evidence) if evidence.accepted);
    if started {
        queue.set_marker(
            adapter,
            account,
            &candidate.info_hash,
            &marker_value(true, transfer.as_deref(), None, now_ms),
            policy.marker_ttl_seconds,
            now_ms,
        )?;
    }
    holds.release(&candidate.info_hash);
    let mut next = Vec::with_capacity(remaining.len() + 1);
    if !started {
        next.push(candidate.clone());
    }
    next.extend(remaining);
    persist(queue, policy, scope, search_key, &next, now_ms)?;
    Ok(DrainReport {
        started: started.then(|| candidate.info_hash.clone()),
        blocked: (!started).then_some("enqueue-error"),
        remaining: next.len(),
    })
}

fn persist(
    queue: &QueueV3<'_>,
    policy: Policy,
    scope: (&str, &str),
    search_key: &str,
    candidates: &[QueueCandidate],
    now_ms: i64,
) -> Result<(), String> {
    if candidates.is_empty() {
        queue.drop_queue(search_key)?;
        return Ok(());
    }
    queue
        .write_queue(
            search_key,
            candidates,
            policy.queue_ttl_seconds,
            policy.queue_depth,
            Some(scope),
            now_ms,
        )
        .map(|_| ())
}

fn block_label(reason: DrainBlock) -> &'static str {
    match reason {
        DrainBlock::Disabled => "drain-disabled",
        DrainBlock::Paused => SkipReason::Paused.as_str(),
        DrainBlock::Empty => "empty",
        DrainBlock::NoAdapter => "no-adapter",
        DrainBlock::Budget => SkipReason::Budget.as_str(),
        DrainBlock::RdCooldown => "rd-cooldown",
        DrainBlock::Account => SkipReason::AccountGate.as_str(),
        DrainBlock::Refusals => "refusals",
    }
}
