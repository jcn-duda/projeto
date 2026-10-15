//! Botões de protetor seguidos pelo resolver local (`/resolve` das portas
//! 8700–8707), antes do veredito da página.
//!
//! Nerd (`/link.php`), Comando e TDF publicam o torrent atrás de um protetor.
//! O motor TS segue cada botão pelo resolver; sem isto o sidecar via a página
//! só com protetor e a fechava `no-torrent` (medido 2026-10-14: o `/link.php`
//! do Nerd entrega o magnet e o acervo do site inteiro não era colhido).
//! O resolver já tem a régua de cada site (allowlist, saltos, extração do
//! magnet); aqui só se pergunta a ele, botão por botão.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::page_parser::canonical_site_id;
use crate::resolver_matching::button_id;

/// Onde estão os resolvers e quanto esperar por botão. O binário preenche do
/// ambiente (`BR_RESOLVERS_HOST`, `BR_RESOLVERS_PORT_OFFSET`); a lib não lê `.env`.
#[derive(Debug, Clone)]
pub struct ProtectorFollow {
    pub host: String,
    pub port_offset: u16,
    /// Prazo de UM botão (o resolver pode passar pelo FlareSolverr).
    pub timeout_ms: u64,
    /// Teto de botões seguidos por página (post com dezenas de episódios).
    pub max_buttons: usize,
}

impl Default for ProtectorFollow {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_string(),
            port_offset: 0,
            timeout_ms: 45_000,
            max_buttons: 40,
        }
    }
}

/// Desfecho de um botão no resolver.
#[derive(Debug, PartialEq)]
enum ButtonOutcome {
    Magnet(String),
    /// Resposta definitiva: repetir dá o mesmo (botão expirado, sem magnet).
    Terminal,
    /// Rede, prazo ou site fora: a página volta à fila.
    Transient(String),
}

/// Porta do resolver de cada site (`config.resolvers.ports` do TS).
pub fn resolver_port(site: &str) -> Option<u16> {
    match canonical_site_id(site) {
        "comandotorrents" => Some(8701),
        "nerdfilmes" => Some(8702),
        "torrentdosfilmesv2" => Some(8703),
        _ => None,
    }
}

impl ProtectorFollow {
    /// Segue os botões em série (o resolver e o site são um só recurso) e
    /// devolve `href do botão → magnet`. Sem nenhum magnet e com falha
    /// transitória, é `Err`: a página é retentada, nunca fechada sem torrent.
    pub async fn resolve_buttons(
        &self,
        site: &str,
        post_url: &str,
        buttons: &[String],
        cost: &Arc<AtomicU32>,
    ) -> Result<HashMap<String, String>, String> {
        let mut resolved = HashMap::new();
        let Some(port) = resolver_port(site) else {
            return Ok(resolved);
        };
        let base = format!("http://{}:{}/resolve", self.host, port + self.port_offset);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(self.timeout_ms))
            .build()
            .map_err(|e| format!("protetor: cliente http: {e}"))?;
        let count = buttons.len().to_string();
        let mut transient = None;
        for (index, button) in buttons.iter().enumerate().take(self.max_buttons) {
            cost.fetch_add(1, Ordering::SeqCst);
            let query = [
                ("url", post_url.to_string()),
                ("i", index.to_string()),
                ("h", button_id(button)),
                ("n", count.clone()),
            ];
            let outcome = match client.get(&base).query(&query).send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let body = resp.text().await.unwrap_or_default();
                    classify(status, &body, button, post_url)
                }
                Err(e) => ButtonOutcome::Transient(format!("resolver local: {e}")),
            };
            match outcome {
                ButtonOutcome::Magnet(m) => {
                    resolved.insert(button.clone(), m);
                }
                ButtonOutcome::Terminal => {}
                ButtonOutcome::Transient(msg) => transient = Some(msg),
            }
        }
        match transient {
            Some(msg) if resolved.is_empty() => Err(format!("protetor: {msg}")),
            _ => Ok(resolved),
        }
    }
}

/// Régua do `isTerminalButtonError` do TS (`crawl-sites/nerdfilmes.ts`): botão
/// expirado/sem magnet é terminal, e o 400 do gate `/link.php` de MESMO ORIGIN
/// também (o site não decodifica aquele blob, repetir dá o mesmo 400).
fn classify(status: u16, body: &str, button: &str, post_url: &str) -> ButtonOutcome {
    let body = body.trim();
    if status == 200 && body.starts_with("magnet:?") {
        return ButtonOutcome::Magnet(body.to_string());
    }
    let lower = body.to_lowercase();
    if lower.contains("protector_link_expired")
        || lower.contains("protector_non_magnet")
        || lower.contains("no_such_button")
        || (lower.contains("http_400") && is_same_origin_gate(button, post_url))
    {
        return ButtonOutcome::Terminal;
    }
    ButtonOutcome::Transient(format!(
        "http_{status} {}",
        body.chars().take(80).collect::<String>()
    ))
}

fn is_same_origin_gate(button: &str, post_url: &str) -> bool {
    match (url::Url::parse(button), url::Url::parse(post_url)) {
        (Ok(b), Ok(p)) => b.origin() == p.origin() && b.path().eq_ignore_ascii_case("/link.php"),
        _ => false,
    }
}

#[cfg(test)]
#[path = "protector_follow_tests.rs"]
mod tests;
