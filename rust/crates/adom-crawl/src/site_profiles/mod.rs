//! Perfis de site do raspador: configuração de rede por site BR.
//!
//! Cada site BR tem suas próprias características de rede (hosts, protetores,
//! timeout, Flare, ritmo). O registry (`SITE_TABLE`) mapeia `site_id` → `SiteNetworkConfig`.

pub mod config;
pub mod registry;

#[cfg(test)]
mod tests;

// Re-exports para ergonomicidade.
pub use config::{
    SiteNetworkConfig, BASE_PROTECTOR_SUFFIXES, DEFAULT_MAX_HOPS, DEFAULT_TIMEOUT_MS,
    DEFAULT_USER_AGENT, FLARE_SESSION_TTL_MS,
};
pub use registry::{all_site_configs, all_site_ids, is_own_pace, site_network_config};

/// Monta uma `Allowlist` (do módulo `net`) a partir da config de rede de um site.
///
/// A allowlist inclui:
/// - `candidate_hosts` (hosts do próprio site)
/// - `protector_suffixes` (protetores de link conhecidos)
/// - `assert_only_suffixes` (hosts de salto, marcados como assert-only)
pub fn resolve_allowlist(config: &SiteNetworkConfig) -> crate::net::allowlist::Allowlist {
    crate::net::allowlist::Allowlist::new(
        config.candidate_hosts.clone(),
        config.protector_suffixes.clone(),
        config.assert_only_suffixes.clone(),
    )
}
