//! Env, montagem e `spawn` do agendador das varreduras da AllDebrid.
//!
//! Separado do núcleo (`al_sweeps.rs`) para o arquivo caber no teto de 400
//! linhas. Nada aqui decide plano nem fala com a conta: só lê flag, escolhe as
//! portas de produção, monta o [`SweepAdmin`] e mantém o laço.
//!
//! [`spawn`] devolve [`SweepRuntime`] **sempre**: com `sweeper: Some` quando
//! conta, cliente HTTP e intervalo permitem, ou com `sweeper: None` e um
//! `disabled_reason` explícito. O `GET /sweeps` funciona desligado (é o que o
//! painel mostra); o `POST /sweeps/run` responde 409/503 com o mesmo motivo.

use std::sync::Arc;
use std::time::Duration;

use adom_debrid::alldebrid_cleanup::{kill_switch_on, CleanupMode, CLEANUP_ENV};
use adom_debrid::alldebrid_sweeps::SweepMode;

use super::stats::SweepSnapshot;
use super::{effects, native, FactSource, SweepSource, Sweeper};

/// Intervalo mínimo entre rodadas do MESMO tipo. `0` desliga o agendamento.
pub(crate) const SWEEP_MS_ENV: &str = "DEBRID_AL_SWEEP_MS";
/// 6 h: varredura destrutiva não é caminho quente.
pub(crate) const DEFAULT_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
/// Freio de APLICAÇÃO das varreduras destrutivas (default **OFF**): mesmo com
/// `DEBRID_AL_CLEANUP=on`, o modo só vira `Apply` com este gate ligado. OFF =
/// exatamente o diagnóstico read-only de sempre — a virada é uma decisão
/// explícita do operador, não um efeito colateral da flag de limpeza.
pub(crate) const APPLY_GATE_ENV: &str = "DEBRID_AL_SWEEP_APPLY";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settings {
    pub(crate) mode: SweepMode,
    pub(crate) interval_ms: i64,
}

impl Settings {
    /// Modo/intervalo EFETIVOS do processo — nunca `None`: a rota precisa dizer
    /// `mode` e `intervalMs` mesmo desligada, e o motivo sai de
    /// [`disabled_reason`].
    pub(crate) fn from_env() -> Self {
        effective_from(
            std::env::var(SWEEP_MS_ENV).ok().as_deref(),
            std::env::var(CLEANUP_ENV).ok().as_deref(),
            kill_switch_on(),
            apply_gate_on(),
        )
    }
}

/// `DEBRID_AL_SWEEP_MS`: ausente/vazio/ilegível = 6 h; `<= 0` desliga.
pub(crate) fn interval_from(raw: Option<&str>) -> i64 {
    match raw.map(str::trim) {
        None | Some("") => DEFAULT_INTERVAL_MS,
        Some(text) => text
            .parse::<i64>()
            .map(|ms| ms.max(0))
            .unwrap_or(DEFAULT_INTERVAL_MS),
    }
}

/// `DEBRID_AL_SWEEP_APPLY`: só o literal ligado abre o `Apply` (mesma família
/// de `kill_switch_on`). Ausente/lixo = OFF — o freio é o DEFAULT.
pub(crate) fn apply_gate_on() -> bool {
    apply_gate_on_from(std::env::var(APPLY_GATE_ENV).ok().as_deref())
}

pub(crate) fn apply_gate_on_from(raw: Option<&str>) -> bool {
    raw.map(|text| text.trim().to_ascii_lowercase())
        .is_some_and(|text| matches!(text.as_str(), "on" | "1" | "true" | "yes"))
}

/// `DEBRID_AL_CLEANUP`: ausente é diagnóstico (`ReadOnly`), `off` é `Off`.
pub(crate) fn mode_from(cleanup: Option<&str>, kill_on: bool) -> SweepMode {
    match cleanup {
        None => SweepMode::ReadOnly,
        Some(raw) => {
            if CleanupMode::parse(raw).is_on() {
                SweepMode::from_flags(true, kill_on)
            } else {
                SweepMode::Off
            }
        }
    }
}

