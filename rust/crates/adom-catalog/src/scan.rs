//! Porte de `src/utils/catalog-scan.ts`: VARREDURA DA CONTA e relatórios.
//!
//! O `scan` é o escritor de larga escala: recebe a lista de magnets da conta,
//! faz upsert de cada linha com classificação e provas, associa o índice
//! reverso hash → obra e tomba quem sumiu da conta. `report` e `row` são
//! leitura pura do último estado.
//!
//! Sem relógio, rede ou globais: o instante (`now_ms`) e os fatos vivos
//! (evidência de arquivo, índice reverso, estado quieto do cache e as listas
//! calibradas do audit) entram por parâmetro. A métrica da versão TS saiu;
//! os contadores que ela registrava voltam no `CatalogReport`.

use std::collections::{BTreeMap, HashMap, HashSet};

use adom_core::{classify_by_title, classify_with_evidence, Proof};
use serde::Serialize;

use crate::rows::{CatalogStore, MarkInput, Row};

/// Motivo gravado no tombstone de quem sumiu da lista da conta.
const ABSENT_REASON: &str = "ausente da conta";

/// Evidência de ARQUIVO de um hash (`fileEvidence` do índice): áudio medido e
/// nome do vídeo. Só `a` e `n` interessam ao catálogo.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileEvidence {
    pub a: String,
    pub n: String,
}

/// Release conhecida de uma obra, como vem do índice (`IndexedRelease`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexedRelease {
    pub hash: String,
    pub title: String,
    pub is_br: bool,
    pub dubbed: bool,
    pub lied: bool,
}

/// Obra dona de um hash no índice reverso (`reverseIndex`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WorkRef {
    pub imdb_id: String,
    pub title: String,
    pub is_br: bool,
    pub dubbed: bool,
    pub lied: bool,
}

/// Magnet como a AllDebrid lista na conta (`AllDebridMagnetRow`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Magnet {
    /// `None` quando a API não devolveu id: a linha é pulada, como no TS.
    pub id: Option<String>,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub status: String,
    pub ready: bool,
    pub upload_date: i64,
}

/// Contagem e tamanho de um balde do relatório.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountBytes {
    pub count: i64,
    pub bytes: i64,
}

/// Obras conhecidas (com `imdb_id`) e desconhecidas entre os magnets ativos.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorksCount {
    pub known: i64,
    pub unknown: i64,
}

/// Relatório do estado ATIVO do catálogo (`CatalogReport`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogReport {
    pub scanned_at: i64,
    /// Quantos magnets a última varredura recebeu.
    pub scanned: i64,
    /// Quantos estão ATIVOS agora (`deleted_at == 0`).
    pub magnets: i64,
    pub ready: i64,
    pub totals: CountBytes,
    pub by_bucket: BTreeMap<String, CountBytes>,
    pub by_cached: BTreeMap<String, i64>,
    pub works: WorksCount,
    /// Magnets cujo hash não estava no índice reverso. Só o `scan` sabe disso;
    /// a leitura (`report`) põe a contagem de obras desconhecidas.
    pub unresolved_hashes: i64,
}

/// Linha de observação de um magnet (`row`): o subconjunto que o TS expõe.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRowView {
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub status: String,
    pub ready: bool,
    pub uploaded_at: i64,
    pub bucket: String,
    pub audio: String,
    pub foreign_proof: String,
    pub pt_proof: String,
    pub imdb_id: String,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub audited_at: i64,
    pub cached: String,
    pub cached_at: i64,
    pub deleted_at: i64,
    pub delete_reason: String,
}

/// Entrada da varredura: quem é a conta e os magnets que a API devolveu.
#[derive(Clone, Copy, Debug)]
pub struct ScanInput<'a> {
    pub adapter_id: &'a str,
    pub account: &'a str,
    pub magnets: &'a [Magnet],
    pub now_ms: i64,
}

