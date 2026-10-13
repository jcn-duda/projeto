use regex::Regex;
use std::sync::OnceLock;

static SITE_LEVEL_ERROR_RE: OnceLock<Regex> = OnceLock::new();

/// O texto do erro pertence à classe "site fora/bloqueado"?
/// Casa status HTTP (403/429/5xx), host bloqueado pela segurança do resolver (`blocked_host:...`)
/// e o desafio do Cloudflare.
pub fn is_site_level_error(text: &str) -> bool {
    let re = SITE_LEVEL_ERROR_RE.get_or_init(|| {
        Regex::new(r"(?i)(?:(?-u:\b)403(?-u:\b)|(?-u:\b)429(?-u:\b)|(?-u:\b)5\d{2}(?-u:\b)|blocked_host|challenge|cloudflare|just a moment)").unwrap()
    });
    re.is_match(text)
}
