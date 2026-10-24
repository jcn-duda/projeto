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

use adom_resolvers::flare_warm;
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
    ("torrentgalaxy", 8708),
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
    // Sites Flare do spec: o laço de fundo (flare_warm) mantém a sessão
    // Cloudflare da LISTAGEM deles viva, com porte para nunca atrasar busca.
    let mut flare_profiles: Vec<Arc<ResolverProfile>> = Vec::new();

    for entry in spec.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let (name, port) = parse_entry(entry)?;
        let site_url = site_url_env(&name);
        let mirrors = site_mirrors_env(&name);
        // Mesmo `selfUrl` que o Node monta para o profile TS (`br-resolvers.ts`),
        // só que na porta do Rust: é ela que atende o `/resolve` dos links.
        let host = std::env::var("BR_RESOLVERS_HOST")
            .ok()
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let profile = Arc::new(
            ResolverProfile::with_mirrors(&name, &site_url, &mirrors, extra_protectors.clone())
                .with_self_url(&format!("http://{host}:{port}")),
        );
        if profile.network.uses_flare {
            flare_profiles.push(profile.clone());
        }
        // O HDR busca no catálogo raspado: aquece no boot, como o `warm()` do
        // TS, para a primeira busca não pagar a varredura.
        if name == "hdrtorrents" {
            adom_resolvers::flows::hdr::warm(&profile);
        }
        let config = ResolverConfig {
            port,
            site_name: name.clone(),
            callbacks: profile,
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

    // Warm da sessão Cloudflare da listagem: fundo puro, com porte para
    // pular a vez — nunca entra no orçamento de nenhuma resposta.
    flare_warm::spawn(flare_profiles);

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

/// URL primária por site quando `<SITE>_URL` não está no env — a mesma de
/// `src/config/resolvers.ts`, para Node e Rust buscarem no mesmo domínio.
const DEFAULT_URLS: &[(&str, &str)] = &[
    ("bludv", "https://bludvfilmes2.xyz"),
    ("comandotorrents", "https://comandotorrents.to"),
    ("nerdfilmes", "https://www.xfilmeshd.net"),
    ("torrentdosfilmes", "https://torrentdosfilmes-v2.xyz"),
    ("vacatorrent", "https://vaqueirofilmes1.com"),
    ("redetorrent", "https://www.redetorrent.xyz"),
    ("apachetorrent", "https://apachetorrents.com"),
    ("hdrtorrents", "https://hdrtorrents.net"),
    ("torrentgalaxy", "https://torrentgalaxy.one"),
];

/// Espelhos do operador: `<SITE>_URLS` em CSV, o `urlsEnv` dos profiles TS.
fn site_mirrors_env(name: &str) -> Vec<String> {
    std::env::var(format!("{}_URLS", name.to_uppercase()))
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// URL primária do site: `<SITE>_URL` do env, senão o default do TS.
fn site_url_env(name: &str) -> String {
    let env_key = format!("{}_URL", name.to_uppercase());
    match std::env::var(&env_key) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_URLS
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, u)| u.to_string())
            .unwrap_or_default(),
    }
}
