//! Porte de `src/utils/catalog-audit.ts`: FILA DE AUDITORIA DE ARQUIVOS.
//!
//! A fila retomável é o carimbo `audited_at` no próprio catálogo (durável, não
//! depende do TTL da evidência). `note_audit` espelha na linha o que a
//! auditoria acabou de medir nos arquivos; `mark_audited*` fecham a rodada sem
//! revisitar item já aprendido.
//!
//! A evidência de arquivo (`fileEvidence`) entra por parâmetro, e o instante
//! (`now_ms`) também. Sem relógio, rede ou globais.

use adom_core::{audio_bucket, audio_from_title, foreign_proof_label, foreign_verdict};
use serde::Serialize;

use crate::rows::CatalogStore;
use crate::scan::FileEvidence;

/// Item da fila: linha que precisa de leitura de arquivos.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditTarget {
    pub service_id: String,
    pub hash: String,
}

/// Resultado de `requeue_audit` (mesmos nomes do TS).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequeueResult {
    pub requeued: i64,
    pub kept_with_evidence: i64,
    pub already_queued: i64,
}

/// Arquivo de uma lista de torrent. Só o caminho importa à auditoria.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuditFile {
    pub path: Option<String>,
}

/// Listas calibradas do audit de dublagem (`config.audioAudit`), por parâmetro.
#[derive(Clone, Copy, Debug)]
pub struct AuditLists<'a> {
    pub pt_markers: &'a [&'a str],
    pub en_groups: &'a [&'a str],
}

/// Linhas ativas, prontas e fracas (sem prova, ou `dual`/`lixo`) que ainda não
/// foram auditadas nem têm evidência de arquivo. É a fila da auditoria.
///
/// O teto segue o TS ao pé da letra: a checagem vem DEPOIS do push, então
/// `limit = 0` devolve um item quando há candidato (não zero). Preservado de
/// propósito para não mudar a fila; ver o relatório da porte.
pub fn rows_needing_audit(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    limit: Option<usize>,
    file_evidence: &dyn Fn(&str) -> Option<FileEvidence>,
) -> Result<Vec<AuditTarget>, String> {
    let teto = limit.unwrap_or(usize::MAX);
    let mut out = Vec::new();
    for r in store.list_rows(adapter_id, account)? {
        if r.deleted_at != 0 || r.ready == 0 {
            continue;
        }
        let weak = (r.foreign_proof.is_empty() && r.pt_proof.is_empty())
            || r.bucket == "dual"
            || r.bucket == "lixo";
        if !weak {
            continue;
        }
        if r.audited_at > 0 || file_evidence(&r.hash).is_some() {
            continue;
        }
        out.push(AuditTarget {
            service_id: r.service_id,
            hash: r.hash,
        });
        if out.len() >= teto {
            break;
        }
    }
    Ok(out)
}

/// Devolve à fila as linhas PRESAS: já marcadas `audited_at`, mas sem
/// `file_evidence`. Elas nunca seriam relidas (o `upsert_row` mantém o
/// carimbo com `max`), então uma correção do classificador não as alcançaria.
///
/// NÃO mexe nas provas: a absolvição medida em arquivo (`pt_proof == arquivo`)
/// segue protegendo o acervo até uma leitura NOVA substituí-la. Quem ainda tem
/// evidência em cache não é tocado; reclassifica no próximo `scan`.
pub fn requeue_audit(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    limit: Option<usize>,
    file_evidence: &dyn Fn(&str) -> Option<FileEvidence>,
) -> Result<RequeueResult, String> {
    let teto = limit.unwrap_or(usize::MAX);
    let mut out = RequeueResult::default();
    let mut requeued: usize = 0;
    for mut r in store.list_rows(adapter_id, account)? {
        if r.deleted_at != 0 {
            continue;
        }
        if r.audited_at == 0 {
            out.already_queued += 1;
            continue;
        }
        if file_evidence(&r.hash).is_some() {
            out.kept_with_evidence += 1;
            continue;
        }
        if requeued >= teto {
            continue;
        }
        r.audited_at = 0;
        store.put_row(&r)?;
        requeued += 1;
    }
    out.requeued = requeued as i64;
    Ok(out)
}

/// Espelha na linha a auditoria de arquivos que acabou de ser medida: áudio,
/// bucket e as provas (`arquivo` ou o rótulo de condenação). Sobrescreve a
/// classificação, como o `updateRow` do TS. Sem linha, não faz nada.
pub fn note_audit(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    service_id: &str,
    files: &[AuditFile],
    now_ms: i64,
    lists: &AuditLists<'_>,
) -> Result<(), String> {
    let Some(mut row) = store.get_row(adapter_id, account, service_id)? else {
        return Ok(());
    };
    let paths: Vec<&str> = files
        .iter()
        .filter_map(|f| f.path.as_deref())
        .filter(|p| !p.is_empty())
        .collect();
    let audio = paths
        .iter()
        .map(|p| audio_from_title(p))
        .find(|a| !a.is_empty())
        .unwrap_or("");
    let verdict = foreign_verdict(&row.filename, &paths, lists.pt_markers, lists.en_groups);
    let (foreign_proof, pt_proof) = match verdict {
        "condena" => {
            let mut candidates = Vec::with_capacity(paths.len() + 1);
            candidates.push(row.filename.as_str());
            candidates.extend(paths.iter().copied());
            (
                foreign_proof_label(&candidates, lists.pt_markers, lists.en_groups),
                "",
            )
        }
        "absolve" => ("", "arquivo"),
        _ => ("", ""),
    };
    row.bucket = audio_bucket(&row.filename).to_string();
    row.audio = audio.to_string();
    row.foreign_proof = foreign_proof.to_string();
    row.pt_proof = pt_proof.to_string();
    row.last_seen_at = now_ms;
    row.audited_at = now_ms;
    store.put_row(&row)
}

/// Marca a linha como auditada SEM mudar a classificação: usado quando o magnet
/// está pronto mas a conta não lista arquivos (nada a aprender). Idempotente.
pub fn mark_audited(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    service_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let Some(mut row) = store.get_row(adapter_id, account, service_id)? else {
        return Ok(());
    };
    if row.audited_at > 0 {
        return Ok(());
    }
    row.audited_at = now_ms;
    store.put_row(&row)
}

/// Como `mark_audited`, mas NÃO congela uma linha CONDENADA pelo título
/// (`foreign_proof != ""`) quando não há arquivos lidos. Uma condenação só pelo
/// título pode ser absolvida pelos arquivos reais numa rodada futura; congelá-la
/// negaria essa chance. Só marca linha ativa, sem condenação e ainda não
/// auditada.
pub fn mark_audited_unless_condemned(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    service_id: &str,
    now_ms: i64,
) -> Result<(), String> {
    let Some(mut row) = store.get_row(adapter_id, account, service_id)? else {
        return Ok(());
    };
    if row.deleted_at != 0 || !row.foreign_proof.is_empty() || row.audited_at > 0 {
        return Ok(());
    }
    row.audited_at = now_ms;
    store.put_row(&row)
}

#[cfg(test)]
#[path = "audit_tests.rs"]
mod audit_tests;
