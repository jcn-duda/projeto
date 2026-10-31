//! Auditoria de arquivos, reenfileiramento e limpeza de estrangeiro provado do
//! catálogo (porte de `auditBackfillEnv`, `auditRequeueEnv`, `cleanupPreviewEnv`
//! e `cleanupApplyEnv`). A fila da auditoria é o próprio catálogo (`audited_at`).

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use adom_catalog::audit::{
    mark_audited_unless_condemned, note_audit, requeue_audit, rows_needing_audit, AuditFile,
    AuditLists, AuditTarget,
};
use serde_json::{json, Value};
use tokio::task::JoinSet;

use super::ops::{blocking, cap, fail, foreign_plan, run_deletions, Deps};
use super::port::CatalogFile;
use crate::dub_audit::now_ms;
use adom_catalog::dedup::Deletion;

/// Contagens de uma rodada de auditoria (somadas entre os workers).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct AuditCount {
    scanned: u64,
    evidenced: u64,
    failed: u64,
}

impl AuditCount {
    fn add(&mut self, other: AuditCount) {
        self.scanned += other.scanned;
        self.evidenced += other.evidenced;
        self.failed += other.failed;
    }
}

/// Auditoria em fundo: prova os arquivos das linhas sem evidência de áudio.
/// `max` e `concurrency` vêm da rota; sem eles valem os knobs do env.
pub(super) async fn audit(deps: Arc<Deps>, max: Option<i64>, concurrency: Option<i64>) -> Value {
    let teto = usize::try_from(max.unwrap_or(deps.knobs.audit_max).max(0)).unwrap_or(usize::MAX);
    let workers = concurrency
        .unwrap_or(deps.knobs.audit_concurrency)
        .clamp(1, 3) as usize;
    let d = deps.clone();
    let rows = match blocking(move || {
        let file_evidence = |hash: &str| d.facts.file_evidence(hash);
        rows_needing_audit(&d.store, &d.adapter, &d.account, Some(teto), &file_evidence)
            .map_err(|err| err.to_string())
    })
    .await
    {
        Ok(rows) => rows,
        Err(err) => return fail("auditoria", err),
    };
    let rows = Arc::new(rows);
    let next = Arc::new(AtomicUsize::new(0));
    let mut set = JoinSet::new();
    for _ in 0..workers {
        set.spawn(audit_worker(deps.clone(), rows.clone(), next.clone()));
    }
    let mut total = AuditCount::default();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(count) => total.add(count),
            Err(_) => total.failed += 1,
        }
    }
    json!({
        "ok": true,
        "scanned": total.scanned,
        "evidenced": total.evidenced,
        "failed": total.failed,
    })
}

/// Um worker: pega a próxima linha da fila até acabar. Falha de uma linha conta
/// em `failed` e o laço segue (uma linha ruim não derruba a rodada).
async fn audit_worker(
    deps: Arc<Deps>,
    rows: Arc<Vec<AuditTarget>>,
    next: Arc<AtomicUsize>,
) -> AuditCount {
    let mut count = AuditCount::default();
    loop {
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some(row) = rows.get(index) else {
            break;
        };
        let files = match deps.port.files(row.service_id.clone()).await {
            Ok(files) => files,
            Err(err) => {
                count.failed += 1;
                eprintln!(
                    "[catalog] auditoria do magnet {} falhou: {err}",
                    row.service_id
                );
                continue;
            }
        };
        count.scanned += 1;
        let (d, target) = (deps.clone(), row.clone());
        match blocking(move || apply_evidence(&d, &target, &files)).await {
            Ok(true) => count.evidenced += 1,
            Ok(false) => {}
            Err(err) => {
                count.failed += 1;
                eprintln!(
                    "[catalog] auditoria do magnet {} falhou: {err}",
                    row.service_id
                );
            }
        }
    }
    count
}

