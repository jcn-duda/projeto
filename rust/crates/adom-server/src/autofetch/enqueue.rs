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
//! Peças vizinhas: itens/candidato em [`super::enqueue_items`], gates vivos em
//! [`gates`], medição em [`facts`], teto por obra e encerramento em [`obra`],
//! entrada em [`Job`] e saída em [`Report`].

use std::collections::HashSet;

use adom_autofetch::v3::{cascade, marker_value, QueueV3};
use adom_core::{can_auto_fetch_br, classify_enqueue, rollback_for, EnqueueGates};
use adom_index::NativeKv;
use serde_json::Value;

use super::enqueue_items::{candidate_of, parse_items, season_hints};
use super::Policy;
#[path = "enqueue_account.rs"]
mod account;
#[path = "enqueue_holds.rs"]
mod holds;
pub(super) use holds::Holds;

#[path = "enqueue_facts.rs"]
pub(super) mod facts;

#[path = "enqueue_gates.rs"]
pub(super) mod gates;

#[path = "enqueue_job.rs"]
mod job;
pub(crate) use job::Job;

#[path = "enqueue_obra.rs"]
pub(super) mod obra;

#[path = "enqueue_pick.rs"]
mod pick;

#[path = "enqueue_report.rs"]
mod report;
pub(crate) use report::Report;

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
    // Fatos do PACK: o status do debrid nunca traz título, então eles precisam
    // sair daqui com o lote do recheck.
    let hints = season_hints(&items, payload);

    let live = gates::LivePolicy::load(kv, adapter, now_ms)?;

    // Gate MESTRE do TS (`autofetch-candidates.ts:104`): com `autoFetchBr`
    // desligado `autoFetchCandidates` devolve `[]` ANTES de escolher pool —
    // nada de hold, marker, fila ou chamada ao serviço. Fica antes do hold de
    // propósito: lote desligado não prende hash nem escreve.
    // `cacheCheck`/`autofetchSource` do adaptador são sempre verdadeiros aqui
    // (só chega neste worker quem implementa `check`; a divergência está
    // declarada em [`obra`]), então a régua do núcleo reduz a `autoFetchBr`.
    if !can_auto_fetch_br(live.br_enabled, true, true) {
        return Ok(Report::refused(&search_key, "disabled"));
    }

    // 1. Hold ANTES da checagem. Só a chamada que adquiriu o hold pode usar ou
    // soltar esse hash; uma busca concorrente mantém a própria proteção.
    let mut seen = HashSet::new();
    let mut hashes: Vec<String> = Vec::new();
    for item in &items {
        if seen.insert(item.info_hash.clone()) && holds.acquire(account, &item.info_hash) {
            hashes.push(item.info_hash.clone());
        }
    }
    if hashes.is_empty() {
        return Ok(Report::refused(&search_key, "in-flight"));
    }

    // O applyDebrid já mediu esse mesmo universo; known=false encerra sem uma
    // segunda pergunta ao serviço, como `autoFetchBrDubbed` no TS.
    if payload.get("known").and_then(Value::as_bool) == Some(false) {
        release_all(holds, account, &hashes);
        return Ok(Report::refused(&search_key, "unknown-cache"));
    }

    let queue = QueueV3::new(kv);
    let mut report = Report {
        search_key: search_key.clone(),
        season_hints: hints,
        ..Report::default()
    };

    // 2. Checagem de cache: sem ela não há cascata (`known == false`).
    let evidence = match debrid.check(&hashes).await {
        Ok(evidence) => evidence,
        Err(_) => {
            release_all(holds, account, &hashes);
            return Err("checagem de cache falhou".to_string());
        }
    };
    if !evidence.known {
        release_all(holds, account, &hashes);
        return Ok(Report::refused(&search_key, "unknown-cache"));
    }
    let eligible: HashSet<&str> = hashes.iter().map(String::as_str).collect();
    let cached: HashSet<String> = evidence
        .cached
        .iter()
        .map(|hash| hash.to_ascii_lowercase())
        .collect();

    // 3. Fatos da cascata: orçamento, sonda da conta, cache por hash e `adrm`
    // (invariante 6). O teto por OBRA tem portão próprio no passo 4 — medir os
    // dois aqui daria duas réguas para a mesma pergunta.
    //
    // A sonda de conta é MEMOIZADA no KV por `autoFetchPauseRefreshMs`
    // ([`account::probe`]): sem o memo o worker pergunta a conta a cada lote,
    // enquanto o TS só a cada janela de `accountGateMemo`.
    let account_used = if live.pause_at > 0 {
        account::probe(kv, adapter, account, debrid, live.pause_refresh_ms, now_ms).await
    } else {
        None
    };
    let measured = match facts::measure(facts::Measure {
        kv,
        adapter,
        account,
        live: &live,
        paused,
        account_used,
        items: &items,
        eligible: &eligible,
        cached: &cached,
        hashes: &hashes,
        now_ms,
    }) {
        Ok(measured) => measured,
        Err(err) => {
            release_all(holds, account, &hashes);
            return Err(err);
        }
    };
    let mut facts = measured.facts;
    let adrm_blocked = measured.adrm;

    // Candidatos e teto imediato em [`pick`]: lá mora o `pickSeedsPool` do pool
    // `seeds` (`minSeeders`/`ptFirst`/regime raro) e a marca `adrm`.
    let picked = match pick::pick(pick::PickInput {
        kv,
        adapter,
        account,
        live: &live,
        items: &items,
        eligible: &eligible,
        cached: &cached,
        adrm: &adrm_blocked,
        season: payload.get("season").and_then(Value::as_i64),
        now_ms,
    }) {
        Ok(picked) => picked,
        Err(err) => {
            release_all(holds, account, &hashes);
            return Err(err);
        }
    };
    let by_hash = picked.by_hash;
    let candidates = picked.candidates;
    facts.slots = picked.slots;

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

    // 4. Portões por candidato: marker/blacklist do KV, teto por OBRA e o
    // enqueue de verdade. A config do teto sai uma vez por lote das mesmas
    // réguas do TS.
    let obra_cfg = obra::live_config(&live);
    let mut queue_out = Vec::with_capacity(items.len());
    for attempt in &decision.attempts {
        let Some(item) = by_hash.get(attempt.info_hash.as_str()) else {
            continue;
        };
        let candidate = candidate_of(attempt, item, payload, now_ms);
        let marker_active = match queue.marker(adapter, account, &attempt.info_hash, now_ms) {
            Ok(marker) => marker.is_some(),
            Err(err) => {
                release_all(holds, account, &hashes);
                return Err(err);
            }
        };
        // Ordem do TS (`autofetch-gates.ts:57`): `marker` vem ANTES do teto por
        // obra. Só quem passou dos portões anteriores pede a reserva — reserva
        // pedida e não usada ficaria presa pelo lease de 60 s.
        let obra_gate = if marker_active {
            obra::Gate::Skipped
        } else {
            let identity = obra::identity(adapter, account, payload, item, live.season_fill);
            match holds
                .obra()
                .reserve(kv, &identity, &obra_cfg, attempt, now_ms)
            {
                Ok(gate) => gate,
                Err(err) => {
                    release_all(holds, account, &hashes);
                    return Err(err);
                }
            }
        };
        let gates = EnqueueGates {
            is_paused: paused,
            is_dead: false,
            is_cached: cached.contains(&attempt.info_hash),
            marker_active,
            // `false` = teto da obra fechado nesta janela (o `reserveObra`
            // devolveu `null`).
            obra_cap_granted: !matches!(obra_gate, obra::Gate::Closed),
            ..EnqueueGates::default()
        };
        match classify_enqueue(&gates) {
            Some(reason) => {
                obra::rollback(
                    holds,
                    account,
                    &attempt.info_hash,
                    rollback_for(reason),
                    &obra_gate,
                );
                report.skip(reason.as_str());
            }
            None => match gates::reserve_budget(kv, adapter, account, live.hourly_limit, now_ms) {
                Err(err) => {
                    release_all(holds, account, &hashes);
                    return Err(err);
                }
                Ok(false) => {
                    // Orçamento cheio é backoff, não recusa: vaga da obra e hold
                    // voltam (`budget` = obra+lock+slot+hold, `autofetch-gates.ts:95`).
                    obra::refuse(holds, account, &attempt.info_hash, &obra_gate);
                    report.skip("budget");
                }
                Ok(true) => match debrid.enqueue(&candidate).await {
                    Ok(evidence) if evidence.accepted => {
                        // Marker com a meta de `evictMarkerMeta`
                        // (`autofetch-runner.ts:109-113`): o `obra` é o DIGEST
                        // do lease, o mesmo da chave do registro por obra — é
                        // o que faz a evicção dirigida reconhecer este aceite
                        // como da obra (`evict_job`, `marker_matches_work`).
                        let meta = obra::marker_meta(
                            adapter,
                            payload,
                            item,
                            attempt,
                            obra_gate.digest(),
                            now_ms,
                        );
                        if let Err(err) = queue.set_marker(
                            adapter,
                            account,
                            &attempt.info_hash,
                            &marker_value(
                                true,
                                evidence.transfer_id.as_deref(),
                                meta.as_ref(),
                                now_ms,
                            ),
                            policy.marker_ttl_seconds,
                            now_ms,
                        ) {
                            release_all(holds, account, &hashes);
                            return Err(err);
                        }
                        // Aceite confirmado: o hash vira entrada DURÁVEL da obra
                        // (`commitObra`), com o id do transfer. Reserva recusada
                        // nunca é persistida.
                        if let Err(err) = obra::commit_obra(
                            holds,
                            kv,
                            &obra_gate,
                            attempt,
                            item,
                            evidence.transfer_id.as_deref(),
                            live.obra_ttl_seconds,
                            now_ms,
                        ) {
                            release_all(holds, account, &hashes);
                            return Err(err);
                        }
                        report
                            .enqueued
                            .push((attempt.info_hash.clone(), evidence.transfer_id));
                        // Ciclo fechado: o aceite vira registro `source:autofetch`
                        // no índice (visibilidade, nunca cobertura BR).
                        super::index_record::keep(attempt, item, payload, &mut report);
                    }
                    // Falha de rede/serviço: o hash fica na fila, sem marker, e
                    // `releaseObra` + `held.release` voltam (`autofetch-runner.ts:163-165`).
                    Ok(_) | Err(_) => {
                        obra::refuse(holds, account, &attempt.info_hash, &obra_gate);
                        report.skip("enqueue-error");
                    }
                },
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
    report.queue_len = if live.queue_enabled {
        queue_out.len()
    } else {
        0
    };
    if !live.queue_enabled || live.queue_depth == 0 || queue_out.is_empty() {
        if let Err(err) = queue.drop_queue(&search_key) {
            release_all(holds, account, &hashes);
            return Err(err);
        }
    } else if let Err(err) = queue.write_queue(
        &search_key,
        &queue_out,
        policy.queue_ttl_seconds,
        live.queue_depth,
        Some((adapter, account)),
        now_ms,
    ) {
        release_all(holds, account, &hashes);
        return Err(err);
    }
    release_all(holds, account, &hashes);
    Ok(report)
}

fn release_all(holds: &Holds, account: &str, hashes: &[String]) {
    for hash in hashes {
        holds.release(account, hash);
    }
}

#[cfg(test)]
#[path = "enqueue_tests.rs"]
mod tests;
