//! Transições puras de recheck. Rede, timers e persistência pertencem ao worker.
//!
//! Duas escalas: por HASH ([`recheck_step`], com prova de posse na expiração) e
//! por LOTE ([`lot_outcome`], com o settle e o LRU). `unknown` nunca é prova de
//! morte — só ausência de resposta, que mantém os contadores como estão.
//!
//! A terceira escala é a parada DERIVADA por progresso ([`derive_stall`]): bytes
//! parados por N passagens, sem sinal nativo — o `deriveStall` de
//! `src/providers/autofetch-progress.ts:57`. É CONTAGEM de passagens, não janela
//! de tempo: `autofetch-progress.ts:109-111` não olha relógio, e por isso
//! `now_ms` aqui só carimba a memória para observabilidade.

use adom_core::{expired_removal_allowed, ExpiredFacts};
use serde::{Deserialize, Serialize};

use super::debrid::TorrentProgress;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecheckAction {
    Ready,
    Pending,
    Unknown,
    TerminalDead,
    TerminalStalled,
    TerminalProgress,
    RemoveExpired,
    SuppressExpired,
    ReleaseExpired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecheckInput {
    pub cached: bool,
    pub status_ok: bool,
    pub state: Option<String>,
    pub stalled: bool,
    pub derived_stalled: bool,
    pub dead_streak: i64,
    pub stall_streak: i64,
    pub dead_threshold: i64,
    pub stall_threshold: i64,
    pub expired: bool,
    pub expired_facts: ExpiredFacts,
    pub remove_supported: bool,
    /// O status desse hash veio por id (`via === 'id'`), não por hash.
    pub via_id: bool,
    /// Knob `removeById`: só ele libera remover um torrent achado por id.
    pub remove_by_id_enabled: bool,
    pub id_present: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecheckStreaks {
    pub dead: i64,
    pub stalled: i64,
}

/// Atualiza contadores como a passagem do Node: morte e stall nativo têm
/// contadores independentes; falta de resposta mantém ambos. Um estado
/// observado sem sinal de morte/parada zera ambos, inclusive `unknown`
/// explícito do adaptador. Progresso derivado terminal limpa o lote fora daqui.
pub fn recheck_streaks(input: &RecheckInput) -> RecheckStreaks {
    let mut streaks = RecheckStreaks {
        dead: input.dead_streak,
        stalled: input.stall_streak,
    };
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    if input.state.as_deref() == Some("dead") {
        streaks.dead = streaks.dead.saturating_add(1);
    } else if input.stalled && input.stall_threshold > 0 {
        streaks.stalled = streaks.stalled.saturating_add(1);
    } else if !input.derived_stalled && input.status_ok && input.state.is_some() {
        streaks = RecheckStreaks {
            dead: 0,
            stalled: 0,
        };
    }
    streaks
}

/// Aplica a precedência do recheck: cache/pronto, morte/parada e, por fim,
/// expiração com prova de posse. Um status desconhecido nunca é prova de morte.
pub fn recheck_step(input: &RecheckInput) -> RecheckAction {
    if input.cached || input.state.as_deref() == Some("ready") {
        return RecheckAction::Ready;
    }
    let dead = input.state.as_deref() == Some("dead");
    let native_stalled = !dead && input.stalled && input.stall_threshold > 0;
    if dead && input.dead_streak.saturating_add(1) >= input.dead_threshold.max(1) {
        return RecheckAction::TerminalDead;
    }
    if native_stalled && input.stall_streak.saturating_add(1) >= input.stall_threshold {
        return RecheckAction::TerminalStalled;
    }
    if !dead && !native_stalled && input.derived_stalled {
        return RecheckAction::TerminalProgress;
    }
    if input.expired {
        if !input.remove_supported || !input.id_present {
            return RecheckAction::ReleaseExpired;
        }
        // `policyOk` do TS: achado por hash remove sempre; por id, só com o knob.
        let policy_ok = !input.via_id || input.remove_by_id_enabled;
        if policy_ok && expired_removal_allowed(&input.expired_facts) {
            return RecheckAction::RemoveExpired;
        }
        return RecheckAction::SuppressExpired;
    }
    if !input.status_ok || input.state.is_none() {
        return RecheckAction::Unknown;
    }
    RecheckAction::Pending
}

/// Memória de progresso de UM hash — o `ProgressMemory` do oráculo
/// (`src/providers/autofetch-progress.ts:31`): último valor de bytes, id da
/// transferência que produziu aquela leitura e o streak de observações
/// CONSECUTIVAS paradas.
///
/// `last_seen_ms` é acréscimo de observabilidade (painel/log): NÃO entra na
/// decisão. Inventar janela de tempo aqui seria régua nova — o oráculo conta
/// passagens (`autofetch-progress.ts:109`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressMemory {
    pub last_bytes: f64,
    #[serde(default)]
    pub last_id: String,
    pub streak: i64,
    #[serde(default)]
    pub last_seen_ms: i64,
}

// `Eq` à mão: `derive_stall` só grava `bytes` depois de `is_finite` e `>= 0`
// (`:74-77` do oráculo), então a memória nunca carrega `NaN` — o marcador é
// verdadeiro no uso real e o lote (que é `Eq`) continua derivando o trait.
impl Eq for ProgressMemory {}

/// O que a passagem observou de UM hash, e o que a memória já sabia dele.
#[derive(Clone, Copy, Debug)]
pub struct ProgressObservation<'a> {
    /// `state` do adaptador (`downloading`/`ready`/`dead`/`unknown`).
    pub state: Option<&'a str>,
    /// `progress` do status; `None` = serviço sem sinal medido.
    pub progress: Option<&'a TorrentProgress>,
    /// Id da transferência (`status.id` do oráculo): id diferente é OUTRO
    /// download visto pelo mesmo hash.
    pub transfer_id: Option<&'a str>,
    pub memory: Option<&'a ProgressMemory>,
    /// `autoFetchStallStreak`; `<= 0` desliga a derivação.
    pub threshold: i64,
    /// Instante desta passagem — só carimbo da memória.
    pub now_ms: i64,
}

