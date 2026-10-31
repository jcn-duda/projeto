//! Orquestração do catálogo da conta (porte dos corpos de `catalog-env.ts`).
//!
//! Cada função devolve o JSON exato da rota. Leitura de banco e índice vai para
//! `spawn_blocking`; a rede passa pela porta (`AccountCatalogPort`), e os fatos
//! vivos pela `CatalogFacts`. A aplicação de deleções é um `block_on` numa
//! thread de bloqueio porque o hook `on_deleted` do crate é `&dyn Fn` (não é
//! `Sync`) e o future do handler precisa ser `Send`. Ver `run_deletions`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use adom_catalog::cleanup::{
    list_for_review, plan_foreign_cleanup, plan_manual_deletion, ForeignCleanupOpts,
};
use adom_catalog::dedup::{
    apply_deletions, plan_dedup, plan_work_versions, DeleteOutcome, Deletion,
};
use adom_catalog::rows::CatalogStore;
use adom_catalog::scan::{report, scan as scan_store, CatalogReport, Magnet, ScanFacts, ScanInput};
use serde_json::{json, Value};

use super::facts::CatalogFacts;
use super::port::AccountCatalogPort;
use crate::dub_audit::now_ms;

/// Teto e janela do catálogo (`src/config/cache.ts` `catalog()`), lidos do env.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Knobs {
    pub cleanup_min_age_ms: i64,
    pub cleanup_max: i64,
    pub audit_max: i64,
    pub audit_concurrency: i64,
}

impl Knobs {
    pub(super) fn from_env() -> Self {
        use crate::dub_audit::env_num;
        Self {
            cleanup_min_age_ms: env_num("CATALOG_CLEANUP_MIN_AGE_MS", 48 * 3600 * 1000),
            cleanup_max: env_num("CATALOG_CLEANUP_MAX", 100).max(0),
            audit_max: env_num("CATALOG_AUDIT_MAX", 20).max(0),
            audit_concurrency: env_num("CATALOG_AUDIT_CONCURRENCY", 2).clamp(1, 3),
        }
    }
}

/// Tudo que uma operação precisa. Os `Arc` deixam o contexto ir para as tarefas.
pub(super) struct Deps {
    pub store: Arc<CatalogStore>,
    /// Escopo da conta (`accountScope`): chave de `adprot`/`adsub`/`adrm` e das linhas.
    pub account: String,
    pub adapter: String,
    pub port: Arc<dyn AccountCatalogPort>,
    pub facts: Arc<dyn CatalogFacts>,
    pub knobs: Knobs,
}

/// Falha de execução: `{ok:false, reason:"erro"}` mais um log SEM a chave.
pub(super) fn fail(op: &str, err: impl std::fmt::Display) -> Value {
    eprintln!("[catalog] {op} falhou: {err}");
    json!({ "ok": false, "reason": "erro" })
}

/// Roda um trabalho síncrono (SQLite/índice) numa thread de bloqueio.
pub(super) async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| err.to_string())?
}

/// Predicado de proteção como closure, para os planos do crate.
pub(super) fn protected_of(facts: Arc<dyn CatalogFacts>) -> impl Fn(&str) -> bool {
    move |hash: &str| facts.protected(hash)
}

/// Aplica o teto opcional de uma lista (`slice(0, max(0, trunc(max)))` do TS).
pub(super) fn cap<T>(mut list: Vec<T>, max: Option<i64>) -> Vec<T> {
    if let Some(max) = max {
        list.truncate(usize::try_from(max.max(0)).unwrap_or(usize::MAX));
    }
    list
}

