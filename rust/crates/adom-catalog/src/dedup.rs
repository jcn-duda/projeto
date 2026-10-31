//! Porte de `src/utils/catalog-dedup.ts`: dedup (T1/T2), versões da obra (T3) e
//! deletes. Só `apply_deletions` escreve, e só tombstona o que o executor
//! confirmou. Sem relógio (`now_ms` por parâmetro); a proteção é a closure
//! `hash -> bool`, já ligada à conta e ao adapter pelo chamador.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

use crate::rows::{is_active, CatalogStore, Row};

/// Linha vista pela dedup (nomes JSON iguais ao TS: o painel os lê).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupRow {
    pub service_id: String,
    pub hash: String,
    pub filename: String,
    pub size: i64,
    pub ready: bool,
    pub uploaded_at: i64,
    pub status: String,
    pub active: bool,
    pub protected: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupGroup {
    pub key: String,
    pub keep: DedupRow,
    pub kill: Vec<DedupRow>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupPlan {
    pub t1: Vec<DedupGroup>,
    pub t2: Vec<DedupGroup>,
}

/// Converte uma linha. `protected` recebe só o hash.
pub fn to_dedup_row(row: &Row, protected: &dyn Fn(&str) -> bool) -> DedupRow {
    DedupRow {
        service_id: row.service_id.clone(),
        hash: row.hash.clone(),
        filename: row.filename.clone(),
        size: row.size,
        ready: row.ready != 0,
        uploaded_at: row.uploaded_at,
        status: row.status.clone(),
        active: is_active(&row.status),
        protected: protected(&row.hash),
    }
}

/// Espaço do ECMAScript (`\s`, `trim`): inclui U+FEFF e exclui U+0085, ao
/// contrário do `\s` do Rust. Mesmo conjunto na regex e em `is_js_ws`.
const JS_WS: &str = r"\t\n\x{0B}\x{0C}\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

fn is_js_ws(c: char) -> bool {
    matches!(c as u32, 0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF)
}

/// [extensão final, separadores, espaços repetidos], compiladas uma vez.
fn filename_regexes() -> &'static [Regex; 3] {
    static RE: OnceLock<[Regex; 3]> = OnceLock::new();
    RE.get_or_init(|| {
        // Sem `(?i)`: o nome já vem em minúsculas e a classe ASCII não casa ſ.
        [
            Regex::new(r"\.[a-z0-9]+$"),
            Regex::new(&format!(r"[._\-\[\]{JS_WS}]+")),
            Regex::new(&format!(r"[{JS_WS}]{{2,}}")),
        ]
        .map(|r| r.expect("regex fixa"))
    })
}

/// "Devoradores 2026" e "Devoradores.2026" → "devoradores 2026" (chave do T2).
pub fn filename_normalized(filename: &str) -> String {
    let [ext, separators, spaces] = filename_regexes();
    let lower = filename.to_lowercase();
    let no_ext = ext.replace(&lower, "");
    let joined = separators.replace_all(&no_ext, " ");
    spaces
        .replace_all(&joined, " ")
        .trim_matches(is_js_ws)
        .to_string()
}

/// Sobrevivente: pronto > protegido > mais antigo.
fn survivor_order(a: &DedupRow, b: &DedupRow) -> Ordering {
    b.ready
        .cmp(&a.ready)
        .then(b.protected.cmp(&a.protected))
        .then(a.uploaded_at.cmp(&b.uploaded_at))
}

/// Primeiro da ordem; se há protegido e o primeiro não é, vence o primeiro protegido.
pub fn pick_survivor(rows: &[DedupRow]) -> Option<DedupRow> {
    let mut sorted = rows.to_vec();
    sorted.sort_by(survivor_order);
    let first = sorted.first()?.clone();
    if first.protected {
        return Some(first);
    }
    Some(
        sorted
            .iter()
            .find(|r| r.protected)
            .unwrap_or(&first)
            .clone(),
    )
}

/// Agrupa na ordem da primeira aparição (o `Map` do TS). O `HashMap` é só índice.
fn group_in_order<K: Eq + Hash + Clone, V>(
    items: impl IntoIterator<Item = (K, V)>,
) -> Vec<(K, Vec<V>)> {
    let mut index: HashMap<K, usize> = HashMap::new();
    let mut out: Vec<(K, Vec<V>)> = Vec::new();
    for (key, value) in items {
        if let Some(&i) = index.get(&key) {
            out[i].1.push(value);
        } else {
            index.insert(key.clone(), out.len());
            out.push((key, vec![value]));
        }
    }
    out
}

/// Grupo de dedup: 2+ membros; kill = não-sobrevivente e NÃO ativo.
fn dedup_group(key: String, members: &[DedupRow]) -> Option<DedupGroup> {
    if members.len() < 2 {
        return None;
    }
    let keep = pick_survivor(members)?;
    let kill: Vec<DedupRow> = members
        .iter()
        .filter(|m| m.service_id != keep.service_id && !m.active)
        .cloned()
        .collect();
    (!kill.is_empty()).then_some(DedupGroup { key, keep, kill })
}

/// Plano de dedup (leitura pura).
///  - T1: mesmo hash, 2+ vivos;
///  - T2: mesmo `filename_normalized`, 2+ vivos, tamanhos na tolerância de 0,5%
///    contra o MENOR do cluster (comparação não encadeada).
///
/// Kill nunca toca estado ativo, e a matemática deixa ≥1 vivo.
pub fn plan_dedup(
    store: &CatalogStore,
    account: &str,
    adapter: &str,
    protected: &dyn Fn(&str) -> bool,
) -> Result<DedupPlan, String> {
    let rows: Vec<DedupRow> = store
        .list_rows(adapter, account)?
        .iter()
        .filter(|r| r.deleted_at == 0)
        .map(|r| to_dedup_row(r, protected))
        .collect();

    let t1 = group_in_order(
        rows.iter()
            .filter(|r| !r.hash.is_empty())
            .map(|r| (r.hash.clone(), r.clone())),
    )
    .into_iter()
    .filter_map(|(hash, members)| dedup_group(hash, &members))
    .collect();

    // Tamanho desconhecido (<= 0) não prova "mesma release": fica de fora.
    let by_name = group_in_order(rows.iter().filter(|r| r.size > 0).filter_map(|r| {
        let nome = filename_normalized(&r.filename);
        (!nome.is_empty()).then(|| (nome, r.clone()))
    }));
    let mut t2 = Vec::new();
    for (nome, mut members) in by_name {
        members.sort_by_key(|m| m.size);
        let mut cluster: Vec<DedupRow> = Vec::new();
        let mut base: i64 = 0;
        for m in members {
            // O `m` que corta o cluster abre o NOVO: ele não se perde.
            if !cluster.is_empty() && (m.size as f64 - base as f64) > base as f64 * 0.005 {
                t2.extend(dedup_group(format!("{nome}\u{0}{base}"), &cluster));
                cluster.clear();
            }
            if cluster.is_empty() {
                base = m.size;
            }
            cluster.push(m);
        }
        if !cluster.is_empty() {
            t2.extend(dedup_group(format!("{nome}\u{0}{base}"), &cluster));
        }
    }
    Ok(DedupPlan { t1, t2 })
}

#[path = "dedup_work.rs"]
mod dedup_work;
pub use dedup_work::*;

#[cfg(test)]
#[path = "dedup_tests.rs"]
mod dedup_tests;
