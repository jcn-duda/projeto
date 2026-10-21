//! Feed de holds do Node para o `adom-search` in-process (`DEBRID_AL_HOLDS`).
//!
//! Default do CÓDIGO **OFF**; o default do CORTE (`docker-compose.yml`, desde o
//! F4.6) é **ON**, junto com `DEBRID_AL_CLEANUP=on` (a checagem nativa da
//! AllDebrid é incondicional desde a R3).
//! OFF é o rollback de uma linha: o cliente nem é construído e a nativa segue
//! read-only.
//!
//! O hold volátil do autofetch e o snapshot `knownBefore` moram na memória do
//! processo Node. A checagem nativa da AllDebrid só pode limpar com
//! `holds_complete` + inventário (`alldebrid_cleanup`), então o seam
//! (`debrid_seam`) precisa perguntar esses fatos ao Node ANTES do
//! `/magnet/upload`. A ponte é a rota interna `POST /internal/debrid/holds`
//! (loopback + `X-Indexer-Test-Token`), que devolve o levantamento do lote.
//!
//! Por que rota (e não `cache.db`/estado compartilhado): os fatos são memória
//! viva (hold com TTL, `adprot` no cache L1/L2 e inventário com refresh em
//! voo) e mudam a cada busca. Ler um arquivo/registro exigiria inventar
//! identidade de lote, carimbo de validade e reconciliação — sem ganho. A rota
//! responde em memória, o cliente tem prazo curto e QUALQUER falha (sem token,
//! HTTP, corpo estranho, sem `evaluated`) devolve erro: o chamador mantém a
//! nativa READ-ONLY, como hoje. Nada é inventado e nada apaga por omissão.
//!
//! `holds_complete` sozinho não é prova: [`HoldsFacts::covers`] exige que a
//! lista `evaluated` cubra TODOS os hashes do lote (e a conta bate com
//! `account_scope` da chave no seam). O Rust confere isso de novo no
//! `verdict` antes de montar o `CheckOpts`.
//!
//! Com a flag OFF o cliente nem é construído: custo zero e comportamento
//! idêntico ao anterior (read-only).

use std::collections::HashSet;
use std::net::IpAddr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::http::{Call, HttpClient};

/// Liga o feed in-process. Default do código OFF (o corte sobe ON): OFF é o
/// rollback de uma linha e a nativa segue read-only.
pub const ENV: &str = "DEBRID_AL_HOLDS";
/// Prazo do POST interno (ms). Default 800 — a rota só lê memória.
pub const TIMEOUT_ENV: &str = "DEBRID_AL_HOLDS_TIMEOUT_MS";
/// Caminho da rota no Node.
pub const PATH: &str = "/internal/debrid/holds";

/// Default da porta do addon em loopback: com `GATEWAY=on` o Node escuta na
/// 7100 (a 7000 é a fachada Rust, que recusa `/internal/*`).
pub const DEFAULT_BASE: &str = "http://127.0.0.1:7100";

const DEFAULT_TIMEOUT_MS: u64 = 800;

/// Fatos da limpeza que só o Node conhece, para o lote desta busca.
///
/// `account` é o `sha256` da chave (mesma `accountScope` do Node) e `evaluated`
/// são os hashes do lote que a auditoria do Node realmente avaliou por
/// `isHeld || isDurablyProtected`. Sem os dois, `holds_complete` não vale.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HoldsFacts {
    pub account: String,
    pub inventory_loaded: bool,
    pub known_before: Vec<String>,
    pub held: Vec<String>,
    pub evaluated: Vec<String>,
    pub holds_complete: bool,
    /// `None` = o Node não mandou; vale o default do ambiente (como antes).
    pub drop_ready: Option<bool>,
    pub drop_uncached: Option<bool>,
}