/// `{ok:true, report}` do estado ativo (leitura do banco, sem rede).
pub(super) async fn status(deps: Arc<Deps>) -> Value {
    let d = deps.clone();
    let result = blocking(move || {
        report(&d.store, &d.adapter, Some(&d.account), now_ms()).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(report) => json!({ "ok": true, "report": report }),
        Err(err) => fail("status", err),
    }
}

/// Varredura da conta: lista, classifica, tomba os sumidos e devolve o relatório.
/// A listagem é lida ANTES de qualquer escrita: `Err` não toca no banco.
pub(super) async fn scan(deps: Arc<Deps>) -> Value {
    let magnets = match deps.port.list().await {
        Ok(magnets) => magnets,
        Err(err) => return fail("varredura (listagem)", err),
    };
    let d = deps.clone();
    let now = now_ms();
    match blocking(move || scan_blocking(&d, &magnets, now)).await {
        Ok(report) => json!({ "ok": true, "report": report }),
        Err(err) => fail("varredura", err),
    }
}

fn scan_blocking(d: &Deps, magnets: &[Magnet], now: i64) -> Result<CatalogReport, String> {
    let reverse = d.facts.reverse_index()?;
    let (pt, en) = d.facts.audio_lists();
    let pt_refs: Vec<&str> = pt.iter().map(String::as_str).collect();
    let en_refs: Vec<&str> = en.iter().map(String::as_str).collect();
    let file_evidence = |hash: &str| d.facts.file_evidence(hash);
    let release_status = |hash: &str| d.facts.release_status(hash);
    let facts = ScanFacts {
        file_evidence: &file_evidence,
        reverse: &reverse,
        release_status: &release_status,
        pt_markers: &pt_refs,
        en_groups: &en_refs,
    };
    let input = ScanInput {
        adapter_id: &d.adapter,
        account: &d.account,
        magnets,
        now_ms: now,
    };
    scan_store(&d.store, &input, &facts).map_err(|err| err.to_string())
}

/// Plano de deduplicação (leitura pura).
pub(super) async fn dedup_preview(deps: Arc<Deps>) -> Value {
    let d = deps.clone();
    let result = blocking(move || {
        let protected = protected_of(d.facts.clone());
        plan_dedup(&d.store, &d.account, &d.adapter, &protected).map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(plan) => json!({ "ok": true, "plan": plan }),
        Err(err) => fail("dedup-preview", err),
    }
}

/// Aplica os kills do plano de dedup (com teto `max` se dado).
///
/// `skipMark` (anti-reenchimento) segue o TS à risca: no T1 o hash SOBREVIVE na
/// conta pelo keep, então nunca marca; no T2 marca, salvo quando o mesmo hash
/// sobrevive pelo keep de outro grupo (`keeps`).
pub(super) async fn dedup_apply(deps: Arc<Deps>, max: Option<i64>) -> Value {
    let d = deps.clone();
    let list = match blocking(move || dedup_deletions(&d, max)).await {
        Ok(list) => list,
        Err(err) => return fail("dedup", err),
    };
    finish_apply("dedup", run_deletions(deps, list).await)
}

fn dedup_deletions(d: &Deps, max: Option<i64>) -> Result<Vec<Deletion>, String> {
    let protected = protected_of(d.facts.clone());
    let plan =
        plan_dedup(&d.store, &d.account, &d.adapter, &protected).map_err(|err| err.to_string())?;
    let keeps: HashSet<String> = plan
        .t1
        .iter()
        .chain(plan.t2.iter())
        .map(|group| group.keep.hash.to_lowercase())
        .collect();
    let mut deletions = Vec::new();
    for group in &plan.t1 {
        for kill in &group.kill {
            deletions.push(Deletion {
                service_id: kill.service_id.clone(),
                hash: kill.hash.clone(),
                reason: "duplicado".to_string(),
                filename: None,
                skip_mark: true,
            });
        }
    }
    for group in &plan.t2 {
        for kill in &group.kill {
            deletions.push(Deletion {
                service_id: kill.service_id.clone(),
                hash: kill.hash.clone(),
                reason: "duplicado por arquivo".to_string(),
                filename: Some(kill.filename.clone()),
                skip_mark: keeps.contains(&kill.hash.to_lowercase()),
            });
        }
    }
    Ok(cap(dedupe_by_id(deletions), max))
}

/// Um id, uma deleção: o último valor vence e a posição é a da primeira
/// aparição (o `Map.set` do TS).
pub(super) fn dedupe_by_id(items: Vec<Deletion>) -> Vec<Deletion> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Deletion> = Vec::new();
    for item in items {
        match index.get(&item.service_id) {
            Some(&slot) => out[slot] = item,
            None => {
                index.insert(item.service_id.clone(), out.len());
                out.push(item);
            }
        }
    }
    out
}

/// Deleção MANUAL dos ids escolhidos. Só `active` é guarda; sem trava de idade.
pub(super) async fn manual_delete(deps: Arc<Deps>, ids: Vec<String>) -> Value {
    let d = deps.clone();
    let plan = match blocking(move || {
        plan_manual_deletion(&d.store, &d.account, &d.adapter, &ids).map_err(|err| err.to_string())
    })
    .await
    {
        Ok(plan) => plan,
        Err(err) => return fail("deleção manual", err),
    };
    let (missing, active) = (plan.skipped.missing, plan.skipped.active);
    if plan.targets.is_empty() {
        return json!({ "ok": true, "total": 0, "deleted": 0, "falhas": 0, "missing": missing, "active": active });
    }
    let total = plan.targets.len();
    let list = plan
        .targets
        .into_iter()
        .map(|t| Deletion {
            service_id: t.service_id,
            hash: t.hash,
            reason: t.reason,
            filename: Some(t.filename),
            skip_mark: false,
        })
        .collect();
    match run_deletions(deps, list).await {
        Ok(out) => json!({
            "ok": true, "total": total, "deleted": out.ok, "falhas": out.falhas,
            "missing": missing, "active": active
        }),
        Err(err) => fail("deleção manual", err),
    }
}

/// Linhas para o operador escolher (maiores primeiro). Leitura pura.
pub(super) async fn list_rows(deps: Arc<Deps>, bucket: String, limit: Option<i64>) -> Value {
    let d = deps.clone();
    let result = blocking(move || {
        let protected = protected_of(d.facts.clone());
        list_for_review(&d.store, &d.account, &d.adapter, &bucket, limit, &protected)
            .map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(rows) => json!({ "ok": true, "rows": rows }),
        Err(err) => fail("list", err),
    }
}

/// Plano de versões da mesma obra (T3). Leitura pura.
pub(super) async fn versions(deps: Arc<Deps>) -> Value {
    let d = deps.clone();
    let result = blocking(move || {
        let protected = protected_of(d.facts.clone());
        plan_work_versions(&d.store, &d.account, &d.adapter, &protected)
            .map_err(|err| err.to_string())
    })
    .await;
    match result {
        Ok(plan) => json!({ "ok": true, "plan": plan }),
        Err(err) => fail("versions", err),
    }
}

/// Resultado do `apply_deletions` no formato da rota (`deleted` e `falhas`).
pub(super) fn finish_apply(op: &str, result: Result<DeleteOutcome, String>) -> Value {
    match result {
        Ok(out) => json!({ "ok": true, "deleted": out.ok, "falhas": out.falhas }),
        Err(err) => fail(op, err),
    }
}

/// Aplica as deleções numa thread de bloqueio com `block_on` (ver o cabeçalho).
pub(super) async fn run_deletions(
    deps: Arc<Deps>,
    list: Vec<Deletion>,
) -> Result<DeleteOutcome, String> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || handle.block_on(apply_inner(&deps, &list)))
        .await
        .map_err(|err| err.to_string())?
}

