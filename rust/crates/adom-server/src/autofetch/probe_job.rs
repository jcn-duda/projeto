//! Porta de PRODUÇÃO da sonda dirigida: config do processo, leitura do
//! registro e execução, na ordem do `br-probe.ts`.
//!
//! [`probe_step`](super::probe_step) guarda a régua (plano puro, `settle`,
//! escrita do lease) e [`ProbeStepConfig`] nasceu aqui para o arquivo da régua
//! caber no teto de 400 linhas. A divisão é só de tamanho: nenhuma decisão nova.
//!
//! # Por que a config é lida A CADA job
//!
//! O worker nasce antes do orquestrador (`proxy::run`), então não existe
//! `OrchestratorConfig` para consultar. As listas de indexers vêm do MESMO
//! `harvest` que alimenta o drain (`index_only_indexers`/`live_exempt_indexers`,
//! env do processo) e o resto são toggles do `.env` que o painel também lê: ler a
//! cada job evita config congelada no boot, como no Node.
//!
//! O toggle da sonda (`autoFetchBrProbe`) tem precedência **live > `.env` >
//! default**: o valor do painel chega pelo overlay (`live::LiveOverlay`) e o
//! `.env` só vale quando não há override — o mesmo `effective()` do TS
//! (`src/utils/autofetch-live.ts:149`).
//!
//! Nada aqui carrega credencial: a chave vive no cofre e o `HarvestRequest` só
//! leva obra + temporada/episódio.

use adom_harvest::{BrProbe, ProbeConfig};
use adom_index::NativeKv;
use serde_json::{Map, Value};

use super::probe_step::{self, normalize, ProbeRun, ProbeSkipReason, ProbeStep};
use crate::harvest::HarvestHandle;

/// Réguas e fatos do instante em que o passo roda.
pub(crate) struct ProbeStepConfig {
    /// Toggle, `RELEASE_INDEX`, interseção e TTL — as mesmas réguas do
    /// `adom-harvest` (nenhuma lista é replicada aqui).
    pub(crate) probe: ProbeConfig,
    /// Kill-switch do worker (`Control::paused`), lido na passagem.
    pub(crate) paused: bool,
    /// Profundidade atual da fila do colhedor.
    pub(crate) queue_len: usize,
    /// Teto da fila (`HARVEST_QUEUE_MAX`); `0` = sem teto.
    pub(crate) queue_max: usize,
}

impl ProbeStepConfig {
    /// Réguas do processo. `paused` e a fila vêm da passagem (estado vivo) e o
    /// toggle da sonda vem do PAINEL quando ele existe: **live > `.env` >
    /// default** (`true`, como o `String(env || 'true')` do TS).
    pub(crate) fn from_env(
        paused: bool,
        queue_len: usize,
        queue_max: usize,
        br_probe: Option<bool>,
    ) -> Self {
        Self {
            probe: ProbeConfig {
                release_index_enabled: env_flag("RELEASE_INDEX"),
                auto_fetch_br_probe: br_probe.unwrap_or_else(|| env_flag("AUTOFETCH_BR_PROBE")),
                index_only_indexers: crate::harvest::index_only_indexers(),
                pt_br_indexers: adom_sources::JackettConfig::from_env().pt_br_indexers,
                live_exempt_indexers: crate::harvest::live_exempt_indexers(),
                // `Math.max(60, trunc(num(env, 43200)))` do TS.
                ttl_seconds: env_num("BR_PROBE_TTL_S").unwrap_or(43_200).max(60) as u64,
            },
            paused,
            queue_len,
            queue_max,
        }
    }

    /// Fila cheia: o `enqueue` recusaria com `Capacity` e ainda evictaria a
    /// cauda, então a sonda nem sai.
    pub(crate) fn queue_full(&self) -> bool {
        self.queue_max > 0 && self.queue_len >= self.queue_max
    }

    /// Indexers alvo: index-only ∩ pt-BR, menos os isentos da busca viva.
    pub(crate) fn indexers(&self) -> Vec<String> {
        BrProbe::new(self.probe.clone())
            .probe_indexers()
            .into_iter()
            .map(str::to_string)
            .collect()
    }
}

/// Um job `br_probe` inteiro: obra → registro → plano → enqueue + lease.
///
/// Payload fora da forma é `invalid` (sem I/O). Falha de KV é `store` e volta
/// como erro de passagem, nunca como pânico da thread do worker.
pub(crate) async fn run(
    kv: &NativeKv,
    handle: &HarvestHandle,
    payload: &Map<String, Value>,
    config: &ProbeStepConfig,
    now_ms: i64,
) -> ProbeRun {
    let Some(work) = normalize(payload) else {
        return ProbeRun::refused(ProbeSkipReason::InvalidPayload.as_str());
    };
    let state = match probe_step::read_state(kv, &work, now_ms) {
        Ok(state) => state,
        Err(err) => return ProbeRun::failed(err),
    };
    match probe_step::plan(payload, state, config, now_ms) {
        ProbeStep::Schedule(planned) => {
            probe_step::execute(kv, handle, &planned, config, now_ms).await
        }
        ProbeStep::Skip(reason) => ProbeRun::refused(reason.as_str()),
    }
}

/// `String(env || 'true') === 'true'` do TS: ausente liga, qualquer outro
/// valor (inclusive vazio ou `1`) desliga.
fn env_flag(key: &str) -> bool {
    std::env::var(key)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

fn env_num(key: &str) -> Option<i64> {
    std::env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
}
