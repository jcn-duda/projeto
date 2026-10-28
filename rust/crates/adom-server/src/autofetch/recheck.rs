//! Recheck do lote persistido (`autofetch:v3:lot:`) — o `runRecheck` do Node.
//!
//! O lote guarda o que a busca deixou em voo: hashes, `attempts`, streaks por
//! hash, o adapter DONO (nunca o "corrente") e `createdAt`. As transições são
//! puras (`adom_autofetch::v3::recheck_step`, `lot_outcome`,
//! `settle_lru_evictions`); aqui moram o KV, a rede e a ordem:
//!
//! 1. lote vazio → `Finished`: a fila da busca cai (`dropQueue`) e o lote sai;
//! 2. settle vencido (`createdAt + autoFetchTtl`) → `Expired`: expira hash a hash
//!    **com prova de posse** (marker/adsub + snapshot; fora da AllDebrid a
//!    remoção histórica é preservada) e o que não tem prova vai para represados
//!    (`sup:`), nunca para o lixo;
//! 3. `attempts >= autoFetchRecheckMax` → `EnterSettle`: entra em settle, roda o
//!    LRU e **não** drena fila (dreno cego não volta);
//! 4. senão → passagem de status: `ready`/terminal resolvem o hash, morte
//!    comprovada vira `dead:` da conta, parado/progresso terminal sai do lote.
//!
//! Terminal com fila viva chama o dreno do próximo (`enqueue_drain`): é o
//! chamador (laço) que decide, para o módulo não depender do engine inteiro.

use std::collections::BTreeMap;

use adom_autofetch::v3::{
    lot_outcome, recheck_step, recheck_streaks, settle_lru_evictions, LotFacts, LotOutcome,
    QueueV3, RecheckAction, RecheckInput, SettleLotRef,
};
use adom_index::NativeKv;
use serde::{Deserialize, Serialize};

use super::{lot_key, Policy, LOT_PREFIX};

/// `isDead` do Node: duas observações de morte seguidas.
pub(crate) const DEAD_THRESHOLD: i64 = 2;
/// `autoFetchStallStreak` default (`DEBRID_AUTO_FETCH_STALL_STREAK=3`). Zero
/// desligaria a detecção — aqui o default do Node é o que vale.
const STALL_THRESHOLD: i64 = 3;

/// Lote de recheck. Não guarda credencial: só hashes, contadores e ids de
/// transferência (que já são estado da conta no serviço).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lot {
    pub(crate) search_key: String,
    /// Adapter DONO do lote: a evicção usa ESTE id, nunca o corrente.
    pub(crate) adapter_id: String,
    /// `accountScope` (sha256 da chave) — o mesmo das chaves `q:`/`dead:`.
    pub(crate) account: String,
    pub(crate) info_hashes: Vec<String>,
    pub(crate) attempts: i64,
    pub(crate) is_settle: bool,
    pub(crate) created_at: i64,
    #[serde(default)]
    pub(crate) dead_streak: BTreeMap<String, i64>,
    #[serde(default)]
    pub(crate) stall_streak: BTreeMap<String, i64>,
    #[serde(default)]
    pub(crate) transfers: BTreeMap<String, String>,
}

/// Resultado de uma passagem. `terminal` avisa o laço que vale a pena drenar.
#[derive(Debug, Default)]
pub(crate) struct StepReport {
    pub(crate) ran: bool,
    pub(crate) outcome: Option<&'static str>,
    pub(crate) resolved: usize,
    pub(crate) dead: usize,
    pub(crate) expired: usize,
    pub(crate) suppressed: usize,
    pub(crate) terminal: bool,
    pub(crate) remaining: usize,
}

impl StepReport {
    pub(crate) fn outcome(outcome: &'static str) -> Self {
        Self {
            ran: true,
            outcome: Some(outcome),
            ..Self::default()
        }
    }
}

pub(crate) fn read(kv: &NativeKv, search_key: &str, now_ms: i64) -> Result<Option<Lot>, String> {
    if search_key.is_empty() {
        return Ok(None);
    }
    let Some(value) = kv.get_json(&lot_key(search_key), now_ms)? else {
        return Ok(None);
    };
    serde_json::from_value(value)
        .map(Some)
        .map_err(|err| format!("lote de recheck ilegível: {err}"))
}

fn load(kv: &NativeKv, now_ms: i64) -> Result<Vec<Lot>, String> {
    let mut out = Vec::new();
    for key in kv.keys_matching(LOT_PREFIX, now_ms)? {
        let Some(value) = kv.get_json(&key, now_ms)? else {
            continue;
        };
        match serde_json::from_value::<Lot>(value) {
            Ok(lot) => out.push(lot),
            Err(err) => eprintln!("[autofetch] lote ilegível em {key}: {err}"),
        }
    }
    Ok(out)
}

