//! Tipos da cascata de dispatch do Chupim (só dados, zero decisão).
//!
//! Separado de `cascade.rs` pela catraca de linhas: a superfície de tipos com os
//! rótulos do trace já ocupa o suficiente para os dois não caberem num arquivo
//! só. Nenhuma regra mora aqui — só o vocabulário que o executor preenche e lê.

use adom_core::{ObraEntry, SeedsSelectionBlockReason, SeedsStopReason};

/// Pool do candidato na cascata.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CascadePool {
    Br,
    Any,
    Seeds,
}

impl CascadePool {
    pub const ALL: [Self; 3] = [Self::Br, Self::Any, Self::Seeds];

    pub fn index(self) -> usize {
        match self {
            Self::Br => 0,
            Self::Any => 1,
            Self::Seeds => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Br => "br",
            Self::Any => "any",
            Self::Seeds => "seeds",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "br" => Some(Self::Br),
            "any" => Some(Self::Any),
            "seeds" => Some(Self::Seeds),
            _ => None,
        }
    }
}

/// Motivo de DESISTÊNCIA: o candidato não é tentado nesta busca.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CascadeDrop {
    /// Toggle do autofetch desligado (`canAutoFetchBr`).
    Disabled,
    EmptyHash,
    /// Blacklist de mortas da conta.
    Dead,
    /// Hash apagado de propósito (`adrm`): o enqueue o recusa.
    Adrm,
    /// Sobreviveu só pelo waiver do piso de seeders: não é download que termina.
    SeedFloorWaived,
    /// Mesmo hash já visto nesta lista.
    Duplicate,
    /// `known == false`: nada a decidir.
    UnknownCache,
    /// Cobertura por qualidade-alvo, ou hash já tocável.
    AlreadyCached,
    /// Dublado (BR ou global) já tocável no pool `any`/`seeds`.
    StopHasBr,
    /// Qualquer cache no pool `seeds`, sem a exceção do título raro.
    StopHasCached,
    /// Instalação que só aceita dublado nunca aquece swarm.
    DubbedOnly,
    /// Lista P2P tocável: gastar a conta não melhora nada.
    SeedsPlayable,
    /// Sonda BR procurando AGORA (transitória).
    BrProbePending,
}

impl CascadeDrop {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::EmptyHash => "empty-hash",
            Self::Dead => "dead",
            Self::Adrm => "adrm",
            Self::SeedFloorWaived => "seed-floor-waived",
            Self::Duplicate => "duplicate",
            Self::UnknownCache => "unknown-cache",
            Self::AlreadyCached => "already-cached",
            Self::StopHasBr => "stop-has-br",
            Self::StopHasCached => "stop-has-cached",
            Self::DubbedOnly => "dubbed-only",
            Self::SeedsPlayable => "seeds-playable",
            Self::BrProbePending => "br-probe-pending",
        }
    }
}

/// Motivo de ADIAMENTO: o candidato fica para a fila/dreno.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CascadeDefer {
    Paused,
    /// Vaga da busca esgotada (teto compartilhado entre passe parcial e tardio).
    SearchSlotBusy,
    /// Teto por OBRA fechado e o overflow de upgrade não abriu.
    ObraCap,
    AccountGate,
    /// Orçamento horário cheio: backoff, nunca recusa.
    BudgetBackoff,
    /// Pool INFERIOR ao escolhido (`br` > `any` > `seeds`): não é tentado nesta
    /// busca, mas continua na fila para quando o pool de cima não render. Sem
    /// isso a decisão perderia o backup que o TS deixa na fila persistente.
    LowerPool,
}

impl CascadeDefer {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Paused => "paused",
            Self::SearchSlotBusy => "search-slot-busy",
            Self::ObraCap => "obra-cap",
            Self::AccountGate => "account-gate",
            Self::BudgetBackoff => "budget",
            Self::LowerPool => "lower-pool",
        }
    }
}

/// Limpeza da fila `seeds` que o gate decidiu (efeito do executor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsPurge {
    None,
    /// Bloqueio/seleção: só entradas `seeds` saem, `br`/`any` ficam intactas.
    All,
    /// Exceção do título raro: saem apenas as SEEDS já em cache.
    CachedOnly,
}

/// Resumo do pool seeds no trace (`blocked:<motivo>`, `allowed`, `n/a`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsTrace {
    NotEvaluated,
    Allowed,
    Blocked(SeedsBlock),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeedsBlock {
    BrProbePending,
    DubbedOnly,
    SeedsPlayable,
    StopHasBr,
    StopHasCached,
}

