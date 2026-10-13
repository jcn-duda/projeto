//! Subcomando `probe`: busca UMA página de UM site e mostra o resultado.
//!
//! Equivalente ao `scripts/crawl-site-probe.ts` do motor TS, mas para uma URL específica.
//!
//! Uso:
//!   adom-crawl probe --site=vacatorrent --url=https://vaqueirofilmes1.com/movie-links/12345/
//!   adom-crawl probe --site=nerdfilmes --url=https://nerdfilmes.net/filme/12345 --json

use std::sync::{Arc, Mutex};
use std::time::Instant;

use adom_crawl::flare::{fetch_text_crawl, CrawlFetchDeps, FlareSessions};
use adom_crawl::net::{fetch_text_direct, FetchDirectOptions};
use adom_crawl::page_parser::parse_crawl_page;
use adom_crawl::site_profiles::{resolve_allowlist, site_network_config};

/// Erros que o probe pode retornar.
#[derive(Debug)]
pub enum ProbeError {
    /// Argumento obrigatório faltando ou inválido.
    Arg(String),
    /// Site não encontrado no perfil.
    SiteNotFound(String),
    /// Erro de rede (fetch).
    Fetch(String),
    /// Erro de parsing.
    Parse(String),
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::Arg(msg) => write!(f, "argumento: {}", msg),
            ProbeError::SiteNotFound(site) => write!(f, "site não encontrado: {}", site),
            ProbeError::Fetch(msg) => write!(f, "fetch: {}", msg),
            ProbeError::Parse(msg) => write!(f, "parse: {}", msg),
        }
    }
}

impl std::error::Error for ProbeError {}

/// Argumentos parseados do subcomando probe.
struct ProbeArgs {
    site: String,
    url: String,
    flare_url: String,
    timeout_ms: u64,
    no_parse: bool,
    json: bool,
}

/// Parseia os argumentos do subcomando probe.
fn parse_args(args: &[String]) -> Result<ProbeArgs, ProbeError> {
    let mut site: Option<String> = None;
    let mut url: Option<String> = None;
    let mut flare_url = "http://127.0.0.1:8191".to_string();
    let mut timeout_ms = 15000u64;
    let mut no_parse = false;
    let mut json = false;

    for arg in args {
        if let Some(val) = arg.strip_prefix("--site=") {
            site = Some(val.to_string());
        } else if let Some(val) = arg.strip_prefix("--url=") {
            url = Some(val.to_string());
        } else if let Some(val) = arg.strip_prefix("--flare-url=") {
            flare_url = val.to_string();
        } else if let Some(val) = arg.strip_prefix("--timeout-ms=") {
            timeout_ms = val.parse::<u64>().map_err(|_| {
                ProbeError::Arg(format!("--timeout-ms inválido: {}", val))
            })?;
        } else if arg == "--no-parse" {
            no_parse = true;
        } else if arg == "--json" {
            json = true;
        } else {
            return Err(ProbeError::Arg(format!("flag desconhecida: {}", arg)));
        }
    }

    let site = site.ok_or_else(|| ProbeError::Arg("--site é obrigatório".into()))?;
    let url = url.ok_or_else(|| ProbeError::Arg("--url é obrigatório".into()))?;

    Ok(ProbeArgs {
        site,
        url,
        flare_url,
        timeout_ms,
        no_parse,
        json,
    })
}

/// Resultado do fetch para serialização JSON.
#[derive(serde::Serialize)]
struct ProbeResult {
    site: String,
    url: String,
    bytes: usize,
    elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    parsed: Option<ParsedOutput>,
}

/// Resultado do parsing para serialização JSON.
#[derive(serde::Serialize)]
struct ParsedOutput {
    title: Option<String>,
    year: Option<i64>,
    releases: usize,
    groups: usize,
    btih: Vec<String>,
}