/// Grava o que a leitura dos arquivos provou. Lista vazia só marca como
/// auditada se NÃO há condenação só pelo título (ver `mark_audited_unless_condemned`).
/// Devolve `true` quando a linha ganhou prova de arquivo.
fn apply_evidence(d: &Deps, row: &AuditTarget, files: &[CatalogFile]) -> Result<bool, String> {
    let now = now_ms();
    if files.is_empty() {
        mark_audited_unless_condemned(&d.store, &d.adapter, &d.account, &row.service_id, now)
            .map_err(|err| err.to_string())?;
        return Ok(false);
    }
    d.facts.record_evidence(&row.hash, files);
    let audit_files: Vec<AuditFile> = files
        .iter()
        .map(|file| AuditFile {
            path: Some(file.path.clone()),
        })
        .collect();
    let (pt, en) = d.facts.audio_lists();
    let pt_refs: Vec<&str> = pt.iter().map(String::as_str).collect();
    let en_refs: Vec<&str> = en.iter().map(String::as_str).collect();
    let lists = AuditLists {
        pt_markers: &pt_refs,
        en_groups: &en_refs,
    };
    note_audit(
        &d.store,
        &d.adapter,
        &d.account,
        &row.service_id,
        &audit_files,
        now,
        &lists,
    )
    .map_err(|err| err.to_string())?;
    Ok(true)
}

/// Devolve à fila as linhas cuja evidência de arquivo expirou. Sem rede.
pub(super) async fn audit_requeue(deps: Arc<Deps>, max: Option<i64>) -> Value {
    let d = deps.clone();
    let result = blocking(move || {
        let file_evidence = |hash: &str| d.facts.file_evidence(hash);
        let limit = max.map(|m| usize::try_from(m.max(0)).unwrap_or(usize::MAX));
        requeue_audit(&d.store, &d.adapter, &d.account, limit, &file_evidence)
            .map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(out) => json!({
            "ok": true,
            "requeued": out.requeued,
            "keptWithEvidence": out.kept_with_evidence,
            "alreadyQueued": out.already_queued,
        }),
        Err(err) => fail("audit-requeue", err),
    }
}

/// Acervo que já era da conta, para a limpeza. Sem snapshot, a limpeza sem
/// `includeKnown` fica fechada (`inventario-frio`): ausência de referência
/// nunca autoriza remoção. Devolve `Err(resposta)` quando deve parar.
async fn known_or_refuse(
    deps: &Deps,
    include_known: bool,
) -> Result<Option<HashSet<String>>, Value> {
    let known = deps
        .port
        .known_before()
        .await
        .map_err(|err| fail("inventário", err))?;
    if !include_known && known.is_none() {
        return Err(json!({ "ok": false, "reason": "inventario-frio" }));
    }
    Ok(known)
}

/// Plano da limpeza de estrangeiro provado (leitura pura).
pub(super) async fn cleanup_preview(deps: Arc<Deps>, include_known: bool) -> Value {
    let known = match known_or_refuse(&deps, include_known).await {
        Ok(known) => known,
        Err(refusal) => return refusal,
    };
    match foreign_plan(deps, known, include_known).await {
        Ok(plan) => json!({ "ok": true, "targets": plan.targets, "skipped": plan.skipped }),
        Err(err) => fail("cleanup-preview", err),
    }
}

/// Aplica a limpeza de estrangeiro provado, com teto `max` opcional.
pub(super) async fn cleanup_apply(deps: Arc<Deps>, max: Option<i64>, include_known: bool) -> Value {
    let known = match known_or_refuse(&deps, include_known).await {
        Ok(known) => known,
        Err(refusal) => return refusal,
    };
    let plan = match foreign_plan(deps.clone(), known, include_known).await {
        Ok(plan) => plan,
        Err(err) => return fail("cleanup-apply", err),
    };
    let list: Vec<Deletion> = cap(plan.targets, max)
        .into_iter()
        .map(|t| Deletion {
            service_id: t.service_id,
            hash: t.hash,
            reason: t.reason,
            filename: Some(t.filename),
            skip_mark: false,
        })
        .collect();
    let total = list.len();
    match run_deletions(deps, list).await {
        Ok(out) => json!({ "ok": true, "total": total, "deleted": out.ok, "falhas": out.falhas }),
        Err(err) => fail("cleanup-apply", err),
    }
}
