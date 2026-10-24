//! Configuração de rede e candidatos de domínio de um profile: registry do
//! crawl tolerante a variantes de nome e a ordem URL do operador → espelhos →
//! mirrors do registry. Separado de `profile.rs` pela catraca de 400 linhas.

use adom_crawl::site_profiles::{
    all_site_configs, site_network_config, SiteNetworkConfig, BASE_PROTECTOR_SUFFIXES,
};
use url::Url;

/// Rede do site no registry, tolerando variantes: o registry usa ids como
/// `apachetorrent-cardigann`, o operador chama de `apachetorrent`.
pub(crate) fn network_config_for(site_name: &str) -> SiteNetworkConfig {
    if let Some(found) = lookup_site_config(site_name) {
        return found.clone();
    }
    // Site desconhecido: defaults do crawl + base de protetores compartilhada.
    let mut config = SiteNetworkConfig::new(site_name);
    config.protector_suffixes = BASE_PROTECTOR_SUFFIXES
        .iter()
        .map(|s| s.to_string())
        .collect();
    config
}

/// Busca no registry: nome exato → `nome-cardigann` → prefixo mais curto.
pub(crate) fn lookup_site_config(site_name: &str) -> Option<&'static SiteNetworkConfig> {
    let needle = site_name.trim().to_lowercase();
    if let Some(found) = site_network_config(&needle) {
        return Some(found);
    }
    if let Some(found) = site_network_config(&format!("{needle}-cardigann")) {
        return Some(found);
    }
    all_site_configs()
        .into_iter()
        .filter(|c| c.site_id.to_lowercase().starts_with(&needle))
        .min_by_key(|c| c.site_id.len())
}

/// Candidatos: URL do operador, espelhos do `<SITE>_URLS`, depois hosts do
/// registry — sem duplicar host. Sem URL do operador o seletor ainda tem os
/// mirrors do registry; antes a lista vazia deixava o site sem candidato.
pub(crate) fn build_candidates(
    site_url: &str,
    mirrors: &[String],
    network: &SiteNetworkConfig,
) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let operator = std::iter::once(site_url).chain(mirrors.iter().map(String::as_str));
    for raw in operator {
        let url = raw.trim().trim_end_matches('/');
        if let Some(host) = host_of(url).filter(|h| !seen.contains(h)) {
            seen.push(host);
            candidates.push(url.to_string());
        }
    }
    for host in &network.candidate_hosts {
        if !seen.contains(host) {
            seen.push(host.clone());
            candidates.push(format!("https://{host}"));
        }
    }
    candidates
}

/// Host em minúsculas de uma URL; `None` se ela não parseia.
pub(crate) fn host_of(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_lowercase()))
}

#[cfg(test)]
#[path = "site_config_tests.rs"]
mod tests;
