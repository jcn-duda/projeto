//! Veredito de cache POR SERVIÇO — a costura entre a trait `DebridCheck` do
//! `adom-search` e os adaptadores deste crate.
//!
//! Réguas NADA aqui: resposta e erro já classificado viram
//! `{cached, known, unusable?}` pelo `adom-core::debrid_cache_verdict`. A
//! chave do serviço chega do caller (config do usuário), nunca hardcoded.
//!
//! Real-Debrid: a consulta é o LEDGER (`rdc:v2`, lido do `debrid.db` via
//! `peek_state` do núcleo) — hit cacheia, miss adia, blocked NÃO condena
//! (falso negativo é pior). Kill-switches:
//!
//! - `DEBRID_RD_LEDGER=off`: todo hash vira unknown (`known:false`), e o
//!   veredito sai `Unknown` de verdade — nunca "nada em cache";
//! - `DEBRID_RD_ORACLE`: o oráculo (StremThru/Torrentio) AINDA não está
//!   portado; a leitura do switch acontece e a ausência de sonda é honesta —
//!   hash sem entrada no ledger sai `Unknown`, nunca `Missing`;
//! - `DEBRID_RD_GATE`: o gate AIMD serializa ESCRITA na conta do RD
//!   (enqueue/remove); a checagem é leitura (só escreve o refresh de hit no
//!   ledger local, que é barato e não toca na conta) — o switch é respeitado
//!   por construção: não há escrita na conta para serializar.
//!
//! AllDebrid: a checagem é o `/magnet/upload` real (não abortável). A limpeza
//! (`dropUncached`/`dropReady`) fica DESLIGADA nesta fatia: o equivalente do
//! `protected.ts` (hold persistente, `knownBefore`, inventário durável) ainda
//! não está portado, e o fail-safe do núcleo (`may_delete` com
//! `inventory_loaded:false` → ninguém apaga) é respeitado passando os três
//! vetos fechadas. Este caminho serve o adom-search in-process; o HTTP
//! público `/debrid/check` devolve 501 até Fase C (senão o rust-remote
//! engole o 200 e magnets ficam na conta sem limpeza).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adom_core::{
    failure_reason, failure_verdict, ledger_key, next_on_hit, normalize_cache_result,
    normalize_hash, peek_state, CacheAnswer, CacheVerdict, UnusableReason,
};
use serde_json::{json, Value};

use crate::alldebrid::{AllDebrid, CheckOpts};
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::http::HttpClient;
use crate::premiumize::Premiumize;
use crate::realdebrid::RealDebrid;
use crate::store::Store;
use crate::torbox::TorBox;

/// TTL de hit do ledger (`DEBRID_RD_LEDGER_HIT_TTL`, em segundos; mesmo
/// default de `src/config/debrid.ts`).
const LEDGER_HIT_TTL_S: f64 = 2_592_000.0;

/// Serviço desconhecido (não é erro de rede nem de conta).
pub const UNKNOWN_SERVICE: &str = "unknown_service";

/// Veredito já normalizado, no formato de `checkCached` do TS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckOutcome {
    pub cached: Vec<String>,
    pub known: bool,
    /// `auth`/`quota` — a conta não vai responder; a lista volta P2P.
    pub unusable: Option<(UnusableKind, String)>,
}

/// Só os dois motivos que o núcleo considera `unusable`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnusableKind {
    Auth,
    Quota,
}

impl UnusableKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Quota => "quota",
        }
    }
}

/// Serviço conhecido? (mesma lista do despacho da API.)
pub fn is_known_service(service: &str) -> bool {
    matches!(
        service,
        "premiumize" | "realdebrid" | "alldebrid" | "torbox" | "debridlink"
    )
}

/// Um hash do veredito está no cache? Comparação em lower-case (o adaptador
/// devolve os hashes já normalizados).
pub fn is_cached(outcome: &CheckOutcome, hash: &str) -> bool {
    let lower = hash.to_lowercase();
    outcome.cached.iter().any(|item| *item == lower)
}

/// Checa UM serviço com a chave do caller. Erro só para serviço desconhecido;
/// falha de rede/conta vira veredito (`Unknown` ou `Unusable`), nunca pânico.
pub async fn check_service(
    service: &str,
    api_key: &str,
    hashes: &[String],
    timeout: Option<Duration>,
    store: Option<&Store>,
) -> Result<CheckOutcome, String> {
    if !is_known_service(service) {
        return Err(UNKNOWN_SERVICE.to_string());
    }
    let client = match HttpClient::new() {
        Ok(client) => client,
        Err(_) => return Ok(into_outcome(unknown_verdict())),
    };
    let verdict = match service {
        "premiumize" => match Premiumize::new(client)
            .check_cached(api_key, hashes, timeout)
            .await
        {
            Ok(report) => record(report.cached, report.complete),
            Err(err) => err_verdict(&err),
        },
        "torbox" => match TorBox::new(client)
            .check_cached(api_key, hashes, &[], timeout)
            .await
        {
            Ok(report) => record(report.cached, report.complete),
            Err(err) => err_verdict(&err),
        },
        "alldebrid" => {
            // Fase C: `drop_*` permanece false — sem hold portado, ninguém apaga.
            let opts = CheckOpts {
                timeout,
                drop_ready: false,
                drop_uncached: false,
                inventory_loaded: false,
                ..CheckOpts::default()
            };
            match AllDebrid::new(client)
                .check_cached(api_key, hashes, &opts)
                .await
            {
                Ok(report) => record(report.cached, report.complete),
                Err(err) => err_verdict(&err),
            }
        }
        "realdebrid" => {
            let ledger_on = rd_ledger_enabled();
            let peek = RealDebrid::new(client)
                .check_cached(hashes, |hash| rd_ledger_known(hash, store, ledger_on));
            let verdict = record(peek.cached, peek.complete);
            rd_renew_hits(store, &verdict.cached);
            verdict
        }
        // Debrid-Link não publica cache: lista vazia é a resposta completa.
        _ => match DebridLink::new(client).check_cached().await {
            Ok(cached) => normalize_cache_result(CacheAnswer::Set(cached)),
            Err(err) => err_verdict(&err),
        },
    };
    Ok(into_outcome(verdict))
}

