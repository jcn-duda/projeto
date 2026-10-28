//! Sonda dirigida (`br_probe`) como PASSO do worker nativo do Chupim.
//!
//! O efeito chega pelo tail (`tail_effects::BR_PROBE`), o worker o aceita como
//! `Job` e `serve::jobs::batch` o despacha para cá pelo `kind`:
//!
//! - [`plan`] traduz o payload em obra + indexers alvo (index-only ∩ pt-BR
//!   menos os isentos da busca viva) ou `Skip{motivo}`; quem decide AGENDAR é
//!   a régua pura `adom_autofetch::v3::probe_step`, com lease de `pending`,
//!   dedupe de `found`/`empty` e retry de `failed`/`capped`;
//! - [`execute`] pede a obra ao colhedor NATIVO (`HarvestHandle::enqueue`, com
//!   a flag `brProbe`) e grava o `pending` no KV pela chave que o Node lê
//!   (`autofetch:v3:probe:<sha256>`);
//! - [`settle`] é a metade pura: aceite + flag dirigida → `pending`; qualquer
//!   outra coisa → nada no KV.
//!
//! Regras: `pending` só com a entrada dirigida REALMENTE na fila (lease sem
//! sonda segura seeds à toa); `found`/`empty`/`failed`/`capped` não bloqueiam
//! sementes; nenhuma chamada de rede no caminho do `/stream` (o passo roda na
//! thread do worker); pausa ou fila cheia → `Skip` sem tocar o KV.

use adom_autofetch::v3::{
    probe_step as probe_decision, ProbeDecision, ProbeInput, ProbeRecord, ProbeSkip, ProbeState,
};
use adom_harvest::{
    is_valid_imdb_id, probe_key, BrProbeWork, EnqueueOutcome, HarvestMediaType, HarvestRequest,
};
use adom_index::NativeKv;
use serde_json::{Map, Value};

use crate::harvest::HarvestHandle;

/// Motivo do enqueue da sonda (o `reason` do `br-probe.ts`).
const REASON_BR_GAP: &str = "br-gap";

// A porta de produção (config do processo + leitura do registro + execução)
// mora em `probe_job` para caber no teto de 400 linhas. Reexportada aqui para
// `serve.rs` ter um dono só do passo.
pub(crate) use super::probe_job::{run, ProbeStepConfig};

/// Por que a sonda não foi agendada. Nome do `skipped` do `br-probe.ts`, para
/// o contador do painel continuar o mesmo durante o flip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeSkipReason {
    /// Payload fora de `{type: movie|series, imdbId: tt…}`.
    InvalidPayload,
    /// Worker pausado (`Control::paused`) — os dois passos, sonda e season.
    WorkerPaused,
    /// Fila do colhedor no teto.
    QueueFull,
    /// `RELEASE_INDEX` off: sem índice a sonda não tem onde escrever.
    ReleaseIndexOff,
    /// `AUTOFETCH_BR_PROBE` off.
    Disabled,
    /// Nenhum index-only é pt-BR (ou todos isentos): não há onde sondar.
    NoIntersection,
    /// Já existe sonda procurando (lease vivo).
    Pending,
    /// BR já provado: dedupe de 12h, seeds liberados.
    Found,
    /// Sondou e não achou há pouco: dedupe, seeds liberados.
    Empty,
    /// `failed`/`capped` dentro do retry curto.
    Retry,
}

impl ProbeSkipReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InvalidPayload => "invalid",
            Self::WorkerPaused => "paused",
            Self::QueueFull => "queue-full",
            Self::ReleaseIndexOff => "release-index-off",
            Self::Disabled => "disabled",
            Self::NoIntersection => "no-intersection",
            Self::Pending => "pending",
            Self::Found => "found",
            Self::Empty => "empty",
            Self::Retry => "retry",
        }
    }
}

impl From<ProbeSkip> for ProbeSkipReason {
    fn from(skip: ProbeSkip) -> Self {
        match skip {
            ProbeSkip::Disabled => Self::Disabled,
            ProbeSkip::Pending => Self::Pending,
            ProbeSkip::Found => Self::Found,
            ProbeSkip::Empty => Self::Empty,
            ProbeSkip::Retry => Self::Retry,
        }
    }
}

/// O que agendar: obra, indexers alvo e se havia `pending` órfão.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeSchedule {
    pub(crate) work: BrProbeWork,
    pub(crate) indexers: Vec<String>,
    /// Havia `pending` com lease vencido (crash/restart): reagendar é legítimo.
    pub(crate) orphan: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeStep {
    Schedule(ProbeSchedule),
    Skip(ProbeSkipReason),
}

