//! Evicção dos FALLBACKS da mesma obra (Chupim 2.0, F6) como PASSO do worker.
//!
//! Espelho de `src/providers/autofetch-evict.ts` (política) +
//! `src/debrid/alldebrid-fallback-evict.ts` (executor), que hoje só rodam pelo
//! recheck do Node (`src/providers/autofetch-recheck.ts:299`). O
//! `eligible_evictions` do crate (`adom-autofetch/src/v3/evict.rs`) existe desde
//! a T3-L5 e **não tinha chamador** — este módulo é a ponte.
//!
//! # As três metades
//!
//! - [`plan`] é PURA: fatos do lote/obra entram, [`EvictAction`] sai. Quem
//!   decide QUE hash pode sair é o crate (`eligible_evictions`); este módulo
//!   acrescenta os VETOS fail-closed que o crate não modela (âncora do delete,
//!   nome autoritativo, retenção BR) e o teto da passagem;
//! - `adom_autofetch::v3::execute` é a única que toca a rede: um
//!   `remove(transfer_id)` por item, parando no primeiro erro;
//! - [`gates_from_env`] traduz as envs nas réguas da passagem.
//!
//! # Fail-closed (o que NUNCA vira remoção)
//!
//! - hash sem `transfer_id`: nenhum dos cinco serviços apaga **por hash** (a
//!   porta responde `unsupported: evict`,
//!   `adom-debrid/src/autofetch_ports_inner.rs:210`). Sem id não há como pedir
//!   a remoção;
//! - hash sem NOME autoritativo do acervo: sem o filename não há
//!   `brOriginMark` — a blindagem de última milha que poupa release BR com
//!   acento/`filmes` (`src/debrid/alldebrid-fallback-evict.ts:97`);
//! - proteção durável (`adprot`), retenção BR, hold, posse ausente, marker de
//!   OUTRA obra, `overflow` (reserva deliberada de upgrade) e pool `br`: o
//!   crate já os recusa; aqui eles ganham o motivo do pulo (métrica/painel).
//!
//! # Kill-switches
//!
//! `DEBRID_AUTO_FETCH_EVICT_FALLBACK` (default **false**, o mesmo de
//! `src/config/debrid-evict.ts:13`); `DEBRID_EVICT` é aceito como ALIAS porque o
//! pedido de fiação usou esse nome e ele **não existe no TS**. O piso de
//! ocupação (`HARVEST_EVICT_FLOOR`, `src/config/debrid.ts:164`) fica pronto em
//! [`EvictGates::occupancy`], mas desligado por omissão: quem usa piso é a
//! evicção POR BUSCA (item 8.16), não a por obra.
//!
//! # Fiação (fora deste arquivo)
//!
//! `serve.rs::timers`, depois de o recheck provar o ready BR. Nada aqui entra no
//! caminho da resposta.

use std::collections::HashSet;

use adom_autofetch::v3::evict::{
    eligible_evictions, EvictAction, EvictCandidate, EvictInput, EvictReport, EvictSkip,
};
use adom_autofetch::v3::AutofetchDebrid;

/// Teto de remoções por passagem quando ninguém configurou nada — o mesmo
/// `HARVEST_EVICT_MAX_PER_SEARCH` (clamp 0..=25, `src/config/debrid.ts:161`).
const DEFAULT_MAX_PER_RUN: usize = 25;
/// Idade mínima do fallback (`DEBRID_AUTO_FETCH_EVICT_FALLBACK_MIN_AGE_MS`,
/// 30 min no TS — `src/config/debrid-evict.ts:16`).
const DEFAULT_MIN_AGE_MS: i64 = 1_800_000;
/// Piso de ocupação da conta (`HARVEST_EVICT_FLOOR`, 600 no TS).
const DEFAULT_FLOOR: u64 = 600;

/// Um item da obra: o registro F2 do Chupim + o que o lote e a conta provam.
///
/// Cada booleano é uma PROVA positiva; os `Option` marcam o DESCONHECIDO
/// (`transfer_id`/`name` ausentes nunca autorizam remoção).
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
    /// Posse durável `adsub:v1` presente.
    pub(crate) owned: bool,
    /// Hold volátil/`adhold:v1` vivo.
    pub(crate) held: bool,
    /// Proteção durável `adprot:v1` (acervo BR do usuário).
    pub(crate) protected: bool,
    /// Retenção BR (nome com sinal PT/site BR): blindagem destrutiva.
    pub(crate) br_retained: bool,
    /// `acceptedAt` do registro F2, em ms. `0` = sem data (não elegível).
    pub(crate) accepted_at: i64,
}

