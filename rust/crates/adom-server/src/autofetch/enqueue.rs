//! Enfileiramento do lote `autofetch_batch` — ESCRITOR ÚNICO da fila v3.
//!
//! O lote chega do canal com os FATOS medidos pela busca (itens, `known`,
//! `searchKey`) e o escopo da conta (`adapter:sha256`). Aqui ele vira:
//!
//! 1. **hold ANTES da checagem** (invariante 6): o hash é preso em memória antes
//!    de `check`, então a checagem de cache e o `enqueue` não podem ser
//!    atropelados por um evict/settle no meio;
//! 2. **fatos da cascata** — cache por hash, cobertura por qualidade-alvo,
//!    dublado BR/global e o piso de seeders (o waiver vem marcado do pipeline);
//! 3. [`cascade`] (`adom_autofetch::v3`) → `attempts` / `deferred` / `dropped`;
//! 4. cada `attempt` passa pelos portões de [`classify_enqueue`] com o marker e a
//!    blacklist LIDOS do KV; desistência aplica [`rollback_for`] (hold/lock/vaga/
//!    obra) e conta o motivo;
//! 5. a fila (`autofetch:v3:q:`) é regravada como `attempts ∪ deferred` — o
//!    adiado NUNCA se perde, e o aceito continua lá para o dreno enxergar (o
//!    marker é quem evita o enfileiramento duplo).
//!
//! Cache DESCONHECIDO (`known == false`) não escreve nada: sem saber o que já
//! toca, a fila anterior é o único backup que existe. Ela fica intacta e o lote
//! é contado como `unknown-cache`.
//!
//! O `AutofetchDebrid` entra como `&dyn` já resolvido pela fábrica por conta
//! (o laço resolve `scope` → adaptador a cada passo); este módulo nunca vê a
//! chave — quem a tem é o cofre.
//!
//! Peças vizinhas: itens/candidato em [`super::enqueue_items`], dreno do próximo
//! em [`super::enqueue_drain`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, PoisonError};

use adom_autofetch::v3::{cascade, marker_value, CascadeCandidate, CascadeFacts, QueueV3};
use adom_core::{classify_enqueue, rollback_for, EnqueueGates, RollbackAction};
use adom_index::NativeKv;
use serde_json::{Map, Value};

use super::enqueue_items::{candidate_of, parse_items};
use super::Policy;

/// Trabalho que chega pelo canal: o escopo da conta e o payload do efeito.
#[derive(Clone, Debug)]
pub(crate) struct Job {
    /// `adapter:sha256(chave)` — o escopo do cofre, nunca a chave.
    pub(crate) scope: String,
    pub(crate) payload: Map<String, Value>,
}

impl Job {
    fn parts(&self) -> Option<(&str, &str)> {
        let (adapter, account) = self.scope.split_once(':')?;
        (!adapter.is_empty() && !account.is_empty()).then_some((adapter, account))
    }
}

/// Hashes presos pela seleção (o `held` do Node). Em memória: o hold morre com
/// o processo, como o hold volátil do Node.
#[derive(Default)]
pub(crate) struct Holds {
    inner: Mutex<HashSet<String>>,
}

impl Holds {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `true` quando o hash passou a estar preso por ESTA chamada.
    pub(crate) fn acquire(&self, hash: &str) -> bool {
        !hash.is_empty() && self.lock().insert(hash.to_ascii_lowercase())
    }

    pub(crate) fn release(&self, hash: &str) -> bool {
        self.lock().remove(&hash.to_ascii_lowercase())
    }

    /// Profundidade do hold. Só os testes leem hoje (o painel da próxima leva
    /// conta a fila, não o hold).
    #[allow(dead_code)]
    pub(crate) fn len(&self) -> usize {
        self.lock().len()
    }
}

/// Resultado de um lote: o que foi aceito, o que ficou na fila e os motivos.
#[derive(Debug, Default)]
pub(crate) struct Report {
    pub(crate) search_key: String,
    /// Hashes aceitos pelo debrid, com o id do transfer (vão para o lote).
    pub(crate) enqueued: Vec<(String, Option<String>)>,
    pub(crate) attempts: usize,
    pub(crate) deferred: usize,
    pub(crate) dropped: usize,
    pub(crate) queue_len: usize,
    /// Motivo de desistência → contagem (`autofetch.skip.<motivo>`).
    pub(crate) skips: BTreeMap<String, usize>,
    /// Lote inteiro recusado por um motivo só (sem escrita nenhuma).
    pub(crate) refused: Option<&'static str>,
}

impl Report {
    fn skip(&mut self, label: &str) {
        *self.skips.entry(label.to_string()).or_default() += 1;
    }

    fn refused(search_key: &str, label: &'static str) -> Self {
        Self {
            search_key: search_key.to_string(),
            refused: Some(label),
            ..Self::default()
        }
    }
}

