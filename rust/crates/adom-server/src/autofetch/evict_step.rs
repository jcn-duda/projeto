//! Evicção dos FALLBACKS da mesma obra (Chupim 2.0, F6) como PASSO do worker.
//!
//! Porte do TS removido na B4 (`autofetch-evict.ts` + `alldebrid-fallback-evict.ts`,
//! ambos apagados; só a leitura da prova `er:` ficou no Node, via `hasBrReady`).
//! Quem executa é o passo [`super::evict_job`], pela porta `evict`.
//!
//! # Uma régua, duas saídas
//!
//! [`walk`] é o único laço decisório; os planos diferem só em QUEM prova as
//! âncoras do delete. [`plan`] as exige aqui: `transfer_id` + NOME autoritativo
//! do acervo, porque a blindagem BR lê o filename (no TS apagado,
//! `alldebrid-fallback-evict.ts:97`). [`plan_hashes`] não as tem — o worker
//! nativo não vê filename — e quem as prova é a porta `evict`
//! (`adom-debrid/src/autofetch_ports_evict.rs`). `may_delete` vale nos dois.
//!
//! Kill-switch `DEBRID_AUTO_FETCH_EVICT_FALLBACK` (default **false**,
//! `src/config/debrid-evict.ts:13`) ou o alias `DEBRID_EVICT`; `max_per_run == 0`
//! desliga. Piso (`HARVEST_EVICT_FLOOR`) pronto mas desligado. Fiação em
//! `evict_job.rs`; nada aqui entra no caminho da resposta.

use std::collections::{BTreeMap, HashSet};

use adom_autofetch::v3::evict::{
    eligible_evictions, EvictAction, EvictCandidate, EvictInput, EvictReport, EvictSkip,
};
use adom_autofetch::v3::AutofetchDebrid;

/// Teto de remoções por passagem (`HARVEST_EVICT_MAX_PER_SEARCH`, clamp 0..=25).
const DEFAULT_MAX_PER_RUN: usize = 25;
/// Idade mínima do fallback (`DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS`).
const DEFAULT_MIN_AGE_MS: i64 = 1_800_000;
/// Piso de ocupação da conta (`HARVEST_EVICT_FLOOR`, 600 no TS).
const DEFAULT_FLOOR: u64 = 600;

/// Um item da obra: o registro F2 + o que o lote e a conta provam. Cada
/// booleano é uma PROVA positiva; os `Option` marcam o DESCONHECIDO.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EvictItem {
    pub(crate) hash: String,
    /// Âncora do delete. `None` = desconhecido (ver o doc do módulo).
    pub(crate) transfer_id: Option<String>,
    /// Nome autoritativo do acervo (`/magnet/status`). `None` = sem prova.
    pub(crate) name: Option<String>,
    /// Pool do registro F2: `br`, `any` ou `seeds`.
    pub(crate) pool: String,
    /// Vaga de overflow (C11): reserva de upgrade, nunca sai.
    pub(crate) overflow: bool,
    /// O marker novo (`obra` = digest da identidade) é DESTA obra.
    pub(crate) marker_matches_work: bool,
    /// Posse durável `adsub:v1`; `held`/`protected` são `adhold`/`adprot`.
    pub(crate) owned: bool,
    pub(crate) held: bool,
    pub(crate) protected: bool,
    /// Retenção BR (nome com sinal PT/site BR): blindagem destrutiva.
    pub(crate) br_retained: bool,
    /// `acceptedAt` do registro F2, em ms. `0` = sem data (não elegível).
    pub(crate) accepted_at: i64,
}

impl EvictItem {
    /// `may_delete` fail-closed: a conjunção que autoriza a remoção. VETO final
    /// do plano — só TIRA, nunca acrescenta (se divergir do crate, o seguro vence).
    pub(crate) fn may_delete(&self, now_ms: i64, min_age_ms: i64) -> bool {
        matches!(self.pool.as_str(), "any" | "seeds")
            && !self.overflow
            && self.marker_matches_work
            && self.owned
            && !self.held
            && !self.protected
            && !self.br_retained
            && self.accepted_at > 0
            && now_ms.saturating_sub(self.accepted_at) >= min_age_ms.max(0)
    }
}