impl HoldsFacts {
    /// O lote está COBERTO? Fail-closed: exige `holds_complete`, conta
    /// identificada e cada hash do lote presente em `evaluated`. Hash vazio no
    /// lote derruba a prova (não houve avaliação possível) e lote vazio não
    /// prova nada.
    pub fn covers(&self, hashes: &[String]) -> bool {
        if !self.holds_complete || self.account.trim().is_empty() {
            return false;
        }
        let evaluated: HashSet<String> = self
            .evaluated
            .iter()
            .map(|hash| hash.trim().to_lowercase())
            .collect();
        let mut seen = 0usize;
        for raw in hashes {
            let hash = raw.trim().to_lowercase();
            if hash.is_empty() || !evaluated.contains(&hash) {
                return false;
            }
            seen += 1;
        }
        seen > 0
    }

    /// Conjunto do inventário (`knownBefore`) em minúsculas, como o `CheckOpts`.
    pub fn known_before_set(&self) -> HashSet<String> {
        lower_set(&self.known_before)
    }

    /// Hashes protegidos pelo Node (hold volátil + `adprot`) em minúsculas.
    pub fn held_set(&self) -> HashSet<String> {
        lower_set(&self.held)
    }
}

fn lower_set(items: &[String]) -> HashSet<String> {
    items
        .iter()
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

/// `DEBRID_AL_HOLDS` (default do código OFF; o corte sobe ON). Mesmos apelidos
/// de `DEBRID_AL_CLEANUP`.
pub fn holds_feed_enabled() -> bool {
    std::env::var(ENV)
        .ok()
        .as_deref()
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "on" | "1" | "true" | "yes" | "rust"
            )
        })
        .unwrap_or(false)
}

/// `DEBRID_AL_HOLDS_TIMEOUT_MS`: default 800 ms, mínimo 1 ms.
pub fn timeout_from(raw: Option<&str>) -> Duration {
    let ms = raw
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_TIMEOUT_MS);
    Duration::from_millis(ms)
}

/// Cliente HTTP da rota interna de holds (loopback + token). Só é construído
/// com a flag ligada e token presente — sem isso não há feed.
#[derive(Clone)]
pub struct InternalHoldsClient {
    http: HttpClient,
    base: String,
    token: String,
    timeout: Duration,
}

impl InternalHoldsClient {
    pub fn new(base: &str, token: &str, timeout: Duration) -> Result<Self, String> {
        let base = base.trim_end_matches('/').to_string();
        ensure_loopback(&base)?;
        Ok(Self {
            http: HttpClient::new().map_err(|err| err.message().to_string())?,
            base,
            token: token.to_string(),
            timeout,
        })
    }

