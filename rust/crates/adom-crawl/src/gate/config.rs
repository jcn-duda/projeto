//! Config do executor de portões, lida do ambiente pelo binário. Nada
//! hardcoded: os knobs vivem aqui e no `.env.example`.

use super::flare_signal::{admin_token_from_env, admin_url_from_env, DEFAULT_ADMIN_URL};
use crate::motor::types::MotorConfig;

/// Prazo de UM pagamento (`wait=1` espera a cadeia: FlareSolverr ~30s + margem
/// da fila). Constante como o `CRAWL_PROTECTOR_TIMEOUT_MS` que cerca o mesmo
/// solver; o knob do custo é o TETO (`CRAWL_GATE_HOURLY`), não o prazo.
const GATE_RESOLVER_TIMEOUT_MS: u64 = 45_000;

/// Config do executor, lida do ambiente pelo binário. Nada hardcoded: os knobs
/// vivem aqui e no `.env.example`.
#[derive(Debug, Clone)]
pub struct GateExecutorConfig {
    /// Teto de pagamentos por hora. `0` desliga o executor (kill-switch).
    pub hourly_cap: u32,
    /// Duração da janela do teto (mesma régua do motor: 1h).
    pub hour_window_ms: u64,
    /// Host dos resolvers BR (loopback do container único — nunca hostname).
    pub resolver_host: String,
    /// Porta do resolver do BLUDV (8700 + offset).
    pub resolver_port: u16,
    /// Prazo de UM pagamento (constante [`GATE_RESOLVER_TIMEOUT_MS`]).
    pub resolver_timeout_ms: u64,
    /// Janela de ociosidade (mesma do freio de tráfego do raspador).
    pub idle_window_ms: u64,
    /// Intervalo entre rodadas (mesma régua do `delay_ms` do motor).
    pub interval_ms: u64,
    /// URL do Node (entrega ao acervo).
    pub node_url: String,
    /// Token de administração para os endpoints internos do Node.
    pub admin_token: String,
    /// Admin do gateway para o sinal EXTERNO de flare (`GET /flare/busy`,
    /// `gate/flare_signal.rs`): base no loopback da 8711 e credencial da
    /// MESMA cadeia do `store_admin`. Token vazio = ponte inativa (fail-open).
    pub flare_admin_url: String,
    pub flare_admin_token: String,
}

impl Default for GateExecutorConfig {
    fn default() -> Self {
        Self {
            // Baixo de propósito: o solver é compartilhado com a busca ao vivo.
            hourly_cap: 4,
            hour_window_ms: 3_600_000,
            resolver_host: "127.0.0.1".to_string(),
            resolver_port: 8700, // bludv
            resolver_timeout_ms: GATE_RESOLVER_TIMEOUT_MS,
            idle_window_ms: 600_000,
            interval_ms: 1_000,
            node_url: "http://127.0.0.1:3000".to_string(),
            admin_token: String::new(),
            // Ponte do sinal externo SEM credencial por default: quem monta
            // cfg com `..Default::default()` (testes) fica sem rede; o
            // `from_motor` é quem preenche do ambiente em produção.
            flare_admin_url: DEFAULT_ADMIN_URL.to_string(),
            flare_admin_token: String::new(),
        }
    }
}

impl GateExecutorConfig {
    /// Deriva a config do executor da config do MOTOR: knobs compartilhados
    /// (teto/janela/ociosidade/node/token) herdam o que o binário já leu — o
    /// executor não tem ambiente próprio.
    pub fn from_motor(motor: &MotorConfig) -> Self {
        Self {
            hourly_cap: motor.gate_hourly,
            hour_window_ms: motor.hour_window_ms,
            idle_window_ms: motor.idle_window_ms,
            interval_ms: motor.delay_ms,
            node_url: motor.node_url.clone(),
            admin_token: motor.admin_token.clone(),
            // Sinal externo de flare (Fase 2.2): MESMA env da ponte de
            // invalidação e MESMA cadeia de token do `store_admin`, com
            // fallback para o token unificado do sidecar.
            flare_admin_url: admin_url_from_env(),
            flare_admin_token: admin_token_from_env(&motor.admin_token),
            ..Default::default()
        }
    }
}