/// Fatos do lote/obra. Dados, não I/O: o chamador entrega o que provou.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct EvictFacts {
    /// O ready que disparou a passagem é pool `br` + `dubbed` (registro F2).
    pub(crate) current_ready_is_br: bool,
    /// A obra já provou BR ready antes (chave `autofetch:v3:er:` do TS).
    pub(crate) work_has_prior_br_ready: bool,
    pub(crate) now_ms: i64,
    pub(crate) items: Vec<EvictItem>,
}

/// Ocupação medida da conta × piso. `used <= floor` = conta folgada.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Occupancy {
    pub(crate) used: u64,
    pub(crate) floor: u64,
}

/// Réguas e kill-switches da passagem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EvictGates {
    /// Kill-switch (`DEBRID_AUTO_FETCH_EVICT_FALLBACK`/`DEBRID_EVICT`, OFF).
    pub(crate) enabled: bool,
    /// Teto de remoções por passagem; `0` desliga mesmo com `enabled`.
    pub(crate) max_per_run: usize,
    /// Idade mínima desde o `acceptedAt`.
    pub(crate) min_age_ms: i64,
    /// Piso de ocupação; `None` = sem piso (a evicção por OBRA não usa).
    pub(crate) occupancy: Option<Occupancy>,
}

impl EvictGates {
    /// Kill-switch OFF: nenhum teste depende da env do processo.
    pub(crate) fn off() -> Self {
        Self {
            enabled: false,
            max_per_run: 0,
            min_age_ms: DEFAULT_MIN_AGE_MS,
            occupancy: None,
        }
    }

    /// Réguas do `.env` — os MESMOS defaults do Node, para o flip não mudar
    /// comportamento às cegas.
    pub(crate) fn from_env() -> Self {
        Self {
            enabled: truthy("DEBRID_AUTO_FETCH_EVICT_FALLBACK", false)
                || truthy("DEBRID_EVICT", false),
            max_per_run: env_num("HARVEST_EVICT_MAX_PER_SEARCH")
                .unwrap_or(DEFAULT_MAX_PER_RUN as i64)
                .clamp(0, DEFAULT_MAX_PER_RUN as i64) as usize,
            min_age_ms: env_num("DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS")
                .unwrap_or(DEFAULT_MIN_AGE_MS)
                .max(0),
            occupancy: None,
        }
    }

    /// Liga o piso com a ocupação MEDIDA; `None` mantém o gate desligado.
    pub(crate) fn with_occupancy(mut self, used: Option<u64>) -> Self {
        self.occupancy = used.map(|used| Occupancy {
            used,
            floor: env_num("HARVEST_EVICT_FLOOR")
                .unwrap_or(DEFAULT_FLOOR as i64)
                .max(0) as u64,
        });
        self
    }

    /// A passagem está ARMADA? Sem isto [`plan`]/[`plan_hashes`] devolvem vazio
    /// por construção, e quem chama distingue "desligado" de "nada elegível".
    pub(crate) fn armed(&self) -> bool {
        self.budget().is_some()
    }

    /// Quantas remoções a passagem pode fazer; `None` = parar aqui.
    fn budget(&self) -> Option<usize> {
        if !self.enabled || self.max_per_run == 0 {
            return None;
        }
        let Some(occupancy) = self.occupancy else {
            return Some(self.max_per_run);
        };
        // Vagas acima do piso; `None` = nada a podar.
        let headroom = occupancy.used.saturating_sub(occupancy.floor);
        usize::try_from(headroom).ok().filter(|value| *value > 0)
    }
}