    /// Do ambiente: `DEBRID_AL_HOLDS` ligado, token interno
    /// (`DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`) e base
    /// `INTERNAL_CHECK_URL` (default loopback:7100). Qualquer ausência devolve
    /// `None` = sem feed (read-only).
    pub fn from_env() -> Option<Self> {
        if !holds_feed_enabled() {
            return None;
        }
        let token = std::env::var("DEBRID_INTERNAL_TOKEN")
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .or_else(|| {
                std::env::var("JACKETT_TEST_TOKEN")
                    .ok()
                    .filter(|raw| !raw.trim().is_empty())
            })?;
        let base = std::env::var("INTERNAL_CHECK_URL")
            .ok()
            .filter(|raw| !raw.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        let timeout = timeout_from(std::env::var(TIMEOUT_ENV).ok().as_deref());
        Self::new(&base, &token, timeout).ok()
    }

    /// POST do lote. Token só no header; a chave nunca vai no corpo (mora no
    /// `encoded`, que é o segmento de config do usuário). `deadline_at` (epoch
    /// ms) limita o prazo ao que sobra da busca: orçamento é sagrado, e o feed
    /// é opcional — estourou, a nativa desta rodada fica read-only.
    pub async fn fetch(
        &self,
        encoded: &str,
        service: &str,
        hashes: &[String],
        deadline_at: Option<i64>,
    ) -> Result<HoldsFacts, String> {
        if self.token.is_empty() {
            return Err("sem token interno".into());
        }
        if encoded.trim().is_empty() {
            return Err("encoded ausente".into());
        }
        if hashes.is_empty() {
            return Err("lote vazio".into());
        }
        let timeout = match deadline_at.filter(|deadline| *deadline > 0) {
            Some(deadline) => {
                let remaining = deadline.saturating_sub(now_ms());
                if remaining <= 0 {
                    return Err("deadline do lote já venceu".into());
                }
                self.timeout.min(Duration::from_millis(remaining as u64))
            }
            None => self.timeout,
        };
        let body = json!({
            "encoded": encoded,
            "service": service,
            "hashes": hashes,
        });
        let data = self
            .http
            .json(Call {
                method: reqwest::Method::POST,
                url: format!("{}{}", self.base, PATH),
                headers: vec![
                    ("content-type".to_string(), "application/json".to_string()),
                    ("x-indexer-test-token".to_string(), self.token.clone()),
                ],
                body: Some(body.to_string().into_bytes()),
                timeout,
                abort_safe: false,
            })
            .await
            .map_err(|err| err.message().to_string())?;
        let Some(data) = data else {
            return Err("resposta vazia da rota de holds".into());
        };
        parse_holds_response(&data)
    }
}

/// Corpo da rota → [`HoldsFacts`]. Campos estruturais são OBRIGATÓRIOS: uma
/// resposta sem `evaluated`/`holdsComplete` é de um Node antigo e não pode
/// autorizar limpeza — erro, e o chamador fica read-only.
pub fn parse_holds_response(data: &Value) -> Result<HoldsFacts, String> {
    if data.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = data
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("ok:false");
        return Err(message.to_string());
    }
    // O feed é exclusivo da AllDebrid: corpo sem serviço ou de outro serviço
    // não é aceito (o chamador fica read-only).
    let service = required_str(data, "service")?;
    if service != "alldebrid" {
        return Err(format!("serviço inesperado no feed de holds: {service}"));
    }
    let account = required_str(data, "account")?;
    let inventory_loaded = required_bool(data, "inventoryLoaded")?;
    let holds_complete = required_bool(data, "holdsComplete")?;
    Ok(HoldsFacts {
        account,
        inventory_loaded,
        known_before: required_list(data, "knownBefore")?,
        held: required_list(data, "heldHashes")?,
        evaluated: required_list(data, "evaluated")?,
        holds_complete,
        drop_ready: data.get("dropReady").and_then(Value::as_bool),
        drop_uncached: data.get("dropUncached").and_then(Value::as_bool),
    })
}

/// Só loopback: a rota Node recusa origem externa; o cliente não tenta.
pub(crate) fn ensure_loopback(base: &str) -> Result<(), String> {
    let rest = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
        .ok_or_else(|| format!("INTERNAL_CHECK_URL precisa de http(s): {base}"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else if let Some((h, port)) = authority.rsplit_once(':') {
        if port.chars().all(|c| c.is_ascii_digit()) {
            h
        } else {
            authority
        }
    } else {
        authority
    };
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    if !loopback {
        return Err(format!("INTERNAL_CHECK_URL só aceita loopback: {base}"));
    }
    Ok(())
}

/// Relógio do feed (epoch ms).
pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn required_str(data: &Value, key: &str) -> Result<String, String> {
    data.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("feed de holds sem {key}"))
}

fn required_bool(data: &Value, key: &str) -> Result<bool, String> {
    data.get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("feed de holds sem {key}"))
}

fn required_list(data: &Value, key: &str) -> Result<Vec<String>, String> {
    let list = data
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("feed de holds sem {key}"))?;
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let hash = item
            .as_str()
            .ok_or_else(|| format!("feed de holds com {key} não textual"))?;
        out.push(hash.to_string());
    }
    Ok(out)
}

#[cfg(test)]
#[path = "holds_feed_tests.rs"]
mod holds_feed_tests;
