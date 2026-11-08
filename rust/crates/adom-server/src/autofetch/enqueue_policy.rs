//! Preferências do USUÁRIO que o Chupim respeita (`policy` do `autofetch_batch`).
//!
//! Desde o corte do TS o lote chegava sem a config do usuário e três réguas
//! ficaram sem fato (medido no Docker local em 2026-11-08, Aranhaverso com o
//! 4K e o 1080p dublados já ⚡):
//!
//! - `dubbedOnly`: o pool `seeds` é release SEM dublagem — com ele ligado nunca
//!   aparece na lista, e o Chupim baixava 4K em inglês à toa. Agora o `seeds`
//!   sai ANTES do hold (nem sobe na checagem da AllDebrid);
//! - parada do `seeds` (`decide_seeds_stop`): com dublado ou qualquer coisa já
//!   em cache o pool de baixo não corre ([`seeds_stop`]);
//! - teto por qualidade (`max2160p`…): no máximo N dublados BR EM VOO por faixa,
//!   contando o lote da busca. Dublado é raro, então o excedente NUNCA é
//!   descartado — fica adiado na fila e sobe quando um dos N morre.
//!
//! O lote do recheck guarda a política e a qualidade de cada aceito: é de lá que
//! o dreno (que roda sem payload) lê o mesmo teto.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use adom_autofetch::v3::{CascadeAttempt, CascadePool, QueueCandidate, QueueV3};
use adom_core::{decide_seeds_stop, DecideSeedsStopInput, SeedsStopReason};
use adom_index::NativeKv;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::super::recheck::{self, Lot};
use super::super::Policy;
use crate::autofetch::enqueue_items::Item;

/// Política do usuário, gravada no lote (`policy`). Sem `policy` no payload
/// (gateway antigo) tudo fica desligado: o comportamento anterior.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UserPolicy {
    #[serde(default)]
    pub(crate) dubbed_only: bool,
    /// Teto por qualidade (`"1080p" → 2`); só valores positivos entram.
    #[serde(default)]
    pub(crate) quality_caps: BTreeMap<String, i64>,
}

impl UserPolicy {
    pub(crate) fn from_payload(payload: &Map<String, Value>) -> Self {
        let Some(policy) = payload.get("policy").and_then(Value::as_object) else {
            return Self::default();
        };
        let quality_caps = policy
            .get("qualityLimits")
            .and_then(Value::as_object)
            .map(|caps| {
                caps.iter()
                    .filter_map(|(quality, cap)| Some((quality.clone(), cap.as_i64()?)))
                    .filter(|(_, cap)| *cap > 0)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            dubbed_only: policy.get("dubbedOnly").and_then(Value::as_bool) == Some(true),
            quality_caps,
        }
    }

    fn cap_for(&self, quality: Option<&str>) -> Option<i64> {
        quality.and_then(|quality| self.quality_caps.get(quality).copied())
    }

    /// Com `dubbedOnly` o pool `seeds` sai do lote antes do hold. Devolve se
    /// algum item saiu.
    pub(crate) fn strip_seeds(&self, items: &mut Vec<Item>) -> bool {
        if !self.dubbed_only {
            return false;
        }
        let before = items.len();
        items.retain(|item| item.pool() != CascadePool::Seeds);
        items.len() != before
    }
}

/// `decideSeedsStop` com o cache já medido. O regime raro acima do cache não
/// é medido aqui: na dúvida o pool de baixo PARA (ele nunca é dublado).
pub(crate) fn seeds_stop(has_cached_dubbed: bool, cached_count: usize) -> Option<SeedsStopReason> {
    decide_seeds_stop(&DecideSeedsStopInput {
        has_cached_dubbed,
        cached_count: cached_count as i64,
        rare: false,
        rare_threshold: 0,
        adapter_cache_check: true,
        rare_over_cached: false,
    })
    .stop
}

/// Teto por qualidade de UM lote: contagem em voo + o que este lote aceitar.
#[derive(Debug, Default)]
pub(crate) struct QualityGate {
    user: UserPolicy,
    busy: HashMap<String, i64>,
    covered: BTreeSet<String>,
}

impl QualityGate {
    /// Em voo = hash do lote da busca com qualidade gravada e fora do `dead:`;
    /// qualidade que já ficou pronta no lote conta como cheia. `user` é a
    /// política do lote novo; o dreno (sem payload) passa `None` e usa a que
    /// o lote gravou no último aceite.
    pub(crate) fn load(
        kv: &NativeKv,
        user: Option<&UserPolicy>,
        scope: (&str, &str),
        search_key: &str,
        now_ms: i64,
    ) -> Result<Self, String> {
        let lot = recheck::read(kv, search_key, now_ms)?;
        let mut gate = Self {
            user: user
                .cloned()
                .or_else(|| lot.as_ref().map(|lot| lot.policy.clone()))
                .unwrap_or_default(),
            ..Self::default()
        };
        let Some(lot) = lot.filter(|_| !gate.user.quality_caps.is_empty()) else {
            return Ok(gate);
        };
        gate.covered = lot.ready_qualities.clone();
        let queue = QueueV3::new(kv);
        for hash in &lot.info_hashes {
            let Some(quality) = lot.qualities.get(hash) else {
                continue;
            };
            if !queue.is_dead(scope.0, scope.1, hash, now_ms)? {
                *gate.busy.entry(quality.clone()).or_default() += 1;
            }
        }
        Ok(gate)
    }