/// Traduz o efeito `br_probe` em plano. `state` é o registro LIDO do KV
/// ([`read_state`]) — o plano não faz I/O.
pub(crate) fn plan(
    payload: &Map<String, Value>,
    state: Option<ProbeRecord>,
    config: &ProbeStepConfig,
    now_ms: i64,
) -> ProbeStep {
    let Some(work) = normalize(payload) else {
        return ProbeStep::Skip(ProbeSkipReason::InvalidPayload);
    };
    if config.paused {
        return ProbeStep::Skip(ProbeSkipReason::WorkerPaused);
    }
    if config.queue_full() {
        return ProbeStep::Skip(ProbeSkipReason::QueueFull);
    }
    // Ordem do `probeEnabled()`/`ineligibilityReason()` do TS: sem índice não
    // há sonda, e a interseção vazia é o último motivo.
    if !config.probe.release_index_enabled {
        return ProbeStep::Skip(ProbeSkipReason::ReleaseIndexOff);
    }
    if !config.probe.auto_fetch_br_probe {
        return ProbeStep::Skip(ProbeSkipReason::Disabled);
    }
    let indexers = config.indexers();
    if indexers.is_empty() {
        return ProbeStep::Skip(ProbeSkipReason::NoIntersection);
    }
    match probe_decision(ProbeInput {
        enabled: true,
        record: state,
        now_ms,
    }) {
        ProbeDecision::Schedule { orphan } => ProbeStep::Schedule(ProbeSchedule {
            work,
            indexers,
            orphan,
        }),
        ProbeDecision::Skip(reason) => ProbeStep::Skip(reason.into()),
    }
}

/// Payload → obra. `null` em S/E é obra inteira (o contrato do gateway não
/// aceita `null`, mas o efeito manda); tipo fora de `movie|series` é recusa,
/// nunca filme por omissão. Visível para a porta de produção (`probe_job`), que
/// precisa da obra para ler o registro do KV antes do plano.
pub(crate) fn normalize(payload: &Map<String, Value>) -> Option<BrProbeWork> {
    let imdb_id = payload.get("imdbId").and_then(Value::as_str)?.trim();
    if !is_valid_imdb_id(imdb_id) {
        return None;
    }
    let media_type = HarvestMediaType::parse(payload.get("type").and_then(Value::as_str)?)?;
    Some(BrProbeWork {
        media_type,
        imdb_id: imdb_id.to_string(),
        season: small_int(payload.get("season")),
        episode: small_int(payload.get("episode")),
    })
}

/// Número inteiro que caiba no contrato da fila; qualquer outra coisa é
/// ausência (uma temporada `"2"` em texto não vira identidade diferente).
fn small_int(value: Option<&Value>) -> Option<i32> {
    let raw = value?.as_i64()?;
    i32::try_from(raw).ok()
}

/// O `HarvestRequest` da sonda: `br-gap` + flag dirigida.
fn harvest_request(planned: &ProbeSchedule) -> HarvestRequest {
    HarvestRequest {
        imdb_id: planned.work.imdb_id.clone(),
        media_type: planned.work.media_type,
        season: planned.work.season,
        episode: planned.work.episode,
        reason: REASON_BR_GAP.to_string(),
        br_probe: true,
    }
}

/// Resultado do passo — espelho de `RequestBrProbeResult` do TS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeRun {
    /// A entrada dirigida está na fila (ou coalesceu numa execução em voo).
    pub(crate) scheduled: bool,
    /// `pending` gravado no KV: o lease vivo segura o pool de sementes.
    pub(crate) pending: bool,
    /// Motivo do não-agendamento (métrica/diagnóstico).
    pub(crate) skip: Option<&'static str>,
    /// Falha de KV/rede. Nunca derruba a passagem: vira log e contador.
    pub(crate) error: Option<String>,
}

impl ProbeRun {
    pub(crate) fn refused(reason: &'static str) -> Self {
        Self {
            scheduled: false,
            pending: false,
            skip: Some(reason),
            error: None,
        }
    }

    pub(crate) fn failed(err: String) -> Self {
        Self {
            scheduled: false,
            pending: false,
            skip: Some("store"),
            error: Some(err),
        }
    }
}

/// Pede a sonda ao colhedor nativo e grava o `pending`.
///
/// A ordem é a do TS: enfileira COM a flag `brProbe`, confirma na fila que a
/// obra está lá como sonda e só então grava o lease. `pending` sem entrada
/// dirigida congelaria o aviso de lista sem worker para executá-lo.
pub(crate) async fn execute(
    kv: &NativeKv,
    handle: &HarvestHandle,
    planned: &ProbeSchedule,
    config: &ProbeStepConfig,
    now_ms: i64,
) -> ProbeRun {
    let outcome = handle.enqueue(harvest_request(planned)).await;
    // `(queued, br_probe)` da fila + slot em voo — a mesma pergunta que o
    // `pendingNativeHarvest` do Node faz ao gateway.
    let directed = handle.pending(&planned.work.imdb_id).await;
    settle(
        kv,
        planned,
        outcome,
        directed.0 && directed.1,
        config.probe.ttl_seconds,
        now_ms,
    )
}