impl EvictItem {
    /// `may_delete` fail-closed: a conjunção que autoriza a remoção. Serve de
    /// VETO final no plano — pode só TIRAR, nunca acrescentar (se divergir da
    /// régua do crate, o lado seguro vence).
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

impl Occupancy {
    /// Vagas acima do piso; `None` = nada a podar.
    fn headroom(self) -> Option<usize> {
        let headroom = self.used.saturating_sub(self.floor);
        usize::try_from(headroom).ok().filter(|value| *value > 0)
    }
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

    /// Liga o piso com a ocupação MEDIDA (`AutofetchDebrid::account`). `None`
    /// mantém o gate desligado: sem medida, nada de piso inventado.
    pub(crate) fn with_occupancy(mut self, used: Option<u64>) -> Self {
        self.occupancy = used.map(|used| Occupancy {
            used,
            floor: env_num("HARVEST_EVICT_FLOOR")
                .unwrap_or(DEFAULT_FLOOR as i64)
                .max(0) as u64,
        });
        self
    }

    /// Quantas remoções a passagem pode fazer; `None` = parar aqui.
    fn budget(&self) -> Option<usize> {
        if !self.enabled || self.max_per_run == 0 {
            return None;
        }
        match self.occupancy {
            Some(occupancy) => occupancy.headroom(),
            None => Some(self.max_per_run),
        }
    }
}

/// Plano da passagem. Puro: nenhuma leitura de KV, nenhuma rede.
pub(crate) fn plan(facts: &EvictFacts, gates: &EvictGates) -> Vec<EvictAction> {
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
    let mut actions = Vec::with_capacity(facts.items.len());
    let mut seen = HashSet::new();
    let mut used = 0usize;
    for item in &facts.items {
        let hash = item.hash.trim().to_ascii_lowercase();
        if hash.is_empty() {
            actions.push(skipped(hash, EvictSkip::EmptyHash));
            continue;
        }
        if !eligible.contains(&hash) {
            let reason = skip_reason(item, facts, gates);
            actions.push(skipped(hash, reason));
            continue;
        }
        if !seen.insert(hash.clone()) {
            // Duas entradas do mesmo hash nunca viram dois deletes.
            actions.push(skipped(hash, EvictSkip::Duplicate));
            continue;
        }
        // Veto final: `may_delete` só pode tirar (retenção BR, idade, posse).
        if !item.may_delete(facts.now_ms, gates.min_age_ms) {
            actions.push(skipped(hash, EvictSkip::Veto));
            continue;
        }
        let Some(transfer_id) = item
            .transfer_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            actions.push(skipped(hash, EvictSkip::NoTransferId));
            continue;
        };
        let Some(name) = item
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        else {
            actions.push(skipped(hash, EvictSkip::NoName));
            continue;
        };
        if used >= budget {
            actions.push(skipped(hash, EvictSkip::OverLimit));
            continue;
        }
        used += 1;
        actions.push(EvictAction::Remove {
            hash,
            transfer_id: transfer_id.to_string(),
            name: name.to_string(),
        });
    }
    actions
}

/// Executa o plano item a item (`remove(transfer_id)`), parando no primeiro
/// erro. Delega ao executor do crate, que é quem conhece o trait do debrid.
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
        // A régua do crate não conhece `brOriginMark`: retenção BR entra como
        // proteção (o crate recusa e o rótulo do pulo continua `br-retained`).
        protected: item.protected || item.br_retained,
        accepted_at: item.accepted_at,
    }
}

/// Motivo do pulo de um item que a régua do crate recusou. Espelho da
/// conjunção de `eligible_evictions` — só para ROTULAR; quem decide é o crate.
fn skip_reason(item: &EvictItem, facts: &EvictFacts, gates: &EvictGates) -> EvictSkip {
    if !facts.current_ready_is_br && !facts.work_has_prior_br_ready {
        return EvictSkip::NoBrProof;
    }
    if !matches!(item.pool.as_str(), "any" | "seeds") {
        return EvictSkip::PoolBr;
    }
    if item.overflow {
        return EvictSkip::Overflow;
    }
    if !item.marker_matches_work {
        return EvictSkip::OtherWork;
    }
    if !item.owned {
        return EvictSkip::NoOwnership;
    }
    if item.held {
        return EvictSkip::Held;
    }
    if item.br_retained {
        return EvictSkip::BrRetained;
    }
    if item.protected {
        return EvictSkip::Protected;
    }
    if item.accepted_at <= 0 {
        return EvictSkip::NoAcceptedAt;
    }
    if facts.now_ms.saturating_sub(item.accepted_at) < gates.min_age_ms.max(0) {
        return EvictSkip::TooYoung;
    }
    EvictSkip::Veto
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