/// Plano SEM âncora: os hashes autorizados + a contagem por motivo de pulo.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct HashPlan {
    /// Hashes na ordem do registro — teto da passagem já aplicado.
    pub(crate) hashes: Vec<String>,
    /// `EvictSkip::as_str()` → quantos itens.
    pub(crate) skips: BTreeMap<&'static str, usize>,
}

/// Plano da passagem COM âncora. Puro: nenhuma leitura de KV, nenhuma rede.
pub(crate) fn plan(facts: &EvictFacts, gates: &EvictGates) -> Vec<EvictAction> {
    walk(facts, gates, true)
        .into_iter()
        .map(Walked::into_action)
        .collect()
}

/// Plano SEM âncora: os hashes que o passo autoriza, para a porta de evicção
/// resolver hash → id e RE-PROVAR tudo antes do delete.
///
/// A decisão é a MESMA de [`plan`]: um só laço, sem duas réguas para divergir.
/// `transfer_id`/`name` não são exigidos aqui porque quem os obtém (e quem
/// aplica a blindagem BR no filename REAL) é a porta; `may_delete` segue sendo
/// o veto final.
pub(crate) fn plan_hashes(facts: &EvictFacts, gates: &EvictGates) -> HashPlan {
    let mut plan = HashPlan::default();
    for step in walk(facts, gates, false) {
        match step.reason {
            Some(reason) => *plan.skips.entry(reason.as_str()).or_default() += 1,
            None => plan.hashes.push(step.hash),
        }
    }
    plan
}

/// Uma linha do laço decisório: `reason` vazio = hash AUTORIZADO.
struct Walked {
    hash: String,
    reason: Option<EvictSkip>,
    /// Âncoras do delete: só existem no laço COM âncora ([`plan`]).
    transfer_id: Option<String>,
    name: Option<String>,
}

impl Walked {
    fn skip(hash: String, reason: EvictSkip) -> Self {
        Self {
            hash,
            reason: Some(reason),
            transfer_id: None,
            name: None,
        }
    }

    /// `Remove` exige as DUAS âncoras; qualquer ausência volta a ser pulo.
    fn into_action(self) -> EvictAction {
        match (self.reason, self.transfer_id, self.name) {
            (None, Some(transfer_id), Some(name)) => EvictAction::Remove {
                hash: self.hash,
                transfer_id,
                name,
            },
            (None, _, _) => skipped(self.hash, EvictSkip::NoTransferId),
            (Some(reason), _, _) => skipped(self.hash, reason),
        }
    }
}

/// O laço ÚNICO: [`plan`] e [`plan_hashes`] saem daqui (uma régua só).
fn walk(facts: &EvictFacts, gates: &EvictGates, anchors: bool) -> Vec<Walked> {
    // Kill-switch/piso: desligado, o plano é VAZIO (zero leitura, zero delete).
    let Some(budget) = gates.budget() else {
        return Vec::new();
    };
    let input = EvictInput {
        current_ready_is_br: facts.current_ready_is_br,
        work_has_prior_br_ready: facts.work_has_prior_br_ready,
        now: facts.now_ms,
        min_age_ms: gates.min_age_ms,
        candidates: facts.items.iter().map(candidate).collect(),
    };
    // Régua do crate: ela é a única que ACRESCENTA um hash à lista.
    let eligible: HashSet<String> = eligible_evictions(&input).into_iter().collect();
    let mut steps = Vec::with_capacity(facts.items.len());
    let mut seen = HashSet::new();
    let mut used = 0usize;
    for item in &facts.items {
        let hash = item.hash.trim().to_ascii_lowercase();
        if hash.is_empty() {
            steps.push(Walked::skip(hash, EvictSkip::EmptyHash));
            continue;
        }
        if !eligible.contains(&hash) {
            steps.push(Walked::skip(hash, skip_reason(item, facts, gates)));
            continue;
        }
        // Duas entradas do mesmo hash nunca viram dois deletes.
        if !seen.insert(hash.clone()) {
            steps.push(Walked::skip(hash, EvictSkip::Duplicate));
            continue;
        }
        // Veto final: `may_delete` só pode tirar (retenção BR, idade, posse).
        if !item.may_delete(facts.now_ms, gates.min_age_ms) {
            steps.push(Walked::skip(hash, EvictSkip::Veto));
            continue;
        }
        // Âncoras: só na via COM âncora; na via por hash quem prova é a porta.
        let mut transfer_id = None;
        let mut name = None;
        if anchors {
            let Some(id) = non_empty(item.transfer_id.as_deref()) else {
                steps.push(Walked::skip(hash, EvictSkip::NoTransferId));
                continue;
            };
            let Some(file) = non_empty(item.name.as_deref()) else {
                steps.push(Walked::skip(hash, EvictSkip::NoName));
                continue;
            };
            transfer_id = Some(id.to_string());
            name = Some(file.to_string());
        }
        // Teto da passagem: o excedente sai ROTULADO, nunca em silêncio.
        if used >= budget {
            steps.push(Walked::skip(hash, EvictSkip::OverLimit));
            continue;
        }
        used += 1;
        steps.push(Walked {
            hash,
            reason: None,
            transfer_id,
            name,
        });
    }
    steps
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|text| !text.is_empty())
}

