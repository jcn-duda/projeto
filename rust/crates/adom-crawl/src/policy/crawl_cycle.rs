//! Contadores de ciclo da raspagem.
//!
//! Equivalente Rust a `src/providers/crawl-cycle.ts`.
//! Mantém o estado volátil de uma rodada de descoberta e páginas.

use serde::{Deserialize, Serialize};

/// Contadores acumulados no ciclo corrente da raspagem.
///
/// Estado volátil de uma rodada de descoberta + páginas.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleCounters {
    #[serde(default)]
    pub pages: i64,

    #[serde(default)]
    pub done: i64,

    #[serde(default, alias = "noTorrent")]
    pub no_torrent: i64,

    #[serde(default, alias = "noWork")]
    pub no_work: i64,

    #[serde(default)]
    pub errors: i64,

    #[serde(default)]
    pub simulated: i64,

    #[serde(default)]
    pub partial: i64,

    #[serde(default)]
    pub releases: i64,

    #[serde(default, alias = "newReleases")]
    pub new_releases: i64,

    #[serde(default, alias = "discoveryAdded")]
    pub discovery_added: i64,

    #[serde(default, alias = "discoveryRefreshed")]
    pub discovery_refreshed: i64,

    #[serde(default, alias = "discoveryFailures")]
    pub discovery_failures: i64,
}

impl CycleCounters {
    /// Cria uma nova instância de contadores com todos os campos zerados.
    pub fn new() -> Self {
        Self::default()
    }

    /// Zera todos os contadores da rodada.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Devolve uma nova estrutura de [`CycleCounters`] com todos os contadores zerados.
pub fn fresh_cycle() -> CycleCounters {
    CycleCounters::default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fresh_cycle_all_zeros() {
        let cycle = fresh_cycle();
        assert_eq!(cycle.pages, 0);
        assert_eq!(cycle.done, 0);
        assert_eq!(cycle.no_torrent, 0);
        assert_eq!(cycle.no_work, 0);
        assert_eq!(cycle.errors, 0);
        assert_eq!(cycle.simulated, 0);
        assert_eq!(cycle.partial, 0);
        assert_eq!(cycle.releases, 0);
        assert_eq!(cycle.new_releases, 0);
        assert_eq!(cycle.discovery_added, 0);
        assert_eq!(cycle.discovery_refreshed, 0);
        assert_eq!(cycle.discovery_failures, 0);
    }

    #[test]
    fn test_cycle_counters_default_and_new() {
        let def = CycleCounters::default();
        let fresh = fresh_cycle();
        let new_c = CycleCounters::new();
        assert_eq!(def, fresh);
        assert_eq!(def, new_c);
    }

    #[test]
    fn test_cycle_counters_mutation_and_reset() {
        let mut cycle = fresh_cycle();
        cycle.pages += 10;
        cycle.done += 7;
        cycle.no_torrent += 1;
        cycle.no_work += 2;
        cycle.errors += 3;
        cycle.simulated += 4;
        cycle.partial += 5;
        cycle.releases += 100;
        cycle.new_releases += 80;
        cycle.discovery_added += 25;
        cycle.discovery_refreshed += 15;
        cycle.discovery_failures += 2;

        assert_eq!(cycle.pages, 10);
        assert_eq!(cycle.done, 7);
        assert_eq!(cycle.no_torrent, 1);
        assert_eq!(cycle.no_work, 2);
        assert_eq!(cycle.errors, 3);
        assert_eq!(cycle.simulated, 4);
        assert_eq!(cycle.partial, 5);
        assert_eq!(cycle.releases, 100);
        assert_eq!(cycle.new_releases, 80);
        assert_eq!(cycle.discovery_added, 25);
        assert_eq!(cycle.discovery_refreshed, 15);
        assert_eq!(cycle.discovery_failures, 2);

        // Reset deve zerar todos os campos
        cycle.reset();
        assert_eq!(cycle, fresh_cycle());
    }

    #[test]
    fn test_cycle_counters_serde_camel_case() {
        // Formato camelCase vindo de clientes/código TypeScript
        let json = r#"{
            "pages": 12,
            "done": 10,
            "noTorrent": 1,
            "noWork": 1,
            "errors": 0,
            "simulated": 2,
            "partial": 3,
            "releases": 50,
            "newReleases": 35,
            "discoveryAdded": 8,
            "discoveryRefreshed": 4,
            "discoveryFailures": 1
        }"#;

        let parsed: CycleCounters = serde_json::from_str(json).expect("deserialize camelCase");
        assert_eq!(parsed.pages, 12);
        assert_eq!(parsed.done, 10);
        assert_eq!(parsed.no_torrent, 1);
        assert_eq!(parsed.no_work, 1);
        assert_eq!(parsed.errors, 0);
        assert_eq!(parsed.simulated, 2);
        assert_eq!(parsed.partial, 3);
        assert_eq!(parsed.releases, 50);
        assert_eq!(parsed.new_releases, 35);
        assert_eq!(parsed.discovery_added, 8);
        assert_eq!(parsed.discovery_refreshed, 4);
        assert_eq!(parsed.discovery_failures, 1);
    }

    #[test]
    fn test_cycle_counters_serde_snake_case() {
        // Formato snake_case nativo Rust
        let json = r#"{
            "pages": 9,
            "done": 6,
            "no_torrent": 2,
            "no_work": 1,
            "errors": 1,
            "simulated": 0,
            "partial": 2,
            "releases": 40,
            "new_releases": 20,
            "discovery_added": 5,
            "discovery_refreshed": 3,
            "discovery_failures": 0
        }"#;

        let parsed: CycleCounters = serde_json::from_str(json).expect("deserialize snake_case");
        assert_eq!(parsed.pages, 9);
        assert_eq!(parsed.done, 6);
        assert_eq!(parsed.no_torrent, 2);
        assert_eq!(parsed.no_work, 1);
        assert_eq!(parsed.errors, 1);
        assert_eq!(parsed.simulated, 0);
        assert_eq!(parsed.partial, 2);
        assert_eq!(parsed.releases, 40);
        assert_eq!(parsed.new_releases, 20);
        assert_eq!(parsed.discovery_added, 5);
        assert_eq!(parsed.discovery_refreshed, 3);
        assert_eq!(parsed.discovery_failures, 0);
    }

    #[test]
    fn test_cycle_counters_serde_defaults_for_missing_fields() {
        let json = r#"{"pages": 5, "done": 5}"#;
        let parsed: CycleCounters = serde_json::from_str(json).expect("deserialize partial");
        assert_eq!(parsed.pages, 5);
        assert_eq!(parsed.done, 5);
        assert_eq!(parsed.no_torrent, 0);
        assert_eq!(parsed.no_work, 0);
        assert_eq!(parsed.discovery_added, 0);
    }

    #[test]
    fn test_cycle_counters_serde_roundtrip() {
        let mut original = fresh_cycle();
        original.pages = 42;
        original.done = 40;
        original.no_torrent = 1;
        original.releases = 150;
        original.new_releases = 99;

        let serialized = serde_json::to_string(&original).expect("serialize");
        let deserialized: CycleCounters = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(original, deserialized);
    }
}
