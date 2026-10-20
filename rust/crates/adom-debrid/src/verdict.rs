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
//! segura mora em `alldebrid_cleanup`: `DEBRID_AL_CLEANUP` (default OFF),
//! hold/`adprot`, `knownBefore` e a fila com backoff. Só nasce plano com a
//! flag **e** `holds_complete` e inventário. O hold volátil do autofetch mora
//! no processo Node, então o seam in-process entrega os fatos por
//! [`check_service_report_with`] (feed `/internal/debrid/holds`, ligado por
//! `DEBRID_AL_HOLDS`, default OFF). Sem os fatos — ou com cobertura
//! incompleta — o `holds_complete` fica falso e a nativa é READ-ONLY: nenhum
//! hash sai. O HTTP público `/debrid/check` devolve 501 com
//! `DEBRID_AL_RUST=off` até Fase C.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use adom_core::{
    failure_reason, failure_verdict, ledger_key, next_on_hit, normalize_cache_result,
    normalize_hash, peek_state, CacheAnswer, CacheVerdict, UnusableReason,
};
use serde_json::{json, Value};

use crate::alldebrid::{AllDebrid, CheckOpts};
use crate::alldebrid_cleanup::{env_truthy, CleanupMode, CleanupPlan, DurablePeek};
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::holds_feed::HoldsFacts;
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

/// Veredito + se a checagem chegou a falar com o serviço. `attempted:false`
/// libera o fallback Node sem risco de segundo upload (AllDebrid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceCheck {
    pub outcome: CheckOutcome,
    pub attempted: bool,
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
    outcome.cached.contains(&lower)
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
    Ok(
        check_service_report(service, api_key, hashes, timeout, store)
            .await?
            .outcome,
    )
}

/// Igual a [`check_service`], mas informa se a checagem chegou a falar com o
/// serviço (`attempted`). O `adom-search` usa isso para decidir o fallback
/// Node da AllDebrid: sem upload enviado, é seguro perguntar de novo; depois
/// de um upload real, um segundo só dobraria o lixo na conta.
pub async fn check_service_report(
    service: &str,
    api_key: &str,
    hashes: &[String],
    timeout: Option<Duration>,
    store: Option<&Store>,
) -> Result<ServiceCheck, String> {
    check_service_report_with(service, api_key, hashes, timeout, store, None).await
}

/// Igual a [`check_service_report`], mas recebe os fatos do feed de holds do
/// Node (AllDebrid). `None` = caminho antigo: a nativa é READ-ONLY (limpeza só
/// com `holds_complete`, que ninguém provou).
///
/// Os fatos só valem com `DEBRID_AL_CLEANUP=on`; mesmo ON, [`HoldsFacts::covers`]
/// é reconferido aqui — um `holds_complete` sem `evaluated` cobrindo o lote não
/// autoriza nada (fail-closed).
pub async fn check_service_report_with(
    service: &str,
    api_key: &str,
    hashes: &[String],
    timeout: Option<Duration>,
    store: Option<&Store>,
    facts: Option<&HoldsFacts>,
) -> Result<ServiceCheck, String> {
    if !is_known_service(service) {
        return Err(UNKNOWN_SERVICE.to_string());
    }
    let client = match HttpClient::new() {
        Ok(client) => client,
        Err(_) => {
            return Ok(ServiceCheck {
                outcome: into_outcome(unknown_verdict()),
                attempted: false,
            })
        }
    };
    let (verdict, attempted) = match service {
        "premiumize" => match Premiumize::new(client)
            .check_cached(api_key, hashes, timeout)
            .await
        {
            Ok(report) => (record(report.cached, report.complete), true),
            Err(err) => (err_verdict(&err), true),
        },
        "torbox" => match TorBox::new(client)
            .check_cached(api_key, hashes, &[], timeout)
            .await
        {
            Ok(report) => (record(report.cached, report.complete), true),
            Err(err) => (err_verdict(&err), true),
        },
        "alldebrid" => {
            // `DEBRID_AL_CLEANUP` (default OFF) é a única porta para apagar.
            // Mesmo ON, o plano só nasce com `holds_complete` + inventário. O
            // hold volátil do autofetch mora no Node: ou os fatos chegam pelo
            // feed in-process (`DEBRID_AL_HOLDS=on`), ou a nativa segue
            // read-only — nunca "completo" por omissão.
            let cleanup = CleanupMode::from_env();
            let opts = alldebrid_opts(cleanup, timeout, facts, hashes);
            let ad = AllDebrid::new(client);
            match ad.check_cached_report(api_key, hashes, &opts).await {
                Ok(report) => {
                    // Fire-and-forget, como o `dropMagnets` do Node: a resposta
                    // nunca espera o backoff. Plano vazio (holds incompletos)
                    // não spawna nada.
                    spawn_cleanup(&ad, api_key, report.cleanup.clone());
                    (record(report.cached, report.complete), report.attempted)
                }
                Err(failure) => (err_verdict(&failure.error), failure.attempted),
            }
        }
        "realdebrid" => {
            let ledger_on = rd_ledger_enabled();
            let peek = RealDebrid::new(client)
                .check_cached(hashes, |hash| rd_ledger_known(hash, store, ledger_on));
            let verdict = record(peek.cached, peek.complete);
            rd_renew_hits(store, &verdict.cached);
            (verdict, true)
        }
        // Debrid-Link não publica cache (`cacheCheck = false`): a lista vazia é
        // "não sei", NUNCA "nada em cache". `Set` aqui viraria `known:true` e
        // esconderia a lista inteira sob `cachedOnly`; o Node devolve
        // `known:false` e manda tudo pelo `/resolve` (degradado).
        _ => match DebridLink::new(client).check_cached().await {
            Ok(_) => (
                normalize_cache_result(CacheAnswer::Record {
                    cached: Vec::new(),
                    complete: Some(crate::debridlink::CACHE_CHECK),
                }),
                false,
            ),
            Err(err) => (err_verdict(&err), false),
        },
    };
    Ok(ServiceCheck {
        outcome: into_outcome(verdict),
        attempted,
    })
}

