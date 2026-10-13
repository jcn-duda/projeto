//! Tipos compartilhados do módulo FlareSolverr.

use std::fmt;

/// Erros que podem ocorrer no fluxo de crawl com FlareSolverr.
#[derive(Debug)]
pub enum FlareError {
    /// FlareSolverr não está acessível no solver_url configurado.
    SolverNotReachable(String),
    /// FlareSolverr respondeu, mas com status inesperado ou body vazio.
    SolverFailed { status: u16, body: String },
    /// O body retornado ainda contém desafio Cloudflare após resolução.
    ChallengeNotResolved,
    /// Erro no fetch direto (camada do Agente 1).
    DirectError(String),
    /// Timeout na requisição (direto ou via Flare).
    Timeout,
}

impl fmt::Display for FlareError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FlareError::SolverNotReachable(msg) => {
                write!(f, "FlareSolverr não acessível: {}", msg)
            }
            FlareError::SolverFailed { status, body } => {
                write!(
                    f,
                    "FlareSolverr falhou com status {}: {}",
                    status,
                    truncate_for_display(body, 200)
                )
            }
            FlareError::ChallengeNotResolved => {
                write!(f, "Desafio Cloudflare não resolvido após FlareSolverr")
            }
            FlareError::DirectError(msg) => {
                write!(f, "Erro no fetch direto: {}", msg)
            }
            FlareError::Timeout => {
                write!(f, "Timeout na requisição")
            }
        }
    }
}

impl std::error::Error for FlareError {}

/// Trunca string para exibição em mensagens de erro.
fn truncate_for_display(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        &s[..max]
    }
}

/// Resultado bem-sucedido do FlareSolverr.
#[derive(Debug, Clone)]
pub struct FlareSolution {
    /// HTML/body retornado pelo FlareSolverr.
    pub body: String,
    /// Cookies extraídos da sessão do FlareSolverr `(name, value)`.
    pub cookies: Vec<(String, String)>,
    /// User-Agent do browser usado pelo FlareSolverr.
    pub user_agent: String,
    /// URL final após redirects.
    pub final_url: String,
}

/// Mensagem de erro que indica desafio Cloudflare no fetch direto.
/// Usado pelo escalonamento para decidir se aciona o FlareSolverr.
pub const DIRECT_CHALLENGE_MSG: &str = "challenge";

/// Defaults de configuração do FlareSolverr.
pub mod defaults {
    /// URL padrão do FlareSolverr.
    pub const SOLVER_URL: &str = "http://127.0.0.1:8191";
    /// Timeout padrão para requisições ao FlareSolverr (ms).
    pub const TIMEOUT_MS: u64 = 55_000;
    /// TTL padrão de sessão do FlareSolverr (ms) — 20 minutos.
    pub const SESSION_TTL_MS: u64 = 1_200_000;
    /// Timeout padrão para fetch direto (ms).
    pub const DIRECT_TIMEOUT_MS: u64 = 15_000;
    /// Máximo de hops permitidos em um crawl.
    pub const MAX_HOPS: usize = 10;
}