/// Modo e intervalo EFETIVOS, inclusive quando nada agenda: é daqui que a rota
/// tira `mode`/`intervalMs` sem repetir a decisão do freio.
pub(crate) fn effective_from(
    interval: Option<&str>,
    cleanup: Option<&str>,
    kill_on: bool,
    apply_gate: bool,
) -> Settings {
    let interval_ms = interval_from(interval);
    let requested_mode = mode_from(cleanup, kill_on);
    // O gate vence: `on` só vira `Apply` com o freio aberto. Sem ele, `on` é
    // diagnóstico read-only — nunca completar o que falta com suposição para
    // habilitar DELETE.
    let mode = if requested_mode.deletes() && !apply_gate {
        SweepMode::ReadOnly
    } else {
        requested_mode
    };
    Settings { mode, interval_ms }
}

/// Por que NADA é agendado (`None` = agenda). `not_wired` é só do
/// `AdminState` sem runtime e não nasce aqui.
pub(crate) fn disabled_reason(settings: Settings) -> Option<&'static str> {
    if settings.interval_ms <= 0 {
        return Some("interval_zero");
    }
    if !settings.mode.plans() {
        return Some("cleanup_off");
    }
    None
}

/// `None` = nada a agendar (intervalo `0` ou modo `Off`). Costura de teste e de
/// diagnóstico: a produção usa [`effective_from`] + [`disabled_reason`].
#[cfg(test)]
pub(crate) fn settings_from(
    interval: Option<&str>,
    cleanup: Option<&str>,
    kill_on: bool,
    apply_gate: bool,
) -> Option<Settings> {
    let settings = effective_from(interval, cleanup, kill_on, apply_gate);
    disabled_reason(settings).is_none().then_some(settings)
}

/// O que a admin 8711 enxerga. É `Clone` (a task não é): o `AdminState` guarda
/// uma cópia e o `SweepRuntime` fica com o laço.
#[derive(Clone)]
pub(crate) struct SweepAdmin {
    /// Modo EFETIVO (freio já aplicado), nunca o pedido pelo corpo.
    pub(crate) mode: SweepMode,
    pub(crate) interval_ms: i64,
    /// Existe `Sweeper` e `mode.plans()`: a rota manual pode rodar.
    pub(crate) enabled: bool,
    /// Existe task de relógio (intervalo > 0 e runtime tokio).
    pub(crate) scheduled: bool,
    pub(crate) disabled_reason: Option<&'static str>,
    pub(crate) sweeper: Option<Arc<Sweeper>>,
    pub(crate) started_at_ms: i64,
}

impl SweepAdmin {
    /// Rota montada sem runtime injetado (teste ou admin sem `spawn`): o
    /// contrato continua valendo com `enabled:false`, nunca um 500.
    pub(crate) fn not_wired() -> Self {
        Self {
            mode: SweepMode::Off,
            interval_ms: 0,
            enabled: false,
            scheduled: false,
            disabled_reason: Some("not_wired"),
            sweeper: None,
            started_at_ms: 0,
        }
    }

    /// Foto do painel: do `Sweeper` quando existe; zerada quando não.
    pub(crate) fn snapshot(&self) -> SweepSnapshot {
        match self.sweeper.as_ref() {
            Some(sweeper) => sweeper.snapshot(),
            None => SweepSnapshot::idle(self.started_at_ms),
        }
    }
}

/// Laço + admin. O `task` só existe para o agendador seguir vivo enquanto o
/// runtime existir (`proxy::run` o mantém até o fim do `serve`).
pub(crate) struct SweepRuntime {
    pub(crate) admin: SweepAdmin,
    #[allow(dead_code)]
    task: Option<tokio::task::JoinHandle<()>>,
}