/// Grava o lote com o TTL do autofetch (`autoFetchTtl`).
pub(crate) fn write(kv: &NativeKv, lot: &Lot, policy: Policy, now_ms: i64) -> Result<(), String> {
    if lot.info_hashes.is_empty() || lot.search_key.is_empty() {
        kv.forget(&lot_key(&lot.search_key))?;
        return Ok(());
    }
    let value = serde_json::to_value(lot).map_err(|err| err.to_string())?;
    kv.put_json(
        &lot_key(&lot.search_key),
        &value,
        policy.lot_ttl_seconds,
        now_ms,
    )
}

/// Agenda o recheck do que a busca acabou de enfileirar (o `scheduleRecheck`).
///
/// Lote existente da MESMA busca é reusado (união dos hashes, `attempts` e
/// `createdAt` preservados): reiniciar a contagem a cada busca deixaria o lote
/// eterno — o Node faz o mesmo reuso.
pub(crate) fn schedule(
    kv: &NativeKv,
    policy: Policy,
    search_key: &str,
    adapter: &str,
    account: &str,
    enqueued: &[(String, Option<String>)],
    now_ms: i64,
) -> Result<Option<Lot>, String> {
    if search_key.is_empty() || enqueued.is_empty() {
        return Ok(None);
    }
    let mut lot = read(kv, search_key, now_ms)?.unwrap_or_else(|| Lot {
        search_key: search_key.to_string(),
        adapter_id: adapter.to_string(),
        account: account.to_string(),
        created_at: now_ms,
        ..Lot::default()
    });
    for (hash, transfer) in enqueued {
        let hash = hash.to_ascii_lowercase();
        if !lot.info_hashes.contains(&hash) {
            lot.info_hashes.push(hash.clone());
        }
        if let Some(id) = transfer {
            lot.transfers.insert(hash, id.clone());
        }
    }
    if lot.adapter_id.is_empty() {
        lot.adapter_id = adapter.to_string();
    }
    if lot.account.is_empty() {
        lot.account = account.to_string();
    }
    write(kv, &lot, policy, now_ms)?;
    Ok(Some(lot))
}

/// Quando o lote volta a ser olhado: um intervalo por passagem já feita. Lote
/// que ainda não teve nenhuma passagem espera o PRIMEIRO intervalo
/// (`createdAt + interval`) — sem isso o laço reprocessaria no mesmo ciclo do
/// enfileiramento.
pub(crate) fn due_at(lot: &Lot, policy: Policy) -> i64 {
    let passes = lot.attempts.max(1);
    lot.created_at
        .saturating_add(passes.saturating_mul(policy.recheck_interval_ms))
}

fn facts_of(lot: &Lot, policy: Policy, now_ms: i64) -> LotFacts {
    LotFacts {
        remaining: lot.info_hashes.len(),
        is_settle: lot.is_settle,
        attempts: lot.attempts,
        recheck_max: policy.recheck_max,
        age_ms: now_ms.saturating_sub(lot.created_at),
        settle_horizon_ms: policy.settle_horizon_ms,
    }
}

/// Uma passagem do lote. `adapter_is_alldebrid` entra como FATO (o serviço é do
/// adaptador injetado, não deste módulo).
pub(crate) async fn step<D: adom_autofetch::v3::AutofetchDebrid<Error = String> + ?Sized>(
    kv: &NativeKv,
    policy: Policy,
    debrid: &D,
    adapter_is_alldebrid: bool,
    search_key: &str,
    now_ms: i64,
) -> Result<StepReport, String> {
    let Some(mut lot) = read(kv, search_key, now_ms)? else {
        return Ok(StepReport::default());
    };
    match lot_outcome(facts_of(&lot, policy, now_ms)) {
        LotOutcome::Finished => {
            QueueV3::new(kv).drop_queue(search_key)?;
            kv.forget(&lot_key(search_key))?;
            Ok(StepReport::outcome("finished"))
        }
        LotOutcome::Expired => {
            super::recheck_expire::expire(kv, policy, debrid, adapter_is_alldebrid, &lot, now_ms)
                .await
        }
        LotOutcome::EnterSettle => {
            lot.is_settle = true;
            write(kv, &lot, policy, now_ms)?;
            settle_lru(kv, policy, now_ms)?;
            let mut report = StepReport::outcome("enter-settle");
            report.remaining = lot.info_hashes.len();
            Ok(report)
        }
        LotOutcome::Continue => poll(kv, policy, debrid, &lot, now_ms).await,
    }
}