impl SeedsBlock {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BrProbePending => "br-probe-pending",
            Self::DubbedOnly => "dubbed-only",
            Self::SeedsPlayable => "seeds-playable",
            Self::StopHasBr => "stop-has-br",
            Self::StopHasCached => "stop-has-cached",
        }
    }
}

impl SeedsTrace {
    /// Rótulo do trace do Chupim (`seeds:` do `writeChupimTrace`).
    pub fn label(self) -> String {
        match self {
            Self::NotEvaluated => "n/a".to_string(),
            Self::Allowed => "allowed".to_string(),
            Self::Blocked(reason) => format!("blocked:{}", reason.as_str()),
        }
    }
}

/// Uma tentativa de enqueue, já na ORDEM de disparo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeAttempt {
    pub info_hash: String,
    pub pool: CascadePool,
    pub quality: Option<String>,
    pub slot_limit: Option<i64>,
    pub rare: bool,
    /// Reserva extra do teto por obra (uma por janela).
    pub overflow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeDeferred {
    pub candidate: CascadeAttempt,
    pub reason: CascadeDefer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeDropped {
    pub info_hash: String,
    pub pool: CascadePool,
    pub reason: CascadeDrop,
}

/// Candidato visto pela cascata: só os fatos que a decisão lê.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CascadeCandidate {
    pub info_hash: String,
    pub pool: CascadePool,
    pub quality: Option<String>,
    pub slot_limit: Option<i64>,
    pub rare: bool,
    /// Hash já tocável nesta conta.
    pub cached: bool,
    pub dead: bool,
    /// `reuploadBlocked` depois da chance de destravar pelo inventário.
    pub adrm: bool,
    /// Passou o piso de seeders sem o waiver.
    pub viable: bool,
}

/// Teto por obra medido: `caps`/`current` por pool e a visão combinada
/// (registro persistido + reservas vivas) que a regra de overflow lê.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObraCapFacts {
    pub caps: [i64; 3],
    pub current: [i64; 3],
    pub entries: Vec<ObraEntry>,
}

/// Fatos já medidos pelo executor. Nada aqui é lido de config/rede/relógio.
#[derive(Debug, Clone, PartialEq)]
pub struct CascadeFacts {
    pub enabled: bool,
    pub paused: bool,
    pub cache_known: bool,
    /// `cachedBrDubbedTargetQualities(streams, cached, { season })`.
    pub covered_qualities: Vec<String>,
    pub has_cached_br_dubbed: bool,
    pub has_cached_any_dubbed: bool,
    /// `probeBlocksSeeds(work)`: só `pending` com lease vivo bloqueia.
    pub probe_pending: bool,
    /// `seedsSelectionBlock(...)` — bloqueio de SELEÇÃO do pool seeds.
    pub seeds_block: Option<SeedsSelectionBlockReason>,
    /// `decideSeedsStop(...)` já com o cache conhecido.
    pub seeds_stop: Option<SeedsStopReason>,
    pub rare_over_cached: bool,
    /// Vagas restantes da busca (autoFetchMax / autoFetchTopSeedsMax).
    pub slots: i64,
    pub account_blocked: bool,
    pub budget_blocked: bool,
    pub obra: ObraCapFacts,
}

impl Default for CascadeFacts {
    fn default() -> Self {
        Self {
            enabled: true,
            paused: false,
            cache_known: true,
            covered_qualities: Vec::new(),
            has_cached_br_dubbed: false,
            has_cached_any_dubbed: false,
            probe_pending: false,
            seeds_block: None,
            seeds_stop: None,
            rare_over_cached: false,
            slots: 3,
            account_blocked: false,
            budget_blocked: false,
            obra: ObraCapFacts::default(),
        }
    }
}

/// Decisão completa da busca: o que tentar, em que ordem, e o que ficou de fora.
#[derive(Debug, Clone, PartialEq)]
pub struct CascadeDecision {
    pub pool: Option<CascadePool>,
    pub attempts: Vec<CascadeAttempt>,
    pub deferred: Vec<CascadeDeferred>,
    pub dropped: Vec<CascadeDropped>,
    pub seeds: SeedsTrace,
    pub purge: SeedsPurge,
}

impl CascadeDecision {
    /// Decisão vazia — `pub(super)` porque só a cascata constrói o esqueleto.
    pub(super) fn empty(pool: Option<CascadePool>) -> Self {
        Self {
            pool,
            attempts: Vec::new(),
            deferred: Vec::new(),
            dropped: Vec::new(),
            seeds: SeedsTrace::NotEvaluated,
            purge: SeedsPurge::None,
        }
    }
}
