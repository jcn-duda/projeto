//! Costura do portao no profile: monta transporte real + GateConfig do env e
//! roda a cadeia. Separado de `profile.rs` pela catraca de 400 linhas. S6 usa
//! em /resolve e /dl; /search e /api nunca chamam daqui (nao esperam).

use std::sync::Arc;
use std::time::Duration;

use url::Url;

use crate::profile::ResolverProfile;
use crate::server::{gate_wait_block_requested, GATE_PENDING};
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
    /// Devolve o magnet do portao (sessao FlareSolverr propria). So para botao
    /// do gate (a rota ja filtra por `is_gate_url`).
    ///
    /// Modo bloqueante (default: `wait=1` no /resolve, rota /dl, prefetch em
    /// fundo) espera a cadeia, como sempre. Sem `wait=1`, o /resolve recebe
    /// `gate_pending` NA HORA e o `prefetch_gate_magnet` aquece a cadeia em
    /// fundo — a admissao dele (uma cadeia por URL, coalescing no IN_FLIGHT)
    /// e a mesma de sempre, sem fila nova.
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
        self.resolve_gate_with(gate_url, post_url, transport, &config)
            .await
    }

    /// Mesmo contrato do `resolve_gate` com transporte injetado: os testes
    /// exercem os dois modos sem rede.
    async fn resolve_gate_with(
        &self,
        gate_url: &str,
        post_url: &str,
        transport: Arc<dyn GateTransport>,
        config: &GateConfig,
    ) -> Result<String, String> {
        if !gate_wait_block_requested() {
            return match gate_flow::gate_cache_lookup(gate_url, post_url) {
                // Cache hit: magnet na hora (~0ms), igual ao modo bloqueante.
                Ok(Some(magnet)) => Ok(magnet),
                Ok(None) => {
                    // Aquecimento fire-and-forget: se ja ha cadeia ativa para
                    // esta URL, o prefetch apenas adere a ela (sem duplicar).
                    // A falha da cadeia NUNCA entra no cache — a chamada
                    // seguinte re-dispara da mesma forma.
                    gate_flow::prefetch_gate_magnet(gate_url, post_url, transport, config);
                    Err(GATE_PENDING.to_string())
                }
                // Botao invalido segue erro claro, como no modo bloqueante:
                // pendencia infinita em botao que nunca resolveria seria pior.
                Err(e) => Err(e.to_string()),
            };
        }
        gate_flow::resolve_gate_magnet(gate_url, post_url, transport, config)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "gate_resolve_tests.rs"]
mod tests;