/// Metade PURA de [`execute`]: aceite + confirmação dirigida → `pending`.
pub(crate) fn settle(
    kv: &NativeKv,
    planned: &ProbeSchedule,
    outcome: EnqueueOutcome,
    directed: bool,
    ttl_seconds: u64,
    now_ms: i64,
) -> ProbeRun {
    if !outcome.accepted {
        // Pedido que nem entrou na fila não bloqueia sementes (`skipped`).
        return ProbeRun::refused(reason_label(outcome));
    }
    if !directed {
        // Aceito, mas sem a flag dirigida o worker faria colheita completa.
        return ProbeRun::refused("not-directed");
    }
    match write_pending(kv, &planned.work, ttl_seconds, now_ms) {
        Ok(()) => ProbeRun {
            scheduled: true,
            pending: true,
            skip: None,
            error: None,
        },
        Err(err) => ProbeRun::failed(err),
    }
}

/// Rótulo do motivo do enqueue. `EnqueueReason` não é `&'static str`; os que
/// sobrevivem ao mapeamento são os que o painel já conhece.
fn reason_label(outcome: EnqueueOutcome) -> &'static str {
    match outcome.reason.as_str() {
        "disabled" => "disabled",
        "invalid" => "invalid",
        "dedupe" => "dedupe",
        "capacity" => "capacity",
        "duplicate" => "duplicate",
        _ => "bridge",
    }
}

/// Chave do registro — a MESMA do napi (`autofetchV3ProbeKey`) e do TS.
pub(crate) fn state_key(work: &BrProbeWork) -> String {
    probe_key(work)
}

/// Leitura do registro. JSON podre é AUSÊNCIA de estado (como no TS), nunca um
/// estado inventado; falha de KV é erro (o chamador loga e segue).
pub(crate) fn read_state(
    kv: &NativeKv,
    work: &BrProbeWork,
    now_ms: i64,
) -> Result<Option<ProbeRecord>, String> {
    let Some(value) = kv.get_json(&state_key(work), now_ms)? else {
        return Ok(None);
    };
    match serde_json::from_value::<ProbeRecord>(value) {
        Ok(record) => Ok(Some(record)),
        Err(err) => {
            eprintln!(
                "[autofetch] registro de sonda ilegível em {}: {err}",
                state_key(work)
            );
            Ok(None)
        }
    }
}

/// Grava `pending` com o lease de 10 min (o aviso de 60 s nunca o sobrevive).
pub(crate) fn write_pending(
    kv: &NativeKv,
    work: &BrProbeWork,
    ttl_seconds: u64,
    now_ms: i64,
) -> Result<(), String> {
    write_record(kv, work, ProbeRecord::pending(now_ms), ttl_seconds, now_ms)
}

/// Estado FINAL (`found`/`empty`/`failed`/`capped`) sem lease. O colhedor
/// finaliza pelo próprio store (mesma tabela `cache`); esta porta fecha a sonda
/// que o worker do Chupim abriu.
///
/// O colhedor nativo GRAVA o estado final direto no store (§ sonda); esta porta
/// existe para o golden comparar com o `finishBrProbe` do TS — por isso o
/// `allow`: num alvo de bin ela só tem chamador nos testes.
#[allow(dead_code)]
pub(crate) fn finish(
    kv: &NativeKv,
    work: &BrProbeWork,
    state: ProbeState,
    ttl_seconds: u64,
    now_ms: i64,
) -> Result<(), String> {
    if state == ProbeState::Pending {
        return Err("pending não é estado final".to_string());
    }
    write_record(
        kv,
        work,
        ProbeRecord::new(state, now_ms),
        ttl_seconds,
        now_ms,
    )
}

fn write_record(
    kv: &NativeKv,
    work: &BrProbeWork,
    record: ProbeRecord,
    ttl_seconds: u64,
    now_ms: i64,
) -> Result<(), String> {
    let value = serde_json::to_value(record).map_err(|err| err.to_string())?;
    let ttl = i64::try_from(ttl_seconds).unwrap_or(i64::MAX).max(1);
    kv.put_json(&state_key(work), &value, ttl, now_ms)
}

#[cfg(test)]
#[path = "probe_step_tests.rs"]
mod tests;
