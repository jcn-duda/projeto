//! Opt-in de collect nativo via `SOURCES_RUST` (CSV, case-insensitive).
//!
//! Default OFF → [`super::NodeCollector`]. Tokens desta fatia: `jackett`,
//! `prowlarr`. **Exclusão mútua**: se ambos aparecerem, `jackett` vence
//! (composição fica para fatia futura). Sem BLUDV/Mico aqui.

use std::sync::Arc;

use super::collect::Collector;
use super::jackett_collector::try_jackett_collector_from_env;
use super::prowlarr_collector::try_prowlarr_collector_from_env;

/// Parse puro do CSV (testável sem mexer no env do processo).
pub fn sources_rust_csv_includes(raw: &str, token: &str) -> bool {
    raw.split(',')
        .any(|t| t.trim().eq_ignore_ascii_case(token))
}

/// `SOURCES_RUST` contém o token (CSV, case-insensitive). Ausente → false.
pub fn sources_rust_includes(token: &str) -> bool {
    std::env::var("SOURCES_RUST")
        .ok()
        .map(|raw| sources_rust_csv_includes(&raw, token))
        .unwrap_or(false)
}

/// Monta o collector nativo pedido pelo env. Default OFF → `None`
/// (caller usa NodeCollector). Jackett e Prowlarr não se compõem nesta fatia.
pub fn try_sources_rust_collector_from_env() -> Option<Arc<dyn Collector>> {
    let wants_jackett = sources_rust_includes("jackett");
    let wants_prowlarr = sources_rust_includes("prowlarr");
    if wants_jackett && wants_prowlarr {
        eprintln!(
            "[search] SOURCES_RUST: jackett+prowlarr — exclusão mútua nesta fatia; usando jackett"
        );
    }
    if wants_jackett {
        return try_jackett_collector_from_env()
            .map(|c| Arc::new(c) as Arc<dyn Collector>);
    }
    if wants_prowlarr {
        return try_prowlarr_collector_from_env()
            .map(|c| Arc::new(c) as Arc<dyn Collector>);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_aceita_token_e_lista() {
        assert!(sources_rust_csv_includes("jackett", "jackett"));
        assert!(sources_rust_csv_includes("prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes("jackett,prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes(" JACKETT , prowlarr ", "jackett"));
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("torrentio", "prowlarr"));
    }

    #[test]
    fn default_off_sem_env() {
        // Função pura: string vazia / ausente = OFF.
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("", "prowlarr"));
    }
}
