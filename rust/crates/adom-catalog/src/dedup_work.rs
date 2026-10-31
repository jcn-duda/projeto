//! T3 (versões da mesma obra, leitura pura) e execução dos deletes
//! (`catalog-dedup.ts`). Fora de `dedup.rs` pelo teto de 400 linhas.

use std::cmp::{Ordering, Reverse};
use std::future::Future;

use serde::{Deserialize, Serialize};

use super::group_in_order;
use crate::rows::{is_active, CatalogStore, MarkInput, Row};

// --- T3: versões da mesma obra (leitura pura) --------------------------------

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkVersionRow {
    pub service_id: String,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub bucket: String,
    pub foreign_proof: String,
    pub pt_proof: String,
    pub ready: bool,
    pub active: bool,
    pub protected: bool,
    pub work_title: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkVersionGroup {
    pub key: String,
    pub work_title: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub imdb_id: String,
    pub keep: WorkVersionRow,
    pub kill: Vec<WorkVersionRow>,
    pub recoverable_bytes: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkVersionPlan {
    pub groups: Vec<WorkVersionGroup>,
    pub without_imdb: usize,
}

/// Preferência do balde: dub > dual > pt > lixo; desconhecido por último.
pub fn bucket_rank(bucket: &str) -> u8 {
    match bucket {
        "dub" => 0,
        "dual" => 1,
        "pt" => 2,
        "lixo" => 3,
        _ => 4,
    }
}

/// Balde, sem prova estrangeira, pronto, protegido, maior tamanho.
fn work_order(a: &WorkVersionRow, b: &WorkVersionRow) -> Ordering {
    bucket_rank(&a.bucket)
        .cmp(&bucket_rank(&b.bucket))
        .then((!a.foreign_proof.is_empty()).cmp(&!b.foreign_proof.is_empty()))
        .then(b.ready.cmp(&a.ready))
        .then(b.protected.cmp(&a.protected))
        .then(b.size.cmp(&a.size))
}

pub fn pick_work_survivor(rows: &[WorkVersionRow]) -> Option<WorkVersionRow> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(work_order);
    sorted.into_iter().next()
}

fn work_row(row: &Row, protected: &dyn Fn(&str) -> bool) -> WorkVersionRow {
    WorkVersionRow {
        service_id: row.service_id.clone(),
        hash: row.hash.clone(),
        filename: row.filename.clone(),
        size: row.size,
        bucket: row.bucket.clone(),
        foreign_proof: row.foreign_proof.clone(),
        pt_proof: row.pt_proof.clone(),
        ready: row.ready != 0,
        active: is_active(&row.status),
        protected: protected(&row.hash),
        work_title: row.work_title.clone(),
        season: row.season,
        episode: row.episode,
    }
}

/// Grupo de versões: kill = não-sobrevivente, NÃO ativo e NÃO protegido.
fn work_group(key: String, members: &[WorkVersionRow]) -> Option<WorkVersionGroup> {
    if members.len() < 2 {
        return None;
    }
    let keep = pick_work_survivor(members)?;
    let kill: Vec<WorkVersionRow> = members
        .iter()
        .filter(|m| m.service_id != keep.service_id && !m.active && !m.protected)
        .cloned()
        .collect();
    if kill.is_empty() {
        return None;
    }
    let recoverable_bytes = kill.iter().map(|k| k.size).sum();
    // Chave = `imdb\0temporada\0episódio`; temporada e episódio são os do sobrevivente.
    let imdb_id = key.split('\u{0}').next().unwrap_or("").to_string();
    Some(WorkVersionGroup {
        key,
        work_title: keep.work_title.clone(),
        season: keep.season,
        episode: keep.episode,
        imdb_id,
        keep,
        kill,
        recoverable_bytes,
    })
}

/// T3: linhas vivas com `imdb_id`, por obra + temporada + episódio (pack sem episódio).
pub fn plan_work_versions(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    protected: &dyn Fn(&str) -> bool,
) -> Result<WorkVersionPlan, String> {
    let mut without_imdb = 0;
    let mut items: Vec<(String, WorkVersionRow)> = Vec::new();
    for r in store
        .list_rows(adapter, account)?
        .iter()
        .filter(|r| r.deleted_at == 0)
    {
        if r.imdb_id.is_empty() {
            without_imdb += 1;
            continue;
        }
        let ep = r
            .episode
            .map_or_else(|| "pack".to_string(), |e| e.to_string());
        let season = r.season.map_or_else(String::new, |s| s.to_string());
        items.push((
            format!("{}\u{0}{season}\u{0}{ep}", r.imdb_id),
            work_row(r, protected),
        ));
    }
    let mut groups: Vec<WorkVersionGroup> = group_in_order(items)
        .into_iter()
        .filter_map(|(key, members)| work_group(key, &members))
        .collect();
    // Maior ganho recuperável primeiro; estável no empate.
    groups.sort_by_key(|g| Reverse(g.recoverable_bytes));
    Ok(WorkVersionPlan {
        groups,
        without_imdb,
    })
}

// --- Execução dos deletes -----------------------------------------------------

/// Pedido de deleção. `service_id` é texto (o TS aceita número).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deletion {
    pub service_id: String,
    pub hash: String,
    pub reason: String,
    #[serde(default)]
    pub filename: Option<String>,
    /// Sem `on_deleted` (ex.: o anti-reenchimento já foi tratado); o tombstone vale igual.
    #[serde(default)]
    pub skip_mark: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub message: Option<String>,
}

/// Resposta do executor (`deleteMagnets`). `removed_ids` ausente não exige o id.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResponse {
    pub ok: i64,
    pub falhas: Vec<DeleteFailure>,
    pub removed_ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub ok: usize,
    pub falhas: usize,
}

/// Hook `(hash, nome)` por deleção bem-sucedida (sem `skip_mark`).
pub type OnDeleted<'a> = &'a dyn Fn(&str, Option<&str>);

/// Um delete por vez; tombstona SÓ o que saiu. Falha do executor, ou id fora de
/// `removed_ids`, deixa a linha viva. Métricas ficam com o chamador.
pub async fn apply_deletions<F, Fut>(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    deletions: &[Deletion],
    now_ms: i64,
    mut delete: F,
    on_deleted: Option<OnDeleted<'_>>,
) -> Result<DeleteOutcome, String>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<DeleteResponse, String>>,
{
    let mut ok = 0;
    let mut falhas = 0;
    for del in deletions {
        let removed = match delete(vec![del.service_id.clone()]).await {
            Ok(res) => {
                let ids_ok = res
                    .removed_ids
                    .as_ref()
                    .is_none_or(|ids| ids.contains(&del.service_id));
                res.falhas.is_empty() && res.ok >= 1 && ids_ok
            }
            Err(_) => false,
        };
        let marked = removed.then(|| {
            let items = [MarkInput {
                service_id: del.service_id.clone(),
                reason: del.reason.clone(),
            }];
            store.mark_deleted(adapter, account, &items, now_ms)
        });
        match marked {
            Some(Ok(_)) => {
                if let Some(hook) = on_deleted.filter(|_| !del.skip_mark) {
                    hook(&del.hash, del.filename.as_deref());
                }
                ok += 1;
            }
            // Falha de tombstone conta como falha (o `catch` do TS).
            Some(Err(_)) | None => falhas += 1,
        }
    }
    Ok(DeleteOutcome { ok, falhas })
}

#[cfg(test)]
#[path = "dedup_work_tests.rs"]
mod dedup_work_tests;