/// Veredito da derivação de progresso para UM hash.
#[derive(Clone, Debug, PartialEq)]
pub enum ProgressVerdict {
    /// Sem sinal válido: memória INTOCADA e hash NÃO terminal. É o fail-safe de
    /// `autofetch-progress.ts:65-79` — ausência de campo nunca condena.
    NoSignal,
    /// Memória nova ou reiniciada (bytes crescendo, velocidade positiva, troca
    /// da transferência, regressão de bytes): não terminal.
    Moved(ProgressMemory),
    /// Bytes parados, ainda abaixo do limiar: não terminal.
    Still(ProgressMemory),
    /// Cruzou o limiar: parada DERIVADA (`autofetch-progress.ts:111`).
    Stalled(ProgressMemory),
}

impl ProgressVerdict {
    /// O hash cruzou o limiar de parada derivada?
    pub fn is_stalled(&self) -> bool {
        matches!(self, Self::Stalled(_))
    }

    /// Memória a gravar; `None` = intocada (sem sinal).
    pub fn memory(&self) -> Option<&ProgressMemory> {
        match self {
            Self::NoSignal => None,
            Self::Moved(memory) | Self::Still(memory) | Self::Stalled(memory) => Some(memory),
        }
    }
}

/// Derivação CONSERVADORA de parada por progresso — porte fiel de `deriveStall`
/// (`src/providers/autofetch-progress.ts:57-114`).
///
/// Um hash vira `stalled` derivado SÓ quando bytes E velocidade ficam parados
/// por `threshold` passagens CONSECUTIVAS; qualquer evidência contrária zera o
/// contador. Falso positivo condena um download que ainda esquentava, então a
/// regra erra para o lado de NÃO condenar:
///
/// - `threshold <= 0` acumula memória mas NUNCA devolve `Stalled`
///   (`autofetch-progress.ts:111`);
/// - hash pronto/morto/queued (state ≠ `downloading`) não é observado
///   (`:69`);
/// - campo não numérico, `total <= 0`, `bytes < 0` ou `bytes >= total` são SEM
///   sinal (`:74-79`);
/// - troca de `id`, regressão de bytes, bytes crescendo e `speed > 0`
///   reiniciam o streak (`:84-108`) — `seeders: 0` nunca sobrepõe velocidade
///   positiva;
/// - só `bytes` parado E `speed <= 0` acumula (`:109`).
///
/// Puro: nenhum I/O, nenhum relógio lido — `now_ms` entra por parâmetro.
pub fn derive_stall(obs: &ProgressObservation<'_>) -> ProgressVerdict {
    // Sem progresso = serviço sem sinal (ou item pronto/morto): uma janela sem
    // campo não é prova de nada (`autofetch-progress.ts:67`).
    let Some(progress) = obs.progress else {
        return ProgressVerdict::NoSignal;
    };
    // Só download ATIVO vira parada: queued/processing/unknown/ready/dead não.
    if obs.state != Some("downloading") {
        return ProgressVerdict::NoSignal;
    }
    let (Some(bytes), Some(total), Some(speed), Some(seeders)) = (
        progress.bytes,
        progress.total,
        progress.speed,
        progress.seeders,
    ) else {
        return ProgressVerdict::NoSignal;
    };
    // Os QUATRO campos entram na validação do oráculo (`:74-77`), inclusive
    // `seeders` — que não decide nada mas reprova a leitura se não for número.
    if !bytes.is_finite() || !total.is_finite() || !speed.is_finite() || !seeders.is_finite() {
        return ProgressVerdict::NoSignal;
    }
    if total <= 0.0 || bytes < 0.0 {
        return ProgressVerdict::NoSignal;
    }
    // Completo/limítrofe: o `ready` cuida (`autofetch-progress.ts:79`).
    if bytes >= total {
        return ProgressVerdict::NoSignal;
    }
    let id = obs.transfer_id.unwrap_or_default();
    let memory = |streak: i64| ProgressMemory {
        last_bytes: bytes,
        last_id: id.to_string(),
        streak,
        last_seen_ms: obs.now_ms,
    };
    let Some(prev) = obs.memory else {
        // Primeira observação: só abre a janela.
        return ProgressVerdict::Moved(memory(0));
    };
    // Troca da transferência: a leitura anterior era de OUTRO download.
    if !prev.last_id.is_empty() && !id.is_empty() && prev.last_id != id {
        return ProgressVerdict::Moved(memory(0));
    }
    // Regressão de bytes (contador resetado) e bytes crescendo são movimento.
    if bytes != prev.last_bytes {
        return ProgressVerdict::Moved(memory(0));
    }
    // Bytes parados, mas velocidade positiva é evidência de movimento.
    if speed > 0.0 {
        return ProgressVerdict::Moved(memory(0));
    }
    let streak = prev.streak.saturating_add(1);
    if obs.threshold > 0 && streak >= obs.threshold {
        return ProgressVerdict::Stalled(memory(streak));
    }
    ProgressVerdict::Still(memory(streak))
}