/// Passagem de status: `ready`/terminal resolvem; morte comprovada vira `dead:`
/// da conta; ausência de resposta não é prova de nada.
async fn poll<D: adom_autofetch::v3::AutofetchDebrid<Error = String> + ?Sized>(
    kv: &NativeKv,
    policy: Policy,
    debrid: &D,
    lot: &Lot,
    now_ms: i64,
) -> Result<StepReport, String> {
    let statuses = match debrid.status(&lot.info_hashes, &lot.transfers).await {
        Ok(statuses) => statuses,
        Err(_) => return Err("status do debrid falhou".to_string()),
    };
    let queue = QueueV3::new(kv);
    let mut next = lot.clone();
    next.attempts = lot.attempts.saturating_add(1);
    let mut report = StepReport::outcome("poll");
    let mut kept = Vec::new();
    for hash in &lot.info_hashes {
        let evidence = statuses.get(hash);
        let input = RecheckInput {
            cached: false,
            status_ok: evidence.is_some(),
            state: evidence.map(|item| item.state.clone()),
            stalled: evidence.is_some_and(|item| item.stalled),
            derived_stalled: false,
            dead_streak: *lot.dead_streak.get(hash).unwrap_or(&0),
            stall_streak: *lot.stall_streak.get(hash).unwrap_or(&0),
            dead_threshold: DEAD_THRESHOLD,
            stall_threshold: STALL_THRESHOLD,
            expired: false,
            expired_facts: super::recheck_expire::expired_facts(false, false, false),
            remove_supported: true,
            via_id: evidence.is_some_and(|item| item.via_id),
            remove_by_id_enabled: false,
            id_present: lot.transfers.contains_key(hash),
        };
        let action = recheck_step(&input);
        let streaks = recheck_streaks(&input);
        next.dead_streak.insert(hash.clone(), streaks.dead);
        next.stall_streak.insert(hash.clone(), streaks.stalled);
        match action {
            RecheckAction::Ready => {
                report.resolved += 1;
            }
            RecheckAction::TerminalDead => {
                queue.mark_dead(
                    &lot.adapter_id,
                    &lot.account,
                    hash,
                    policy.dead_ttl_seconds,
                    now_ms,
                )?;
                report.dead += 1;
                report.terminal = true;
            }
            RecheckAction::TerminalStalled | RecheckAction::TerminalProgress => {
                // Parado/progresso terminal saem do lote, mas NÃO viram `dead:`:
                // não há prova de morte, só de que aquele download não anda.
                report.resolved += 1;
                report.terminal = true;
            }
            // Sem resposta/sem estado: o hash fica e os contadores não mudam.
            RecheckAction::Pending
            | RecheckAction::Unknown
            | RecheckAction::RemoveExpired
            | RecheckAction::SuppressExpired
            | RecheckAction::ReleaseExpired => kept.push(hash.clone()),
        }
    }
    next.info_hashes = kept.clone();
    next.transfers.retain(|hash, _| kept.contains(hash));
    report.remaining = kept.len();
    if kept.is_empty() {
        // Terminal (morto/parado) NÃO derruba a fila: é dela que sai o próximo
        // candidato do dreno. Só o lote que esvaziou sem terminal (tudo pronto)
        // fecha o ciclo da busca e apaga a fila — a ordem do Node.
        if !report.terminal {
            QueueV3::new(kv).drop_queue(&lot.search_key)?;
        }
        kv.forget(&lot_key(&lot.search_key))?;
        report.outcome = Some("finished");
        return Ok(report);
    }
    write(kv, &next, policy, now_ms)?;
    Ok(report)
}
/// LRU dos lotes em settle (`manageSettleLru`): os mais antigos saem, com a
/// memória de progresso limpa pelo PRÓPRIO `adapterId` do lote.
pub(crate) fn settle_lru(kv: &NativeKv, policy: Policy, now_ms: i64) -> Result<usize, String> {
    let lots: Vec<SettleLotRef> = load(kv, now_ms)?
        .into_iter()
        .map(|lot| SettleLotRef {
            search_key: lot.search_key,
            created_at: lot.created_at,
            info_hashes: lot.info_hashes,
            is_settle: lot.is_settle,
            adapter_id: lot.adapter_id,
        })
        .collect();
    let evicted = settle_lru_evictions(&lots, policy.max_settle_lots);
    for lot in &evicted {
        kv.forget(&lot_key(&lot.search_key))?;
    }
    Ok(evicted.len())
}

/// Lotes vivos (o dreno administrativo varre todos, sem esperar timer).
pub(crate) fn lots(kv: &NativeKv, now_ms: i64) -> Result<Vec<Lot>, String> {
    load(kv, now_ms)
}

/// Lotes que já pedem passagem (`due_at <= now`). O laço usa isto como timer.
pub(crate) fn due(kv: &NativeKv, policy: Policy, now_ms: i64) -> Result<Vec<Lot>, String> {
    let mut out = Vec::new();
    for lot in load(kv, now_ms)? {
        if due_at(&lot, policy) <= now_ms {
            out.push(lot);
        }
    }
    Ok(out)
}

#[cfg(test)]
#[path = "recheck_tests.rs"]
mod tests;
