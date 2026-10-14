//! Costura do portao no profile: monta transporte real + GateConfig do env e
//! roda a cadeia. Separado de `profile.rs` pela catraca de 400 linhas. S6 usa
//! em /resolve e /dl; /search e /api nunca chamam daqui (nao esperam).

use std::sync::Arc;
use std::time::Duration;

use url::Url;

use crate::profile::ResolverProfile;
use crate::sites::bludv::gate_flow::{self, GateConfig};
use crate::sites::bludv::gate_real::RealGateTransport;
use crate::sites::bludv::gate_transport::GateTransport;

/// FlareSolverr do container (mesmo loopback do `flare_fetch`).
const SOLVER_URL: &str = "http://127.0.0.1:8191";
/// Prazo da CADEIA inteira (8 saltos + espera): nao e o prazo de um salto.
const GATE_CHAIN_TIMEOUT_MS: u64 = 120_000;
/// Piso do prazo por salto do solvedor (um solve Cloudflare passa de 15s).
const FLARE_SOLVE_FLOOR_MS: u64 = 55_000;

/// `BLUDV_GATE_MIN_WAIT_MS` (default 30000), contado do inicio do gate.
pub fn gate_min_wait_from_env() -> Duration {
    let ms = std::env::var("BLUDV_GATE_MIN_WAIT_MS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(30_000);
    Duration::from_millis(ms)
}

impl ResolverProfile {
    /// Roda a cadeia do portao numa sessao FlareSolverr propria e devolve o
    /// magnet. So para botao do gate (a rota ja filtra por `is_gate_url`).
    pub async fn resolve_gate(&self, gate_url: &str, post_url: &str) -> Result<String, String> {
        let host = Url::parse(gate_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .ok_or_else(|| "bludv: portao sem host".to_string())?;
        let transport: Arc<dyn GateTransport> = Arc::new(RealGateTransport::new(
            SOLVER_URL,
            &host,
            &self.network.user_agent,
            self.network.timeout_ms.max(FLARE_SOLVE_FLOOR_MS),
        ));
        let config = GateConfig {
            solver_url: SOLVER_URL.to_string(),
            timeout: Duration::from_millis(GATE_CHAIN_TIMEOUT_MS),
            min_wait: gate_min_wait_from_env(),
        };
        gate_flow::resolve_gate_magnet(gate_url, post_url, transport, &config)
            .await
            .map_err(|e| e.to_string())
    }
}
