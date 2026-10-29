//! Passagem de STATUS do lote de recheck — o miolo do `runRecheck` do Node.
//!
//! Separado de `recheck.rs` pela catraca de 400 linhas: aqui mora só o que
//! depende de rede (um `status` por passagem) e as decisões POR HASH que ele
//! alimenta — `ready`, morte/parada comprovada e o que continua no lote.
//!
//! Duas réguas do TS preservadas aqui (`git show HEAD:src/providers/`):
//!
//! 1. **Colapso terminal blacklista.** O `collapseTerminal` chamava
//!    `autofetch.blacklist(adapter.id, account, hash)` ANTES de decidir a
//!    remoção — para morto, parado e parada derivada, sem exceção
//!    (`autofetch-terminal.ts:103`). O `dead:` da conta é o que impede o hash
//!    de voltar à fila da próxima busca.
//! 2. **O modo de identificação do status é GRAVADO no lote.** O `via === 'id'`
//!    (`autofetch-recheck.ts:333` e `:361`) decide, junto com
//!    `DEBRID_REMOVE_BY_ID`, se o settle pode apagar: o settle não consulta o
//!    serviço, então `recheck_expire` lê o `via_id` daqui.
//!
//! A remoção direta no colapso (`adapter.removeTorrent` do TS) **não existe no
//! nativo**: quem remove é o settle, com prova de posse (`recheck_expire`).
//! Por isso o knob só tem efeito observável lá; aqui os campos entram honestos
//! (`expired: false` nesta passagem, então o ramo da expiração não roda).
//!
//! 3. **Parada DERIVADA por progresso** (`deriveStall`, Fase 3 do Chupim): o
//!    `TerminalProgress` deixa de ser inalcançável — a leitura de
//!    `progress`/`state`/`id` de cada hash passa por `derive_stall`
//!    (`adom-autofetch/src/v3/recheck.rs`) e o colapso segue o MESMO caminho
//!    dos outros terminais, mais a represa que o modo `progress` exige
//!    (`autofetch-terminal.ts:100-107`: nunca remoção direta).

use adom_autofetch::v3::{
    derive_stall, recheck_step, recheck_streaks, ProgressObservation, QueueV3, RecheckAction,
    RecheckInput, SuppressedV3,
};
use adom_index::NativeKv;

use super::recheck::{write, Lot, StepReport, DEAD_THRESHOLD};
use super::Policy;

