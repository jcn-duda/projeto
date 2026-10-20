//! Collect nativo via `SOURCES_RUST` (CSV, case-insensitive).
//!
//! **Default (env ausente) = todas as fontes migradas** — `jackett`, `prowlarr`,
//! `torrentio`, `bludv`, `mico` — porque o corte nativo é o caminho padrão desde
//! o F4.4. `SOURCES_RUST=` (vazio) ou um CSV sem o token devolve o collect
//! daquela fonte ao [`super::NodeCollector`] (rollback por env, rota interna).
//!
//! Múltiplas fontes em `SOURCES_RUST` são compostas via [`super::CompositeCollector`],
//! que executa todas as fontes nativas em paralelo e combina seus lotes.
//! Quando executando junto ao Node (`NodeRoutes`), o `NodeCollector` também é
//! agregado ao coletor composto, preservando fontes não migradas e o inventário da conta.

use std::sync::Arc;

use adom_sources::RawStore;

use super::bludv_collector::try_bludv_collector_from_env_with_store;
use super::collect::Collector;
use super::jackett_collector::try_jackett_collector_from_env;
use super::mico_collector::try_mico_collector_from_env;
use super::prowlarr_collector::try_prowlarr_collector_from_env;
use super::torrentio_collector::try_torrentio_collector_from_env;

/// Tokens conhecidos, em ordem de prioridade na exclusão mútua.
const KNOWN_TOKENS: &[&str] = &["jackett", "prowlarr", "torrentio", "bludv", "mico"];

/// CSV default quando a env está AUSENTE (rollback = `SOURCES_RUST=` vazio).
pub const DEFAULT_SOURCES_RUST: &str = "jackett,prowlarr,torrentio,bludv,mico";

/// CSV efetivo: env ausente cai no default; env presente (mesmo vazia) vence.
fn sources_csv_env() -> String {
    std::env::var("SOURCES_RUST").unwrap_or_else(|_| DEFAULT_SOURCES_RUST.to_string())
}

/// Parse puro do CSV (testável sem mexer no env do processo).
pub fn sources_rust_csv_includes(raw: &str, token: &str) -> bool {
    raw.split(',').any(|t| t.trim().eq_ignore_ascii_case(token))
}

/// `SOURCES_RUST` efetivo contém o token (CSV, case-insensitive). Ausente →
/// [`DEFAULT_SOURCES_RUST`]; vazia → nenhum token.
pub fn sources_rust_includes(token: &str) -> bool {
    sources_rust_csv_includes(&sources_csv_env(), token)
}

/// Qual token vence no CSV (puro). `None` = nenhum token conhecido / vazio.
pub fn sources_rust_csv_winner(raw: &str) -> Option<&'static str> {
    for token in KNOWN_TOKENS {
        if sources_rust_csv_includes(raw, token) {
            return Some(*token);
        }
    }
    None
}

/// Coletores nativos pedidos pelo env, COM o token de cada um. O token é o
/// que o Node precisa para pular a mesma fonte (`skip_sources`): sem ele a
/// fonte entraria duas vezes, uma no Rust e outra no `NodeCollector`.
pub fn try_sources_rust_native_from_env() -> Vec<(&'static str, Arc<dyn Collector>)> {
    try_sources_rust_native_from_env_with_bludv_store(None)
}