/// Executa um lote inteiro. Devolve `Err` só em falha de store/rede que impede
/// decidir; payload fora da forma vira `Report::refused` (sem escrita).
pub(crate) async fn run(
    kv: &NativeKv,
    policy: Policy,
    holds: &Holds,
    paused: bool,
    debrid: &dyn adom_autofetch::v3::AutofetchDebrid<Error = String>,
    job: &Job,
    now_ms: i64,
) -> Result<Report, String> {
    let payload = &job.payload;
    let search_key = payload
        .get("searchKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if search_key.is_empty() {
        return Ok(Report::refused(&search_key, "no-search-key"));
    }
    let Some((adapter, account)) = job.parts() else {
        return Ok(Report::refused(&search_key, "no-scope"));
    };
    let items = parse_items(payload);
    if items.is_empty() {
        return Ok(Report::refused(&search_key, "empty-batch"));
    }

    // 1. Hold ANTES da checagem, com todos os hashes do lote.
    let mut seen = HashSet::new();
    let mut hashes: Vec<String> = Vec::new();
    for item in &items {
        if seen.insert(item.info_hash.clone()) {
            hashes.push(item.info_hash.clone());
        }
    }
    for hash in &hashes {
        holds.acquire(hash);
    }

    let queue = QueueV3::new(kv);
    let mut report = Report {
        search_key: search_key.clone(),
        ..Report::default()
    };

    // 2. Checagem de cache: sem ela não há cascata (`known == false`).
    let evidence = match debrid.check(&hashes).await {
        Ok(evidence) => evidence,
        Err(_) => {
            release_all(holds, &hashes);
            return Err("checagem de cache falhou".to_string());
        }
    };
    if !evidence.known {
        release_all(holds, &hashes);
        return Ok(Report::refused(&search_key, "unknown-cache"));
    }
    let cached: HashSet<String> = evidence
        .cached
        .iter()
        .map(|hash| hash.to_ascii_lowercase())
        .collect();

    // 3. Fatos da cascata. O que o worker ainda não mede (sonda, seeds stop,
    // teto por obra) entra no default do crate — que não bloqueia nada.
    let mut facts = CascadeFacts {
        paused,
        cache_known: true,
        slots: policy.max_attempts,
        ..CascadeFacts::default()
    };
    facts.has_cached_br_dubbed = items
        .iter()
        .any(|item| item.br && item.dubbed && cached.contains(&item.info_hash));
    facts.has_cached_any_dubbed = items
        .iter()
        .any(|item| item.dubbed && cached.contains(&item.info_hash));
    facts.covered_qualities = items
        .iter()
        .filter(|item| item.br && item.dubbed && cached.contains(&item.info_hash))
        .filter_map(|item| item.quality.clone())
        .collect();

    let mut by_hash: HashMap<&str, &super::enqueue_items::Item> = HashMap::new();
    let mut candidates = Vec::with_capacity(items.len());
    for item in &items {
        by_hash.insert(item.info_hash.as_str(), item);
        candidates.push(CascadeCandidate {
            info_hash: item.info_hash.clone(),
            pool: item.pool(),
            quality: item.quality.clone(),
            slot_limit: None,
            rare: false,
            cached: cached.contains(&item.info_hash),
            dead: queue.is_dead(adapter, account, &item.info_hash, now_ms)?,
            adrm: false,
            // O piso de seeders já foi aplicado na lista; o waiver é a exceção.
            viable: !item.waived,
        });
    }

    let decision = cascade(&facts, candidates);
    report.attempts = decision.attempts.len();
    report.deferred = decision.deferred.len();
    report.dropped = decision.dropped.len();
    for dead in &decision.dropped {
        report.skip(dead.reason.as_str());
    }
    for deferred in &decision.deferred {
        report.skip(deferred.reason.as_str());
    }

    // 4. Portões por candidato: marker/blacklist do KV + o enqueue de verdade.
    let mut queue_out = Vec::with_capacity(items.len());
    for attempt in &decision.attempts {
        let Some(item) = by_hash.get(attempt.info_hash.as_str()) else {
            continue;
        };
        let candidate = candidate_of(attempt, item, payload, now_ms);
        let gates = EnqueueGates {
            is_paused: paused,
            is_dead: false,
            is_cached: cached.contains(&attempt.info_hash),
            marker_active: queue
                .marker(adapter, account, &attempt.info_hash, now_ms)?
                .is_some(),
            ..EnqueueGates::default()
        };
        match classify_enqueue(&gates) {
            Some(reason) => {
                rollback(holds, &attempt.info_hash, rollback_for(reason));
                report.skip(reason.as_str());
            }
            None => match debrid.enqueue(&candidate).await {
                Ok(evidence) if evidence.accepted => {
                    queue.set_marker(
                        adapter,
                        account,
                        &attempt.info_hash,
                        &marker_value(true, evidence.transfer_id.as_deref(), None, now_ms),
                        policy.marker_ttl_seconds,
                        now_ms,
                    )?;
                    report
                        .enqueued
                        .push((attempt.info_hash.clone(), evidence.transfer_id));
                }
                // Falha de rede/serviço: o hash fica na fila, sem marker.
                Ok(_) | Err(_) => report.skip("enqueue-error"),
            },
        }
        queue_out.push(candidate);
    }
    for deferred in decision.deferred {
        if let Some(item) = by_hash.get(deferred.candidate.info_hash.as_str()) {
            queue_out.push(candidate_of(&deferred.candidate, item, payload, now_ms));
        }
    }

    // 5. Fila: `attempts ∪ deferred`, escritor único. O corte por profundidade
    // é do `write_queue` (mesma régua do `writeQueue` do Node).
    report.queue_len = queue_out.len();
    if queue_out.is_empty() {
        queue.drop_queue(&search_key)?;
    } else {
        queue.write_queue(
            &search_key,
            &queue_out,
            policy.queue_ttl_seconds,
            policy.queue_depth,
            Some((adapter, account)),
            now_ms,
        )?;
    }
    release_all(holds, &hashes);
    Ok(report)
}

fn release_all(holds: &Holds, hashes: &[String]) {
    for hash in hashes {
        holds.release(hash);
    }
}

/// Aplica a tabela do `rollbackFor`: só o hold existe neste worker (lock/vaga/
/// obra são do dreno da próxima leva), mas o mapa é lido do núcleo para o
/// motivo `in-flight` continuar NÃO soltando o hold.
fn rollback(holds: &Holds, hash: &str, actions: &[RollbackAction]) {
    if actions.contains(&RollbackAction::Hold) {
        holds.release(hash);
    }
}

#[cfg(test)]
#[path = "enqueue_tests.rs"]
mod tests;