/// Fatos vivos que a varredura consulta por hash ou por lista, todos injetados.
#[derive(Clone, Copy)]
pub struct ScanFacts<'a> {
    /// `fileEvidence(hash)` do índice (o hash chega em minúsculas).
    pub file_evidence: &'a dyn Fn(&str) -> Option<FileEvidence>,
    /// Índice reverso hash → obra (`reverse_index`). As chaves são os hashes
    /// como vieram do índice; a busca usa o hash em minúsculas, como no TS.
    pub reverse: &'a HashMap<String, WorkRef>,
    /// `releaseStatus` quieto (sem rede): só usado para magnet que NÃO está
    /// pronto na conta. Devolve `hit`, `miss` ou `unknown`.
    pub release_status: &'a dyn Fn(&str) -> String,
    /// Listas calibradas do audit (`config.audioAudit.ptMarkers`/`enGroups`).
    pub pt_markers: &'a [&'a str],
    pub en_groups: &'a [&'a str],
}

/// Índice reverso hash → obra. A primeira obra que traz o hash ganha; release
/// sem hash é ignorada. Porte de `reverseIndex()` sem o snapshot global: a
/// lista de obras entra por parâmetro.
pub fn reverse_index(
    works: impl IntoIterator<Item = (String, Vec<IndexedRelease>)>,
) -> HashMap<String, WorkRef> {
    let mut reverse = HashMap::new();
    for (imdb_id, releases) in works {
        for rel in releases {
            if rel.hash.is_empty() || reverse.contains_key(&rel.hash) {
                continue;
            }
            let key = rel.hash.clone();
            reverse.insert(
                key,
                WorkRef {
                    imdb_id: imdb_id.clone(),
                    title: rel.title,
                    is_br: rel.is_br,
                    dubbed: rel.dubbed,
                    lied: rel.lied,
                },
            );
        }
    }
    reverse
}

/// Relatório zerado, com o instante da leitura.
pub fn empty_report(scanned_at: i64) -> CatalogReport {
    CatalogReport {
        scanned_at,
        ..CatalogReport::default()
    }
}

/// Soma uma linha ATIVA nos totais do relatório (o corpo do laço de `report`).
fn accumulate(report: &mut CatalogReport, r: &Row) {
    report.magnets += 1;
    if r.ready != 0 {
        report.ready += 1;
    }
    report.totals.count += 1;
    report.totals.bytes += r.size;
    let bucket = report.by_bucket.entry(r.bucket.clone()).or_default();
    bucket.count += 1;
    bucket.bytes += r.size;
    *report.by_cached.entry(r.cached.clone()).or_insert(0) += 1;
    if r.imdb_id.is_empty() {
        report.works.unknown += 1;
    } else {
        report.works.known += 1;
    }
}