impl SweepRuntime {
    /// Runtime desligado com motivo: nada de agendador "vazio" fingindo viver.
    fn off(settings: Settings, reason: &'static str) -> Self {
        Self {
            admin: SweepAdmin {
                mode: settings.mode,
                interval_ms: settings.interval_ms,
                enabled: false,
                scheduled: false,
                disabled_reason: Some(reason),
                sweeper: None,
                started_at_ms: adom_sources::now_ms(),
            },
            task: None,
        }
    }
}

/// Agenda as varreduras. Sempre devolve runtime: desligado por env, sem conta
/// AllDebrid do operador ou sem cliente HTTP, o `admin` diz o motivo.
pub(crate) fn spawn() -> SweepRuntime {
    let settings = Settings::from_env();
    if let Some(reason) = disabled_reason(settings) {
        eprintln!("[al_sweeps] agendador desligado ({reason})");
        return SweepRuntime::off(settings, reason);
    }
    let Some(account) = native::account_from_env() else {
        eprintln!(
            "[al_sweeps] sem conta AllDebrid do operador (DEBRID_SERVICE/DEBRID_API_KEY); nada agendado"
        );
        return SweepRuntime::off(settings, "no_operator_account");
    };
    let Some(source) = native::source(&account) else {
        eprintln!("[al_sweeps] cliente HTTP da AllDebrid indisponível; nada agendado");
        return SweepRuntime::off(settings, "http_client_unavailable");
    };
    // Um SÓ handle do `cache.db` para fatos e efeitos da rodada.
    let kv = native::open_kv();
    spawn_with(
        settings,
        source,
        native::facts_with_kv(&account, kv.clone()),
        native::effects(&account, kv),
        native::inventory_ensure(&account),
    )
}

/// Montagem testável (o `spawn` só escolhe as portas de produção).
pub(crate) fn spawn_with(
    settings: Settings,
    source: Arc<dyn SweepSource>,
    facts: Arc<dyn FactSource>,
    effects: Arc<dyn effects::SweepEffects>,
    inventory: Option<Arc<dyn super::InventoryEnsure>>,
) -> SweepRuntime {
    if let Some(reason) = disabled_reason(settings) {
        return SweepRuntime::off(settings, reason);
    }
    let started_at_ms = adom_sources::now_ms();
    let sweeper = Sweeper::new_at(
        settings.mode,
        settings.interval_ms,
        source,
        facts,
        effects,
        inventory,
        started_at_ms,
    );
    let task = tokio::runtime::Handle::try_current()
        .ok()
        .map(|handle| handle.spawn(run(sweeper.clone(), settings.interval_ms)));
    if task.is_none() {
        eprintln!("[al_sweeps] sem runtime tokio: agendamento desligado, execução manual segue");
    } else {
        eprintln!(
            "[al_sweeps] varreduras da AllDebrid agendadas a cada {} ms (modo {})",
            settings.interval_ms,
            settings.mode.as_str()
        );
    }
    SweepRuntime {
        admin: SweepAdmin {
            mode: settings.mode,
            interval_ms: settings.interval_ms,
            enabled: true,
            scheduled: task.is_some(),
            disabled_reason: None,
            sweeper: Some(sweeper),
            started_at_ms,
        },
        task,
    }
}

/// Laço do agendador. A PRIMEIRA rodada espera um intervalo de propósito: no
/// boot o inventário ainda está frio (fail-closed) e uma varredura destrutiva
/// durante o restart não tem vantagem nenhuma.
async fn run(sweeper: Arc<Sweeper>, interval_ms: i64) {
    let period = Duration::from_millis(interval_ms.max(1) as u64);
    loop {
        tokio::time::sleep(period).await;
        let report = sweeper.tick(adom_sources::now_ms()).await;
        if report.reentered {
            eprintln!("[al_sweeps] rodada anterior ainda em voo: este tick saiu");
        }
        if !report.outcomes.is_empty() {
            eprintln!(
                "[al_sweeps] rodada: {} tipo(s), planejado {}, removido {}, {} chamada(s)",
                report.outcomes.len(),
                report.planned(),
                report.removed(),
                report.calls()
            );
        }
    }
}