/// Executa o plano item a item (`remove(transfer_id)`), parando no primeiro erro.
pub(crate) async fn execute(
    io: &dyn AutofetchDebrid<Error = String>,
    actions: &[EvictAction],
) -> EvictReport {
    adom_autofetch::v3::evict::execute(io, actions).await
}

/// Plano + execução, na ordem do TS: decidir TUDO antes de apagar.
pub(crate) async fn run(
    io: &dyn AutofetchDebrid<Error = String>,
    facts: &EvictFacts,
    gates: &EvictGates,
) -> EvictReport {
    let actions = plan(facts, gates);
    execute(io, &actions).await
}

fn candidate(item: &EvictItem) -> EvictCandidate {
    EvictCandidate {
        hash: item.hash.trim().to_string(),
        pool: item.pool.clone(),
        overflow: item.overflow,
        marker_matches_work: item.marker_matches_work,
        owned: item.owned,
        held: item.held,
        // O crate não conhece `brOriginMark`: retenção BR entra como proteção.
        protected: item.protected || item.br_retained,
        accepted_at: item.accepted_at,
    }
}

/// Motivo do pulo de um item que a régua do crate recusou. Espelho da
/// conjunção de `eligible_evictions` — só ROTULA; quem decide é o crate.
fn skip_reason(item: &EvictItem, facts: &EvictFacts, gates: &EvictGates) -> EvictSkip {
    let age = facts.now_ms.saturating_sub(item.accepted_at);
    if !facts.current_ready_is_br && !facts.work_has_prior_br_ready {
        EvictSkip::NoBrProof
    } else if !matches!(item.pool.as_str(), "any" | "seeds") {
        EvictSkip::PoolBr
    } else if item.overflow {
        EvictSkip::Overflow
    } else if !item.marker_matches_work {
        EvictSkip::OtherWork
    } else if !item.owned {
        EvictSkip::NoOwnership
    } else if item.held {
        EvictSkip::Held
    } else if item.br_retained {
        EvictSkip::BrRetained
    } else if item.protected {
        EvictSkip::Protected
    } else if item.accepted_at <= 0 {
        EvictSkip::NoAcceptedAt
    } else if age < gates.min_age_ms.max(0) {
        EvictSkip::TooYoung
    } else {
        EvictSkip::Veto
    }
}

fn skipped(hash: String, reason: EvictSkip) -> EvictAction {
    EvictAction::Skip { hash, reason }
}

fn truthy(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(raw) => matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "on" | "1" | "true" | "yes"
        ),
        Err(_) => default,
    }
}

fn env_num(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}

#[cfg(test)]
#[path = "evict_step_tests.rs"]
mod tests;