async fn apply_inner(deps: &Deps, list: &[Deletion]) -> Result<DeleteOutcome, String> {
    let facts = deps.facts.clone();
    let hook = move |hash: &str, name: Option<&str>| facts.on_deleted(hash, name);
    let hook_ref: &dyn Fn(&str, Option<&str>) = &hook;
    let port = deps.port.clone();
    apply_deletions(
        &deps.store,
        &deps.account,
        &deps.adapter,
        list,
        now_ms(),
        move |ids: Vec<String>| {
            let port = port.clone();
            async move { port.delete(ids).await }
        },
        Some(hook_ref),
    )
    .await
    .map_err(|err| err.to_string())
}

/// Opções da limpeza automática, a partir dos knobs e do switch `includeKnown`.
pub(super) fn cleanup_opts(knobs: Knobs, include_known: bool) -> ForeignCleanupOpts {
    ForeignCleanupOpts {
        now_ms: now_ms(),
        min_age_ms: knobs.cleanup_min_age_ms,
        max: knobs.cleanup_max,
        include_known,
    }
}

/// Plano da limpeza de estrangeiro provado, dado o acervo já lido. A regra do
/// `inventario-frio` fica com o chamador (ver `clean.rs`).
pub(super) async fn foreign_plan(
    deps: Arc<Deps>,
    known: Option<HashSet<String>>,
    include_known: bool,
) -> Result<adom_catalog::cleanup::ForeignPlan, String> {
    let d = deps.clone();
    blocking(move || {
        let protected = protected_of(d.facts.clone());
        let opts = cleanup_opts(d.knobs, include_known);
        plan_foreign_cleanup(
            &d.store,
            &d.account,
            &d.adapter,
            &opts,
            known.as_ref(),
            &protected,
        )
        .map_err(|err| err.to_string())
    })
    .await
}