/// Fatos do LOTE ao fim de uma varredura, já sem os hashes resolvidos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LotFacts {
    /// Hashes ainda no lote.
    pub remaining: usize,
    pub is_settle: bool,
    pub attempts: i64,
    /// `autoFetchRecheckMax` efetivo.
    pub recheck_max: i64,
    /// `now - createdAt`, medido por quem tem relógio.
    pub age_ms: i64,
    /// Horizonte de settle já multiplicado (`autoFetchTtl * 1000`).
    pub settle_horizon_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LotOutcome {
    /// Lote assentou: `dropQueue` da busca. Só acontece com o lote vazio.
    Finished,
    /// Settle vencido: expira hash a hash, com prova de posse.
    Expired,
    /// Entrou em settle AGORA: roda o LRU e NÃO drena a fila.
    EnterSettle,
    /// Segue armado para a próxima passagem.
    Continue,
}

/// Ordem do `runRecheck` do Node, preservada: fim de lote, expiração do settle,
/// entrada em settle, continuação.
///
/// Entrar em settle NUNCA drena fila alguma: só evidência COMPROVADA repõe
/// (morto/parado nativo ou parada derivada). "Estar em settle" como motivo de
/// dreno era o dreno cego removido na Fase 0 e não volta por aqui.
pub fn lot_outcome(facts: LotFacts) -> LotOutcome {
    if facts.remaining == 0 {
        return LotOutcome::Finished;
    }
    if facts.is_settle && facts.age_ms >= facts.settle_horizon_ms {
        return LotOutcome::Expired;
    }
    if !facts.is_settle && facts.attempts >= facts.recheck_max {
        return LotOutcome::EnterSettle;
    }
    LotOutcome::Continue
}

/// Lote em estabilização visto pelo LRU (`manageSettleLru`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleLotRef {
    pub search_key: String,
    pub created_at: i64,
    pub info_hashes: Vec<String>,
    /// Só lotes JÁ em settle entram no LRU; os demais passam intactos.
    pub is_settle: bool,
    /// Adapter DONO do lote, gravado no enqueue/recheck. A evicção usa ESTE id —
    /// nunca o adapter "corrente", que no contexto de outra request pode ser
    /// outro serviço e deixaria a memória de progresso do lote para trás. Vazio
    /// = limpeza impossível (não inventa chave).
    pub adapter_id: String,
}

/// Quais lotes em settle saem quando o número passa de `max_lots`.
///
/// Evicta os mais ANTIGOS primeiro (ordem de `createdAt`, estável como o `sort`
/// do Node). Cada lote devolvido deve ter o timer limpo, os holds liberados e a
/// memória de progresso limpa com o PRÓPRIO `adapter_id`, antes do delete —
/// sem isso o lote settleado ocuparia vaga e hold até o TTL.
pub fn settle_lru_evictions(lots: &[SettleLotRef], max_lots: usize) -> Vec<SettleLotRef> {
    let mut settle: Vec<&SettleLotRef> = lots.iter().filter(|lot| lot.is_settle).collect();
    if settle.len() <= max_lots {
        return Vec::new();
    }
    settle.sort_by_key(|lot| lot.created_at);
    let excess = settle.len() - max_lots;
    settle.into_iter().take(excess).cloned().collect()
}

#[cfg(test)]
#[path = "recheck_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "recheck_lot_tests.rs"]
mod lot_tests;

// Derivação de progresso (`derive_stall`) — a Fase 3 do Chupim, com relógio e
// memória por parâmetro: arquivo próprio pela catraca de 400 linhas.
#[cfg(test)]
#[path = "recheck_progress_tests.rs"]
mod progress_tests;
