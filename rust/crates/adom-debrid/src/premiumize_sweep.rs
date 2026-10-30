//! Varredura de transferências mortas ou paradas do Premiumize (porte de
//! `sweepDead` de `src/debrid/premiumize.ts`). Aqui só a DECISÃO: quem lista,
//! lê os markers e remove é `api_sweep.rs`.
//!
//! Diferença deliberada do TS: a memória de paradas é de PROCESSO e serve a
//! todas as contas; a poda ("quem não foi visto agora some") fica escopada à
//! conta da varredura, para uma conta não apagar a memória de outra.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::premiumize::autofetch::{number, scalar, transfer_hash, STALLED};

/// Prefixo dos markers de aceite de uma conta (`autofetch:v3:m:premiumize:<conta>:`).
pub fn marker_prefix(account: &str) -> String {
    format!("autofetch:v3:m:premiumize:{account}:")
}

/// Chave da memória de paradas: `<conta>:<hash>`. A conta é sha256 em hex,
/// sem `:`, então o prefixo `<conta>:` é inequívoco.
pub fn memory_key(account: &str, hash: &str) -> String {
    format!("{account}:{hash}")
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SweepPlan {
    /// (id da transferência, hash quando a cascata o conhece) a remover.
    pub targets: Vec<(String, Option<String>)>,
    /// Hashes distintos vistos parados agora (erro não conta).
    pub observed: usize,
}

/// id da transferência -> hash, a partir das linhas vivas dos markers da conta.
/// Marker legado (`1`), sem `id` ou com `id` nulo/vazio não identifica nada.
pub fn by_id_from_markers(rows: &[(String, String)], account: &str) -> HashMap<String, String> {
    let prefix = marker_prefix(account);
    let mut out = HashMap::new();
    for (key, value) in rows {
        let Some(hash) = key.strip_prefix(&prefix) else {
            continue;
        };
        if !is_hash(hash) {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(value) else {
            continue;
        };
        let Some(id) = parsed.get("id").and_then(scalar).filter(|s| !s.is_empty()) else {
            continue;
        };
        out.insert(id, hash.to_lowercase());
    }
    out
}

/// Decide o que sai e atualiza a memória de paradas (`memory`, de processo).
///
/// - `error` é alvo sempre (sem hash, idade ou proteção).
/// - `running` só conta como parado se o progresso é 0/ausente E a mensagem
///   denuncia zero pares/zero bytes. Sem hash pela cascata ou `held` → pula.
/// - Primeira vista só anota `now_ms`; vista posterior com `min_age_ms`
///   cumprido vira alvo.
/// - Ao fim, poda da memória os hashes DESTA conta que não foram vistos.
pub(crate) fn plan_sweep(
    transfers: &[Value],
    by_id: &HashMap<String, String>,
    held: impl Fn(&str) -> bool,
    memory: &mut HashMap<String, i64>,
    account: &str,
    now_ms: i64,
    min_age_ms: i64,
) -> SweepPlan {
    let mut plan = SweepPlan::default();
    let mut seen: HashSet<String> = HashSet::new();
    for transfer in transfers {
        let Some(id) = transfer
            .get("id")
            .and_then(scalar)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let status = transfer
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if status == "error" {
            let hash = transfer_hash(transfer, by_id).map(|(hash, _)| hash);
            plan.targets.push((id, hash));
            continue;
        }
        if status != "running" {
            continue;
        }
        let moving = transfer
            .get("progress")
            .and_then(number)
            .is_some_and(|progress| progress != 0.0);
        let message = transfer
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("");
        if moving || !STALLED.is_match(message) {
            continue;
        }
        // Parada, mas só removível quando a cascata prova o hash. Sem prova
        // ou protegido pelo hold, a transferência fica onde está.
        let Some((hash, _)) = transfer_hash(transfer, by_id) else {
            continue;
        };
        if held(&hash) {
            continue;
        }
        let key = memory_key(account, &hash);
        let since = memory.get(&key).copied();
        seen.insert(hash.clone());
        match since {
            None => {
                memory.insert(key, now_ms);
            }
            Some(since) if now_ms - since >= min_age_ms => {
                plan.targets.push((id, Some(hash)));
            }
            Some(_) => {}
        }
    }
    // Quem voltou a andar (ou saiu da conta) perde o histórico de parada.
    // Só desta conta: a memória é compartilhada entre contas.
    let prefix = format!("{account}:");
    memory.retain(|key, _| match key.strip_prefix(&prefix) {
        Some(hash) => seen.contains(hash),
        None => true,
    });
    plan.observed = seen.len();
    plan
}

fn is_hash(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
#[path = "premiumize_sweep_tests.rs"]
mod tests;