/// Resposta fechada de adaptador (`complete == Some(false)` é o único
/// "não sei" — ausente e `null` contam como fechado).
fn record(cached: Vec<String>, complete: bool) -> CacheVerdict {
    normalize_cache_result(CacheAnswer::Record {
        cached,
        complete: Some(complete),
    })
}

fn unknown_verdict() -> CacheVerdict {
    CacheVerdict {
        cached: Vec::new(),
        known: false,
        unusable: None,
    }
}

fn err_verdict(err: &DebridError) -> CacheVerdict {
    let is_auth = err.kind() == "auth";
    let is_quota = err.kind() == "quota";
    let is_rate = err.kind() == "rate_limit";
    failure_verdict(failure_reason(is_auth, is_quota, is_rate), err.message())
}

fn into_outcome(verdict: CacheVerdict) -> CheckOutcome {
    CheckOutcome {
        cached: verdict.cached,
        known: verdict.known,
        unusable: verdict.unusable.map(|mark| {
            let kind = match mark.reason {
                UnusableReason::Auth => UnusableKind::Auth,
                UnusableReason::Quota => UnusableKind::Quota,
            };
            (kind, mark.message)
        }),
    }
}

// ── Ledger do Real-Debrid ───────────────────────────────────────────────────

/// `DEBRID_RD_LEDGER` (default ligado, como em `src/config/debrid.ts`).
pub fn rd_ledger_enabled() -> bool {
    env_flag("DEBRID_RD_LEDGER")
}

/// `DEBRID_RD_ORACLE` — lido e exposto; o oráculo em si é fatia futura. Com o
/// switch ligado a checagem CONTINUA honesta: só o ledger responde, e hash sem
/// entrada sai `Unknown` (nunca `Missing`).
pub fn rd_oracle_enabled() -> bool {
    env_flag("DEBRID_RD_ORACLE")
}

/// `DEBRID_RD_GATE` — o gate AIMD é para escrita na conta; a checagem não
/// escreve na conta. Exposto para diagnóstico e para os testes provarem que o
/// switch não derruba o veredito.
pub fn rd_gate_enabled() -> bool {
    env_flag("DEBRID_RD_GATE")
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|raw| raw.trim() == "true")
        .unwrap_or(true)
}

/// Estado bruto do ledger (`s` do valor gravado), para `peek_state`.
fn rd_ledger_state(hash: &str, store: Option<&Store>) -> Option<String> {
    let store = store?;
    let now_ms = now_ms();
    let raw = store.get(&ledger_key(hash), now_ms).ok().flatten()?;
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|value| value.get("s").and_then(Value::as_str).map(String::from))
}

/// Leitura do ledger: `Some(true)` hit, `Some(false)` miss medido, `None`
/// desconhecido (ledger off, sem entrada, `blocked` — não condena).
fn rd_ledger_known(hash: &str, store: Option<&Store>, ledger_on: bool) -> Option<bool> {
    match peek_state(ledger_on, rd_ledger_state(hash, store).as_deref()) {
        "hit" => Some(true),
        "miss" => Some(false),
        _ => None,
    }
}

/// Hit refresca o TTL (`next_on_hit` do núcleo). Escrita LOCAL e barata — não
/// passa pelo gate porque não toca na conta do RD.
fn rd_renew_hits(store: Option<&Store>, cached: &[String]) {
    let Some(store) = store else {
        return;
    };
    if !rd_ledger_enabled() {
        return;
    }
    let ttl = std::env::var("DEBRID_RD_LEDGER_HIT_TTL")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .filter(|ttl| *ttl >= 0.0)
        .unwrap_or(LEDGER_HIT_TTL_S);
    let now_ms = now_ms();
    let now_s = (now_ms as f64) / 1000.0;
    for hash in cached {
        let normalized = normalize_hash(hash);
        if normalized.is_empty() {
            continue;
        }
        let current = rd_ledger_state(&normalized, Some(store)).unwrap_or_else(|| "unknown".into());
        let Some(write) = next_on_hit(true, ttl, now_s, &current) else {
            continue;
        };
        let value = json!({ "s": write.s, "at": write.at, "n": write.n });
        let _ = store.put(
            &ledger_key(&normalized),
            &value.to_string(),
            now_ms + (write.ttl_seconds * 1000.0) as i64,
            now_ms,
        );
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// JSON da resposta da rota `/debrid/check` (mesma forma para os 5 serviços).
pub fn outcome_json(outcome: &CheckOutcome) -> Value {
    json!({
        "cached": outcome.cached,
        "complete": outcome.known,
        "known": outcome.known,
        "unusable": match &outcome.unusable {
            Some((kind, message)) => json!({ "reason": kind.as_str(), "message": message }),
            None => Value::Null,
        },
    })
}

#[cfg(test)]
#[path = "verdict_tests.rs"]
mod verdict_tests;