/// Varre a conta: faz upsert de cada magnet com classificação e provas,
/// associa o índice reverso, mede a disponibilidade quieta e tomba as linhas
/// da última varredura que sumiram. Devolve o relatório do estado ativo.
pub fn scan(
    store: &CatalogStore,
    input: &ScanInput<'_>,
    facts: &ScanFacts<'_>,
) -> Result<CatalogReport, String> {
    let now = input.now_ms;
    let mut report = empty_report(now);
    report.scanned = input.magnets.len() as i64;

    let mut services_seen: HashSet<String> = HashSet::new();
    let mut unresolved: i64 = 0;

    for m in input.magnets {
        let Some(service_id) = m.id.as_ref() else {
            continue;
        };
        if m.hash.is_empty() {
            continue;
        }
        let hash = m.hash.to_lowercase();
        services_seen.insert(service_id.clone());
        let filename = m.filename.trim().to_string();
        let evidence = (facts.file_evidence)(&hash);
        let (proof, audio): (Proof, String) = match &evidence {
            Some(ev) => (
                classify_with_evidence(
                    &filename,
                    Some(ev.n.as_str()),
                    facts.pt_markers,
                    facts.en_groups,
                ),
                ev.a.clone(),
            ),
            None => (
                classify_by_title(&filename, facts.pt_markers, facts.en_groups),
                String::new(),
            ),
        };
        let work = facts.reverse.get(&hash);
        if work.is_none() {
            unresolved += 1;
        }
        // Magnet `ready` NA conta é tocável na hora (é o ⚡ que o play usa). O
        // veredito quieto só informa quem NÃO está pronto na conta.
        let cached = if m.ready {
            "hit".to_string()
        } else {
            (facts.release_status)(&hash)
        };

        store.upsert_row(&Row {
            adapter: input.adapter_id.to_string(),
            account: input.account.to_string(),
            service_id: service_id.clone(),
            hash: hash.clone(),
            filename: filename.clone(),
            size: m.size,
            status: m.status.clone(),
            ready: i64::from(m.ready),
            uploaded_at: m.upload_date,
            bucket: proof.bucket.to_string(),
            audio,
            foreign_proof: proof.foreign_proof.to_string(),
            pt_proof: proof.pt_proof.to_string(),
            imdb_id: work.map(|w| w.imdb_id.clone()).unwrap_or_default(),
            work_title: work.map(|w| w.title.clone()).unwrap_or_default(),
            work_is_br: i64::from(work.is_some_and(|w| w.is_br)),
            work_dubbed: i64::from(work.is_some_and(|w| w.dubbed)),
            work_lied: i64::from(work.is_some_and(|w| w.lied)),
            cached,
            cached_at: now,
            first_seen_at: now,
            last_seen_at: now,
            // Se ESTA varredura ainda vê a evidência, a linha está auditada
            // (marcador durável; a fila não depende do TTL da evidência).
            audited_at: if evidence.is_some() { now } else { 0 },
            ..Row::default()
        })?;
    }

    // Tombstone de sumidos: linha desta conta que não veio na lista recebida.
    let missing: Vec<MarkInput> = store
        .list_rows(input.adapter_id, input.account)?
        .into_iter()
        .filter(|r| r.deleted_at == 0 && !services_seen.contains(&r.service_id))
        .map(|r| MarkInput {
            service_id: r.service_id,
            reason: ABSENT_REASON.to_string(),
        })
        .collect();
    if !missing.is_empty() {
        store.mark_deleted(input.adapter_id, input.account, &missing, now)?;
    }

    // Relatório do estado ATIVO pós-varredura.
    for r in store.list_rows(input.adapter_id, input.account)? {
        if r.deleted_at == 0 {
            accumulate(&mut report, &r);
        }
    }
    report.unresolved_hashes = unresolved;
    Ok(report)
}

/// Relatório da LEITURA do banco (último estado), sem rede. `unresolved_hashes`
/// não persiste entre varreduras: a leitura usa o que ficou sem obra. Conta
/// sem nome cai em `none`, como o `account || 'none'` do TS.
pub fn report(
    store: &CatalogStore,
    adapter_id: &str,
    account: Option<&str>,
    now_ms: i64,
) -> Result<CatalogReport, String> {
    let acc = match account {
        Some(a) if !a.is_empty() => a,
        _ => "none",
    };
    let mut out = empty_report(now_ms);
    for r in store.list_rows(adapter_id, acc)? {
        if r.deleted_at == 0 {
            accumulate(&mut out, &r);
        }
    }
    out.unresolved_hashes = out.works.unknown;
    Ok(out)
}

/// Linha única para observação: estado durável do magnet na conta. `None`
/// quando a linha não existe.
pub fn row(
    store: &CatalogStore,
    adapter_id: &str,
    account: &str,
    service_id: &str,
) -> Result<Option<CatalogRowView>, String> {
    let Some(r) = store.get_row(adapter_id, account, service_id)? else {
        return Ok(None);
    };
    Ok(Some(CatalogRowView {
        hash: r.hash,
        filename: r.filename,
        size: r.size,
        status: r.status,
        ready: r.ready != 0,
        uploaded_at: r.uploaded_at,
        bucket: r.bucket,
        audio: r.audio,
        foreign_proof: r.foreign_proof,
        pt_proof: r.pt_proof,
        imdb_id: r.imdb_id,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
        audited_at: r.audited_at,
        cached: r.cached,
        cached_at: r.cached_at,
        deleted_at: r.deleted_at,
        delete_reason: r.delete_reason,
    }))
}

#[cfg(test)]
#[path = "scan_tests.rs"]
pub(crate) mod scan_tests;