/// Executa o subcomando probe (async — chamado pelo main com tokio).
pub async fn run(args: &[String]) -> Result<(), ProbeError> {
    let opts = parse_args(args)?;

    // Busca configuração do site no perfil.
    let site_config = site_network_config(&opts.site)
        .ok_or_else(|| ProbeError::SiteNotFound(opts.site.clone()))?;

    // Monta allowlist a partir da config do site.
    let allowlist = resolve_allowlist(site_config);

    // Fetch da página com medição de tempo.
    let start = Instant::now();
    let body = if site_config.uses_flare {
        let sessions = Arc::new(Mutex::new(FlareSessions::new(
            site_config.flare_session_ttl_ms,
        )));
        let deps = CrawlFetchDeps {
            allowlist,
            sessions,
            solver_url: opts.flare_url.clone(),
            flare_timeout_ms: 55_000,
            direct_timeout_ms: opts.timeout_ms,
            max_hops: site_config.max_hops,
            user_agent: site_config.user_agent.clone(),
            on_request: None,
        };
        fetch_text_crawl(&opts.url, &deps)
            .await
            .map_err(|e| ProbeError::Fetch(e.to_string()))?
    } else {
        let fetch_opts = FetchDirectOptions {
            timeout_ms: opts.timeout_ms,
            max_hops: site_config.max_hops,
            allowlist,
            user_agent: site_config.user_agent.clone(),
            accept: "text/html".to_string(),
            cookie_jar: None,
            headers: std::collections::HashMap::new(),
        };
        fetch_text_direct(&opts.url, fetch_opts)
            .await
            .map_err(|e| ProbeError::Fetch(e.to_string()))?
    };

    let elapsed = start.elapsed();
    let bytes = body.len();

    // Output do fetch.
    if opts.json {
        let parsed = if !opts.no_parse {
            let page = parse_crawl_page(&opts.site, "movie", &opts.url, &body);
            let btih: Vec<String> = page
                .releases
                .iter()
                .filter_map(|r| extract_btih(&r.magnet))
                .collect();
            Some(ParsedOutput {
                title: page.title.clone(),
                year: page.year,
                releases: page.releases.len(),
                groups: page.groups.len(),
                btih,
            })
        } else {
            None
        };

        let result = ProbeResult {
            site: opts.site.clone(),
            url: opts.url.clone(),
            bytes,
            elapsed_ms: elapsed.as_millis() as u64,
            parsed,
        };

        let json = serde_json::to_string_pretty(&result)
            .map_err(|e| ProbeError::Parse(format!("serialização JSON: {}", e)))?;
        println!("{}", json);
    } else {
        println!("[probe] site={} url={}", opts.site, opts.url);
        println!(
            "[probe] fetch: {} bytes, {:.3}s",
            bytes,
            elapsed.as_secs_f64()
        );

        if !opts.no_parse {
            let page = parse_crawl_page(&opts.site, "movie", &opts.url, &body);
            let btih: Vec<String> = page
                .releases
                .iter()
                .filter_map(|r| extract_btih(&r.magnet))
                .collect();

            let title_str = page
                .title
                .as_ref()
                .map(|t| format!("\"{}\"", t))
                .unwrap_or_else(|| "None".into());
            let year_str = page
                .year
                .map(|y| y.to_string())
                .unwrap_or_else(|| "None".into());

            println!(
                "[probe] parse: {} releases, {} groups, title={} year={}",
                page.releases.len(),
                page.groups.len(),
                title_str,
                year_str
            );
            println!("[probe] btih: {:?}", btih);
        }
    }

    Ok(())
}

/// Extrai o btih (infohash) de um magnet link.
fn extract_btih(magnet: &str) -> Option<String> {
    let prefix = "btih:";
    if let Some(pos) = magnet.find(prefix) {
        let start = pos + prefix.len();
        let hash: String = magnet[start..]
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if hash.len() >= 32 {
            return Some(hash.to_lowercase());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_args_minimal() {
        let args = vec![
            "--site=vacatorrent".into(),
            "--url=https://vaqueirofilmes1.com/movie/123".into(),
        ];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.site, "vacatorrent");
        assert_eq!(opts.url, "https://vaqueirofilmes1.com/movie/123");
        assert_eq!(opts.flare_url, "http://127.0.0.1:8191");
        assert_eq!(opts.timeout_ms, 15000);
        assert!(!opts.no_parse);
        assert!(!opts.json);
    }

    #[test]
    fn test_parse_args_all_flags() {
        let args = vec![
            "--site=nerdfilmes".into(),
            "--url=https://nerdfilmes.net/filme/456".into(),
            "--flare-url=http://localhost:9000".into(),
            "--timeout-ms=30000".into(),
            "--no-parse".into(),
            "--json".into(),
        ];
        let opts = parse_args(&args).unwrap();
        assert_eq!(opts.site, "nerdfilmes");
        assert_eq!(opts.flare_url, "http://localhost:9000");
        assert_eq!(opts.timeout_ms, 30000);
        assert!(opts.no_parse);
        assert!(opts.json);
    }

    #[test]
    fn test_parse_args_missing_site() {
        let args = vec!["--url=https://example.com".into()];
        let err = parse_args(&args).unwrap_err();
        assert!(matches!(err, ProbeError::Arg(_)));
    }

    #[test]
    fn test_parse_args_missing_url() {
        let args = vec!["--site=vacatorrent".into()];
        let err = parse_args(&args).unwrap_err();
        assert!(matches!(err, ProbeError::Arg(_)));
    }

    #[test]
    fn test_extract_btih_valid() {
        let magnet = "magnet:?xt=urn:btih:ABC123DEF456789012345678901234&dn=test";
        assert_eq!(
            extract_btih(magnet),
            Some("abc123def456789012345678901234".into())
        );
    }

    #[test]
    fn test_extract_btih_invalid() {
        assert_eq!(extract_btih("not-a-magnet"), None);
        assert_eq!(extract_btih("magnet:?xt=urn:btih:short"), None);
    }
}
