//! Env, montagem e `spawn` do agendador das varreduras da AllDebrid.
//!
//! Separado do núcleo (`al_sweeps.rs`) para o arquivo caber no teto de 400
//! linhas. Nada aqui decide plano nem fala com a conta: só lê flag, escolhe as
//! portas de produção e mantém o laço.

use std::sync::Arc;
use std::time::Duration;

use adom_debrid::alldebrid_cleanup::{kill_switch_on, CleanupMode, CLEANUP_ENV};
use adom_debrid::alldebrid_sweeps::SweepMode;

use super::{native, FactSource, SweepHandle, SweepSource, Sweeper};

/// Intervalo mínimo entre rodadas do MESMO tipo. `0` desliga o agendamento.
pub(crate) const SWEEP_MS_ENV: &str = "DEBRID_AL_SWEEP_MS";
/// 6 h: varredura destrutiva não é caminho quente.
pub(crate) const DEFAULT_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Settings {
    pub(crate) mode: SweepMode,
    pub(crate) interval_ms: i64,
}

impl Settings {
    pub(crate) fn from_env() -> Option<Self> {
        settings_from(
            std::env::var(SWEEP_MS_ENV).ok().as_deref(),
            std::env::var(CLEANUP_ENV).ok().as_deref(),
            kill_switch_on(),
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

/// `None` = nada a agendar (intervalo `0` ou modo `Off`).
pub(crate) fn settings_from(
    interval: Option<&str>,
    cleanup: Option<&str>,
    kill_on: bool,
) -> Option<Settings> {
    let interval_ms = interval_from(interval);
    let requested_mode = mode_from(cleanup, kill_on);
    // `on` só vira `Apply` quando as guardas de posse/supressão estiverem
    // ligadas de ponta a ponta (`native::ROW_PROOFS_COMPLETE`). Enquanto
    // faltar fato, `on` é diagnóstico read-only — nunca completar o que falta
    // com suposição para habilitar DELETE.
    let mode = if requested_mode.deletes() && !native::ROW_PROOFS_COMPLETE {
        SweepMode::ReadOnly
    } else {
        requested_mode
    };
    (interval_ms > 0 && mode.plans()).then_some(Settings { mode, interval_ms })
}

/// Agenda as varreduras. `None` = desligado por env ou sem conta AllDebrid do
/// operador (nunca um agendador "vazio" fingindo estar vivo).
pub(crate) fn spawn() -> Option<SweepHandle> {
    let Some(settings) = Settings::from_env() else {
        eprintln!("[al_sweeps] agendador desligado ({SWEEP_MS_ENV}=0 ou {CLEANUP_ENV}=off)");
        return None;
    };
    let Some(account) = native::account_from_env() else {
        eprintln!(
            "[al_sweeps] sem conta AllDebrid do operador (DEBRID_SERVICE/DEBRID_API_KEY); nada agendado"
        );
        return None;
    };
    let Some(source) = native::source(&account) else {
        eprintln!("[al_sweeps] cliente HTTP da AllDebrid indisponível; nada agendado");
        return None;
    };
    spawn_with(settings, source, native::facts(&account))
}

/// Montagem testável (o `spawn` só escolhe as portas de produção).
pub(crate) fn spawn_with(
    settings: Settings,
    source: Arc<dyn SweepSource>,
    facts: Arc<dyn FactSource>,
) -> Option<SweepHandle> {
    if settings.interval_ms <= 0 || !settings.mode.plans() {
        return None;
    }
    let handle = tokio::runtime::Handle::try_current().ok()?;
    let sweeper = Sweeper::new(settings.mode, settings.interval_ms, source, facts);
    eprintln!(
        "[al_sweeps] varreduras da AllDebrid agendadas a cada {} ms (modo {})",
        settings.interval_ms,
        settings.mode.as_str()
    );
    Some(SweepHandle::new(
        handle.spawn(run(sweeper, settings.interval_ms)),
    ))
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
