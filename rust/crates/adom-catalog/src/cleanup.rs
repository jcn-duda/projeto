//! Planos de limpeza e de rodeio manual do catálogo (porte de
//! `src/utils/catalog-cleanup.ts`).
//!
//! Três planos de leitura pura: a limpeza de ESTRANGEIRO PROVADO (guardas
//! contadas: protegido, ativo, jovem, sem condenação e `known`), a lista para o
//! operador ESCOLHER na mão (maiores primeiro) e a deleção MANUAL dos ids que
//! ele marcou. Nada aqui apaga: quem aplica é o wrapper. Sem relógio, sem rede:
//! o `now_ms` e a proteção do debrid entram por parâmetro.

use std::collections::HashSet;

use serde::Serialize;

use crate::rows::{is_active, CatalogStore, Row};

/// Alvo de deleção. O JSON é consumido pelo painel (`catalogo-model.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupTarget {
    pub service_id: String,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub reason: String,
    /// hash ∈ known_hashes — o acervo que já era do operador antes do addon.
    pub known: bool,
}

/// Contadores das guardas da limpeza automática (nomes do JSON do painel).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignSkipped {
    pub protected: u64,
    pub active: u64,
    pub young: u64,
    pub not_condemned: u64,
    pub known: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignPlan {
    pub targets: Vec<CleanupTarget>,
    pub skipped: ForeignSkipped,
}

/// Parâmetros da limpeza automática. `max <= 0` significa sem teto (como o TS:
/// `teto > 0 && ...`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForeignCleanupOpts {
    pub now_ms: i64,
    pub min_age_ms: i64,
    pub max: i64,
    /// Switch explícito do operador: inclui o acervo `known` como alvo.
    pub include_known: bool,
}

/// Linha para o operador escolher na mão (`DedupRow` + campos de balde/prova).
/// Achatada aqui de propósito: o TS a monta a partir de `toDedupRow`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRow {
    pub service_id: String,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub ready: bool,
    pub uploaded_at: i64,
    pub status: String,
    pub active: bool,
    pub protected: bool,
    pub bucket: String,
    pub foreign_proof: String,
    pub pt_proof: String,
    pub cached: String,
    pub imdb_id: String,
}

/// Contadores da deleção manual (nomes do JSON do painel).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSkipped {
    pub missing: u64,
    pub active: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualPlan {
    pub targets: Vec<CleanupTarget>,
    pub skipped: ManualSkipped,
}

/// Planeja a limpeza de ESTRANGEIRO PROVADO (`foreign_proof` não vazio), do
/// mais antigo para o mais novo, até `opts.max`.
///
/// `known_hashes` é o snapshot `knownBefore` da conta: `None` (ou vazio) não
/// exclui ninguém. Os hashes são normalizados para minúsculas, mas a comparação
/// é feita com o hash GUARDADO na linha, como no TS (`excludes.has(r.hash)`).
/// Com `include_known` falso, um `known` conta em `skipped.known` e sai; com
/// `include_known` verdadeiro ele segue pelas guardas e entra com `known: true`.
pub fn plan_foreign_cleanup(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    opts: &ForeignCleanupOpts,
    known_hashes: Option<&HashSet<String>>,
    protected: &dyn Fn(&str) -> bool,
) -> Result<ForeignPlan, String> {
    let all: Vec<Row> = store
        .list_rows(adapter, account)?
        .into_iter()
        .filter(|r| r.deleted_at == 0)
        .collect();
    let mut skipped = ForeignSkipped::default();
    let excludes: HashSet<String> = known_hashes
        .into_iter()
        .flatten()
        .filter(|h| !h.is_empty())
        .map(|h| h.to_lowercase())
        .collect();

    // Sem `foreign_proof` a linha só é contada: não é candidata.
    for r in &all {
        if r.foreign_proof.is_empty() {
            skipped.not_condemned += 1;
        }
    }
    // `sort_by_key` é estável, como o `sort` do JS: empates mantêm a ordem do banco.
    let mut suspects: Vec<&Row> = all.iter().filter(|r| !r.foreign_proof.is_empty()).collect();
    suspects.sort_by_key(|r| r.uploaded_at);

    let teto = opts.max.max(0);
    let mut targets = Vec::new();
    for r in suspects {
        if teto > 0 && targets.len() as i64 >= teto {
            break;
        }
        let is_known = excludes.contains(&r.hash);
        if is_known && !opts.include_known {
            skipped.known += 1;
            continue;
        }
        if protected(&r.hash) {
            skipped.protected += 1;
            continue;
        }
        if is_active(&r.status) {
            skipped.active += 1;
            continue;
        }
        if opts.min_age_ms > 0
            && r.uploaded_at > 0
            && opts.now_ms.saturating_sub(r.uploaded_at) < opts.min_age_ms
        {
            skipped.young += 1;
            continue;
        }
        targets.push(CleanupTarget {
            service_id: r.service_id.clone(),
            hash: r.hash.clone(),
            filename: r.filename.clone(),
            size: r.size,
            reason: "estrangeiro provado".to_string(),
            known: is_known,
        });
    }
    Ok(ForeignPlan { targets, skipped })
}