/// `CheckOpts` da AllDebrid nesta rodada. Três estados, do mais seguro ao mais
/// permissivo:
///
/// - limpeza OFF (default): read-only; fatos e `drop_*` são ignorados;
/// - ON **sem** fatos: `inventory_loaded:false` + `holds_complete:false` — a
///   nativa segue read-only (`holds_incomplete`), como antes do feed;
/// - ON **com** fatos: drops do Node (ou env), inventário/`knownBefore` e held
///   do lote; `holds_complete` só com [`HoldsFacts::covers`] (o flag do Node
///   sozinho não autoriza).
pub(crate) fn alldebrid_opts(
    cleanup: CleanupMode,
    timeout: Option<Duration>,
    facts: Option<&HoldsFacts>,
    hashes: &[String],
) -> CheckOpts {
    let mut opts = CheckOpts {
        timeout,
        cleanup,
        ..CheckOpts::default()
    };
    if !cleanup.is_on() {
        // READ-ONLY: nem o inventário próprio é lido (`cleanup_run` sai no
        // primeiro portão).
        return opts;
    }
    opts.durable = Some(std::sync::Arc::new(DurablePeek::from_env()));
    match facts {
        Some(facts) => {
            opts.drop_ready = facts
                .drop_ready
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_READY", true));
            opts.drop_uncached = facts
                .drop_uncached
                .unwrap_or_else(|| env_truthy("DEBRID_DROP_UNCACHED", true));
            opts.inventory_loaded = facts.inventory_loaded;
            opts.known_before = facts.known_before_set();
            opts.held = facts.held_set();
            // Reconfere a cobertura do lote: `holdsComplete` sem `evaluated`
            // cobrindo os hashes não vale nada.
            opts.holds_complete = facts.covers(hashes);
        }
        None => {
            // Sem feed: os `drop_*` do ambiente ficam como antes, mas
            // `holds_complete:false` suprime o plano (`holds_incomplete`).
            opts.drop_ready = env_truthy("DEBRID_DROP_READY", true);
            opts.drop_uncached = env_truthy("DEBRID_DROP_UNCACHED", true);
        }
    }
    opts
}

/// Resposta fechada de adaptador (`complete == Some(false)` é o único
/// "não sei" — ausente e `null` contam como fechado).
fn record(cached: Vec<String>, complete: bool) -> CacheVerdict {
    normalize_cache_result(CacheAnswer::Record {
        cached,
        complete: Some(complete),
    })
}

/// Agenda a fila de delete DEPOIS da resposta. Plano vazio (flag OFF ou
/// `holds_complete=false`) não spawna: a nativa segue read-only.
fn spawn_cleanup(ad: &AllDebrid, api_key: &str, plan: Option<CleanupPlan>) {
    let Some(plan) = plan.filter(|plan| !plan.is_empty()) else {
        return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        eprintln!("[alldebrid] limpeza nativa sem runtime; plano descartado");
        return;
    };
    let ad = ad.clone();
    let key = api_key.to_string();
    handle.spawn(async move {
        let _ = plan.run(&ad, &key).await;
    });
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

/// Veredito de sucesso da checagem (usado pela rota interna, que monta o
/// `CheckOpts` com os fatos de limpeza do corpo).
pub fn cached_outcome(cached: Vec<String>, complete: bool) -> CheckOutcome {
    into_outcome(record(cached, complete))
}

/// Mesma classificação de erro do adaptador: auth/quota viram `unusable`,
/// rate limit continua `known:false` (transitório, nunca condena).
pub fn error_outcome(err: &DebridError) -> CheckOutcome {
    into_outcome(err_verdict(err))
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