    /// O candidato BR estoura o teto da qualidade dele? Fora do pool `br` e
    /// sem teto configurado nunca barra.
    pub(crate) fn full(&self, pool: Option<&str>, quality: Option<&str>) -> bool {
        if pool != Some(CascadePool::Br.as_str()) {
            return false;
        }
        let Some(cap) = self.user.cap_for(quality) else {
            return false;
        };
        let quality = quality.unwrap_or_default();
        self.covered.contains(quality) || self.busy.get(quality).copied().unwrap_or(0) >= cap
    }

    /// Aceite de um BR: ocupa a vaga da qualidade e vai para o lote.
    pub(crate) fn accept(&mut self, attempt: &CascadeAttempt, out: &mut BTreeMap<String, String>) {
        self.take(attempt.pool.as_str(), &attempt.info_hash, attempt.quality.as_deref(), out);
    }

    /// Mesmo aceite, pelo candidato da fila (dreno).
    pub(crate) fn accept_queued(&mut self, candidate: &QueueCandidate, out: &mut BTreeMap<String, String>) {
        let pool = candidate.pool.as_deref().unwrap_or_default();
        self.take(pool, &candidate.info_hash, candidate.quality.as_deref(), out);
    }

    fn take(&mut self, pool: &str, hash: &str, quality: Option<&str>, out: &mut BTreeMap<String, String>) {
        let Some(quality) = quality.filter(|_| pool == CascadePool::Br.as_str()) else {
            return;
        };
        *self.busy.entry(quality.to_string()).or_default() += 1;
        out.insert(hash.to_ascii_lowercase(), quality.to_string());
    }

    /// Adia (sem descartar) o candidato do dreno cuja qualidade está cheia.
    pub(crate) fn defers(&self, candidate: &QueueCandidate) -> bool {
        self.full(candidate.pool.as_deref(), candidate.quality.as_deref())
    }

    /// Candidato do dreno que nunca deveria rodar: `seeds` com `dubbedOnly`
    /// (sai da fila, como o lote novo já faz).
    pub(crate) fn obsolete(&self, candidate: &QueueCandidate) -> bool {
        self.user.dubbed_only && candidate.pool.as_deref() == Some(CascadePool::Seeds.as_str())
    }

    pub(crate) fn user(&self) -> &UserPolicy {
        &self.user
    }
}

/// Grava no lote a política vista neste aceite e a qualidade dos BR aceitos.
pub(crate) fn record(
    kv: &NativeKv,
    policy: Policy,
    search_key: &str,
    user: &UserPolicy,
    accepted: &BTreeMap<String, String>,
    now_ms: i64,
) -> Result<(), String> {
    let Some(mut lot) = recheck::read(kv, search_key, now_ms)? else {
        return Ok(());
    };
    lot.policy = user.clone();
    for (hash, quality) in accepted {
        lot.qualities.insert(hash.to_ascii_lowercase(), quality.clone());
    }
    recheck::write(kv, &lot, policy, now_ms)
}

/// Qualidade que ficou pronta no lote: a faixa está coberta e o dreno não
/// dispara outro dublado nela.
pub(crate) fn note_ready(next: &mut Lot, hash: &str) {
    if let Some(quality) = next.qualities.get(hash).cloned() {
        next.ready_qualities.insert(quality);
    }
}

#[cfg(test)]
#[path = "enqueue_policy_tests.rs"]
mod tests;