/// Linhas para o operador ESCOLHER na mão, maiores primeiro (é espaço que ele
/// quer de volta). Leitura pura.
///
/// `bucket` vazio traz todos os baldes. `limit` `None` vale 100 e um valor
/// negativo vira 0, como o TS. `protected` recebe o hash da linha.
pub fn list_for_review(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    bucket: &str,
    limit: Option<i64>,
    protected: &dyn Fn(&str) -> bool,
) -> Result<Vec<ReviewRow>, String> {
    let teto = usize::try_from(limit.map_or(100, |n| n.max(0))).unwrap_or(usize::MAX);
    let mut out = Vec::new();
    for r in store.list_rows(adapter, account)? {
        if r.deleted_at != 0 {
            continue;
        }
        if !bucket.is_empty() && r.bucket != bucket {
            continue;
        }
        out.push(ReviewRow {
            active: is_active(&r.status),
            protected: protected(&r.hash),
            ready: r.ready != 0,
            service_id: r.service_id,
            hash: r.hash,
            filename: r.filename,
            size: r.size,
            uploaded_at: r.uploaded_at,
            status: r.status,
            bucket: r.bucket,
            foreign_proof: r.foreign_proof,
            pt_proof: r.pt_proof,
            cached: r.cached,
            imdb_id: r.imdb_id,
        });
    }
    // Estável: empates de tamanho mantêm a ordem devolvida pelo banco.
    out.sort_by(|a, b| b.size.cmp(&a.size));
    out.truncate(teto);
    Ok(out)
}

/// Plano da deleção MANUAL: o operador mandou estes `service_ids` e nada mais.
///
/// Sem regra de classificação e sem trava de idade: a escolha explícita é a
/// autorização. A única guarda é `active`. Ids vazios e repetidos são ignorados
/// (o primeiro vence), e id inexistente ou já apagado conta em `missing`.
pub fn plan_manual_deletion(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    service_ids: &[String],
) -> Result<ManualPlan, String> {
    let mut skipped = ManualSkipped::default();
    let mut targets = Vec::new();
    let mut vistos: HashSet<&str> = HashSet::new();
    for raw in service_ids {
        if raw.is_empty() || !vistos.insert(raw.as_str()) {
            continue;
        }
        match store.get_row(adapter, account, raw)? {
            Some(r) if r.deleted_at == 0 => {
                if is_active(&r.status) {
                    skipped.active += 1;
                    continue;
                }
                targets.push(CleanupTarget {
                    service_id: r.service_id,
                    hash: r.hash,
                    filename: r.filename,
                    size: r.size,
                    reason: "manual".to_string(),
                    known: false,
                });
            }
            _ => skipped.missing += 1,
        }
    }
    Ok(ManualPlan { targets, skipped })
}

#[cfg(test)]
#[path = "cleanup_tests.rs"]
mod cleanup_tests;