/// Mesma lista com o store do `raw:v1` injetado no coletor BLUDV (o gateway
/// compartilha o `cache.db` do Node). `None` = sem cache bruto; as outras
/// fontes ignoram o parâmetro.
pub fn try_sources_rust_native_from_env_with_bludv_store(
    raw_store: Option<Arc<dyn RawStore>>,
) -> Vec<(&'static str, Arc<dyn Collector>)> {
    let raw = sources_csv_env();
    let mut native: Vec<(&'static str, Arc<dyn Collector>)> = Vec::new();

    if sources_rust_csv_includes(&raw, "jackett") {
        if let Some(c) = try_jackett_collector_from_env() {
            native.push(("jackett", Arc::new(c) as Arc<dyn Collector>));
        }
    }
    if sources_rust_csv_includes(&raw, "prowlarr") {
        if let Some(c) = try_prowlarr_collector_from_env() {
            native.push(("prowlarr", Arc::new(c) as Arc<dyn Collector>));
        }
    }
    if sources_rust_csv_includes(&raw, "torrentio") {
        if let Some(c) = try_torrentio_collector_from_env() {
            native.push(("torrentio", Arc::new(c) as Arc<dyn Collector>));
        }
    }
    if sources_rust_csv_includes(&raw, "bludv") {
        if let Some(c) = try_bludv_collector_from_env_with_store(raw_store) {
            native.push(("bludv", Arc::new(c) as Arc<dyn Collector>));
        }
    }
    if sources_rust_csv_includes(&raw, "mico") {
        if let Some(c) = try_mico_collector_from_env() {
            native.push(("mico", Arc::new(c) as Arc<dyn Collector>));
        }
    }

    native
}

/// Monta a lista de coletores nativos pedidos pelo env (`SOURCES_RUST`).
/// Cada token conhecido presente no CSV gera seu collector nativo.
pub fn try_sources_rust_collectors_from_env() -> Vec<Arc<dyn Collector>> {
    try_sources_rust_native_from_env()
        .into_iter()
        .map(|(_, c)| c)
        .collect()
}

/// Monta o collector nativo pedido pelo env. Default OFF → `None` (caller usa NodeCollector).
/// Se mais de uma fonte nativa for pedida, agrupa via [`super::CompositeCollector`].
pub fn try_sources_rust_collector_from_env() -> Option<Arc<dyn Collector>> {
    let mut collectors = try_sources_rust_collectors_from_env();
    if collectors.is_empty() {
        return None;
    }
    if collectors.len() == 1 {
        return Some(collectors.remove(0));
    }
    Some(Arc::new(super::CompositeCollector::new(collectors)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_aceita_token_e_lista() {
        assert!(sources_rust_csv_includes("jackett", "jackett"));
        assert!(sources_rust_csv_includes("prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes("torrentio", "torrentio"));
        assert!(sources_rust_csv_includes("bludv", "bludv"));
        assert!(sources_rust_csv_includes("mico", "mico"));
        assert!(sources_rust_csv_includes("jackett,prowlarr", "prowlarr"));
        assert!(sources_rust_csv_includes(
            " JACKETT , torrentio ",
            "torrentio"
        ));
        assert!(sources_rust_csv_includes("bludv,mico", "mico"));
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("torrentio", "prowlarr"));
    }

    #[test]
    fn default_off_sem_env() {
        // Função pura: string vazia / ausente = OFF.
        assert!(!sources_rust_csv_includes("", "jackett"));
        assert!(!sources_rust_csv_includes("", "prowlarr"));
        assert!(!sources_rust_csv_includes("", "torrentio"));
        assert!(!sources_rust_csv_includes("", "bludv"));
        assert!(!sources_rust_csv_includes("", "mico"));
        assert_eq!(sources_rust_csv_winner(""), None);
    }

    #[test]
    fn exclusao_mutua_ordem_jackett_prowlarr_torrentio_bludv_mico() {
        assert_eq!(sources_rust_csv_winner("jackett"), Some("jackett"));
        assert_eq!(sources_rust_csv_winner("prowlarr"), Some("prowlarr"));
        assert_eq!(sources_rust_csv_winner("torrentio"), Some("torrentio"));
        assert_eq!(sources_rust_csv_winner("bludv"), Some("bludv"));
        assert_eq!(sources_rust_csv_winner("mico"), Some("mico"));
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
        // BR tokens sozinhos: exclusão mútua (bludv > mico); sem composição.
        assert_eq!(sources_rust_csv_winner("bludv,mico"), Some("bludv"));
        assert_eq!(sources_rust_csv_winner("mico,bludv"), Some("bludv"));
        // Misturado com jackett: jackett vence (como hoje).
        assert_eq!(sources_rust_csv_winner("jackett,bludv"), Some("jackett"));
        assert_eq!(sources_rust_csv_winner("mico,torrentio"), Some("torrentio"));
        assert_eq!(sources_rust_csv_winner("unknown"), None);
    }
}