/// Uma passagem de status do lote. `dead:` da conta para morte comprovada;
/// ausência de resposta não é prova de nada.
pub(super) async fn poll(
    kv: &NativeKv,
    policy: Policy,
    debrid: &dyn adom_autofetch::v3::AutofetchDebrid<Error = String>,
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
        // Parada DERIVADA por progresso (`deriveStall`,
        // `src/providers/autofetch-progress.ts:57`): o limiar é contado AQUI,
        // dentro da regra, e o veredito entra no `recheck_step` como fato — hash
        // que volta marcado colapsa sem novo streak (`autofetch-recheck.ts:266`).
        // Sem `progress` no status (serviço que não mede bytes) a resposta é
        // `NoSignal`: memória intocada e NADA terminal (fail-safe).
        let verdict = derive_stall(&ProgressObservation {
            state: evidence.map(|item| item.state.as_str()),
            progress: evidence.and_then(|item| item.progress.as_ref()),
            transfer_id: evidence.and_then(|item| item.transfer_id.as_deref()),
            memory: lot.progress.get(hash),
            threshold: policy.stall_streak,
            now_ms,
        });
        if let Some(memory) = verdict.memory() {
            next.progress.insert(hash.clone(), memory.clone());
        }
        let input = RecheckInput {
            cached: false,
            status_ok: evidence.is_some(),
            state: evidence.map(|item| item.state.clone()),
            stalled: evidence.is_some_and(|item| item.stalled),
            derived_stalled: verdict.is_stalled(),
            dead_streak: *lot.dead_streak.get(hash).unwrap_or(&0),
            stall_streak: *lot.stall_streak.get(hash).unwrap_or(&0),
            dead_threshold: DEAD_THRESHOLD,
            stall_threshold: policy.stall_streak,
            expired: false,
            expired_facts: super::recheck_expire::expired_facts(false, false, false),
            remove_supported: true,
            // `via === 'id'`: só o id identificou a transferência. O gate do
            // knob mora no settle (`recheck_expire`); aqui o fato é gravado no
            // lote logo abaixo para chegar lá.
            via_id: evidence.is_some_and(|item| item.via_id),
            remove_by_id_enabled: policy.remove_by_id,
            id_present: lot.transfers.contains_key(hash),
        };
        let action = recheck_step(&input);
        let streaks = recheck_streaks(&input);
        // Último status MANDA: o `via` do settle é o da observação mais recente,
        // e hash que voltou a ser visto por hash deixa de ser "só por id".
        next.via_id.remove(hash);
        if input.via_id {
            next.via_id.insert(hash.clone());
        }
        next.dead_streak.insert(hash.clone(), streaks.dead);
        next.stall_streak.insert(hash.clone(), streaks.stalled);
        match action {
            RecheckAction::Ready => {
                report.resolved += 1;
                // Fato do PACK: o release pronto leva título e obra declarada
                // para fora da passagem — quem invalida é o laço.
                if let Some(hint) = lot.season_hints.get(hash) {
                    report.ready.push(hint.clone());
                }
            }
            // Morto E parado: `mark_dead` nos dois, como o `blacklist` que o
            // `collapseTerminal` do TS fazia antes de qualquer decisão de
            // remoção. Sem isso o hash parado volta ao lote na passagem
            // seguinte e o `dead:` da conta subnotifica.
            RecheckAction::TerminalDead | RecheckAction::TerminalStalled => {
                collapse(kv, &queue, policy, lot, hash, now_ms)?;
                // Os contadores continuam separados, como os do TS
                // (`autofetch.dead` x `autofetch.stalled`): `dead` é morte
                // COMPROVADA, parada é outra evidência.
                report.dead += usize::from(action == RecheckAction::TerminalDead);
                report.resolved += usize::from(action == RecheckAction::TerminalStalled);
                report.terminal = true;
            }
            // Parada DERIVADA por progresso (`deriveStall`, Fase 3): mesmo
            // colapso dos outros terminais e, como no TS, NUNCA remoção direta
            // (`autofetch-terminal.ts:100-107`) — com id da transferência o hash
            // entra na represa (`sup:`) e a limpeza fica com o dreno/painel.
            RecheckAction::TerminalProgress => {
                collapse(kv, &queue, policy, lot, hash, now_ms)?;
                if let Some(id) = evidence.and_then(|item| item.transfer_id.as_deref()) {
                    SuppressedV3::new(kv).note(
                        &lot.adapter_id,
                        &lot.account,
                        hash,
                        id,
                        policy.lot_ttl_seconds,
                        now_ms,
                    )?;
                    report.suppressed += 1;
                }
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
    next.season_hints.retain(|hash, _| kept.contains(hash));
    next.via_id.retain(|hash| kept.contains(hash));
    // `cleanLotHash` do TS (`autofetch-terminal.ts:52-58`) apaga a memória de
    // progresso do hash que SAIU: hash reenfileirado não pode herdar streak
    // residual de outra janela.
    next.progress.retain(|hash, _| kept.contains(hash));
    report.remaining = kept.len();
    if kept.is_empty() {
        // Terminal (morto/parado) NÃO derruba a fila: é dela que sai o próximo
        // candidato do dreno. Só o lote que esvaziou sem terminal (tudo pronto)
        // fecha o ciclo da busca e apaga a fila — a ordem do Node.
        if !report.terminal {
            QueueV3::new(kv).drop_queue(&lot.search_key)?;
        }
        kv.forget(&super::lot_key(&lot.search_key))?;
        report.outcome = Some("finished");
        return Ok(report);
    }
    write(kv, &next, policy, now_ms)?;
    Ok(report)
}

/// `collapseTerminal` (`src/providers/autofetch-terminal.ts:90-131`) na parte
/// que o nativo tem: blacklist do hash, esquecimento do registro do Chupim e a
/// liberação da retenção viva (hold volátil + proteção durável do pool BR).
///
/// A DECISÃO de remoção fica de fora de propósito: no nativo quem apaga é o
/// settle, com prova de posse (`recheck_expire`).
fn collapse(
    kv: &NativeKv,
    queue: &QueueV3<'_>,
    policy: Policy,
    lot: &Lot,
    hash: &str,
    now_ms: i64,
) -> Result<(), String> {
    queue.mark_dead(
        &lot.adapter_id,
        &lot.account,
        hash,
        policy.dead_ttl_seconds,
        now_ms,
    )?;
    // `collapseTerminal` apagava o registro do Chupim no MESMO ponto
    // (`autofetch-terminal.ts:95`): hash que morreu/parou não pode seguir
    // ligando a via rápida do índice para uma transferência que não existe
    // mais. A obra vem do hint do lote (o status do debrid não carrega IMDb) e
    // vai pelo canal do escritor — sem I/O nesta thread.
    super::index_record::forget(
        lot.season_hints
            .get(hash)
            .and_then(|hint| hint.imdb_id.as_deref()),
        hash,
    );
    release_retention(kv, &lot.adapter_id, &lot.account, hash)
}

/// `held.unprotect` + `held.release` do colapso (`autofetch-terminal.ts:96-97`)
/// sobre as DUAS chaves que as guardas de limpeza leem
/// (`suppressed_guard.rs:67,74`).
///
/// `protected.ts:21-22` é explícito: só o estado terminal destrava a retenção
/// durável — sem esta limpeza um hash morto/travado barra a própria remoção para
/// sempre. Idempotente: `kv.forget` de chave ausente devolve `false`.
fn release_retention(
    kv: &NativeKv,
    adapter: &str,
    account: &str,
    hash: &str,
) -> Result<(), String> {
    let account = account.trim().to_ascii_lowercase();
    let hash = hash.trim().to_ascii_lowercase();
    if account.is_empty() || hash.is_empty() {
        return Ok(());
    }
    kv.forget(&format!("adhold:v1:{account}:{hash}"))?;
    let adapter = adapter.trim().to_ascii_lowercase();
    kv.forget(&format!("adprot:v1:{adapter}:{account}:{hash}"))?;
    Ok(())
}
