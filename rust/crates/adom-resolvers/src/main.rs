//! Binário dos resolvers BR em Rust.
//!
//! Lê `BR_RESOLVER_RUST` (CSV `nome:porta`, ex.: `comandotorrents:8701,nerdfilmes:8702`)
//! e sobe um servidor HTTP por site com o mesmo contrato do TS. O Node pula a
//! porta quando o site está na lista; este binário assume no lugar.
//!
//! Env vars:
//! - `BR_RESOLVER_RUST`: CSV `nome:porta` (obrigatório; vazio = exit 0).
//! - `<SITE>_URL`: URL primária do site (ex.: `COMANDOTORRENTS_URL`).
//! - `RESOLVER_EXTRA_PROTECTORS`: CSV de sufixos extras de protetor (opcional).

use std::sync::Arc;

use adom_resolvers::profile::ResolverProfile;
use adom_resolvers::server::{run_resolver, ResolverConfig};

/// Porta default por site (mesma do TS `config.resolvers.ports`).
const DEFAULT_PORTS: &[(&str, u16)] = &[
    ("bludv", 8700),
    ("comandotorrents", 8701),
    ("nerdfilmes", 8702),
    ("torrentdosfilmes", 8703),
    ("vacatorrent", 8704),
    ("redetorrent", 8705),
    ("apachetorrent", 8706),
    ("hdrtorrents", 8707),
];

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let spec = std::env::var("BR_RESOLVER_RUST").unwrap_or_default();
    if spec.trim().is_empty() {
        eprintln!("[resolver] BR_RESOLVER_RUST vazio — nenhum resolver Rust");
        return Ok(());
    }

    let extra_protectors: Vec<String> = std::env::var("RESOLVER_EXTRA_PROTECTORS")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut handles = Vec::new();

    for entry in spec.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (name, port) = parse_entry(entry)?;
        let site_url = site_url_env(&name);
        let profile = ResolverProfile::new(&name, &site_url, extra_protectors.clone());
        let config = ResolverConfig {
            port,
            site_name: name.clone(),
            callbacks: Arc::new(profile),
        };
        eprintln!("[resolver] {} → porta {port} (site: {site_url})", name);
        handles.push(tokio::spawn(async move {
            if let Err(e) = run_resolver(config).await {
                eprintln!("[resolver] {name} caiu: {e}");
            }
        }));
    }

    if handles.is_empty() {
        eprintln!("[resolver] nenhuma entrada válida em BR_RESOLVER_RUST");
        return Ok(());
    }

    // Aguarda todos; um cair não derruba os outros.
    for h in handles {
        let _ = h.await;
    }
    Ok(())
}

/// Parse `nome:porta`. Porta opcional (usa default do registry).
fn parse_entry(entry: &str) -> Result<(String, u16), Box<dyn std::error::Error>> {
    if let Some((name, port_str)) = entry.split_once(':') {
        let port = port_str.parse::<u16>()?;
        Ok((name.trim().to_string(), port))
    } else {
        let name = entry.trim().to_string();
        let port = DEFAULT_PORTS
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, p)| *p)
            .ok_or_else(|| format!("porta desconhecida para {name}; use nome:porta"))?;
        Ok((name, port))
    }
}

/// URL primária do site: lê `<SITE>_URL` do env, fallback vazio (seletor usa candidates do registry).
fn site_url_env(name: &str) -> String {
    let env_key = format!("{}_URL", name.to_uppercase());
    std::env::var(&env_key).unwrap_or_default()
}
