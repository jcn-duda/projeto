//! Opt-in de collect nativo via `SOURCES_RUST` (CSV, case-insensitive).
//!
//! Default OFF → [`super::NodeCollector`]. Tokens desta fatia: `jackett`,
//! `prowlarr`, `torrentio`. **Exclusão mútua simples** (menor patch; composição
//! fica para fatia futura):
//!
//! 1. se `jackett` presente → Jackett;
//! 2. senão se `prowlarr` → Prowlarr;
//! 3. senão se `torrentio` → Torrentio.
//!
//! Sem BLUDV/Mico aqui.

use std::sync::Arc;

use super::collect::Collector;
use super::jackett_collector::try_jackett_collector_from_env;
use super::prowlarr_collector::try_prowlarr_collector_from_env;
use super::torrentio_collector::try_torrentio_collector_from_env;

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

/// Qual token vence no CSV (puro). `None` = nenhum token conhecido / vazio.
pub fn sources_rust_csv_winner(raw: &str) -> Option<&'static str> {
    if sources_rust_csv_includes(raw, "jackett") {
        return Some("jackett");
    }
    if sources_rust_csv_includes(raw, "prowlarr") {
        return Some("prowlarr");
    }
    if sources_rust_csv_includes(raw, "torrentio") {
        return Some("torrentio");
    }
    None
}

/// Monta o collector nativo pedido pelo env. Default OFF → `None`
/// (caller usa NodeCollector). Jackett / Prowlarr / Torrentio não se compõem
/// nesta fatia — ver [`sources_rust_csv_winner`].
pub fn try_sources_rust_collector_from_env() -> Option<Arc<dyn Collector>> {
    let raw = std::env::var("SOURCES_RUST").unwrap_or_default();
    let winner = sources_rust_csv_winner(&raw)?;
    let asked: Vec<&str> = ["jackett", "prowlarr", "torrentio"]
        .into_iter()
        .filter(|t| sources_rust_csv_includes(&raw, t))
        .collect();
    if asked.len() > 1 {
        eprintln!(
            "[search] SOURCES_RUST: {} — exclusão mútua nesta fatia; usando {winner}",
            asked.join("+")
        );
    }
    match winner {
        "jackett" => try_jackett_collector_from_env().map(|c| Arc::new(c) as Arc<dyn Collector>),
        "prowlarr" => try_prowlarr_collector_from_env().map(|c| Arc::new(c) as Arc<dyn Collector>),
        "torrentio" => try_torrentio_collector_from_env().map(|c| Arc::new(c) as Arc<dyn Collector>),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_aceita_token_e_lista() {
        assert!(sources_rust_csv_includes("jackett", "jackett"));
        assert!(sources_rust_csv_includes("prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes("torrentio", "torrentio"));
        assert!(sources_rust_csv_includes("jackett,prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes(" JACKETT , torrentio ", "torrentio"));
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("torrentio", "prowlarr"));
    }

    #[test]
    fn default_off_sem_env() {
        // Função pura: string vazia / ausente = OFF.
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("", "prowlarr"));
        assert!(!sources_rust_csv_includes("", "torrentio"));
        assert_eq!(sources_rust_csv_winner(""), None);
    }

    #[test]
    fn exclusao_mutua_jackett_vence_depois_prowlarr_depois_torrentio() {
        assert_eq!(sources_rust_csv_winner("jackett"), Some("jackett"));
        assert_eq!(sources_rust_csv_winner("prowlarr"), Some("prowlarr"));
        assert_eq!(sources_rust_csv_winner("torrentio"), Some("torrentio"));
        assert_eq!(
            sources_rust_csv_winner("jackett,prowlarr,torrentio"),
            Some("jackett")
        );
        assert_eq!(
            sources_rust_csv_winner("torrentio,prowlarr"),
            Some("prowlarr")
        );
        assert_eq!(
            sources_rust_csv_winner(" TORRENTIO , JACKETT "),
            Some("jackett")
        );
        assert_eq!(sources_rust_csv_winner("bludv,mico"), None);
    }
}
