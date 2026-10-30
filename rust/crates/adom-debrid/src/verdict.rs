//! Veredito de cache POR SERVIÇO — a costura entre a trait `DebridCheck` do
//! `adom-search` e os adaptadores deste crate.
//!
//! Réguas NADA aqui: resposta e erro já classificado viram
//! `{cached, known, unusable?}` pelo `adom-core::debrid_cache_verdict`. A
//! chave do serviço chega do caller (config do usuário), nunca hardcoded.
//!
//! Real-Debrid: a consulta é o LEDGER (`rdc:v2`, lido do `cache.db` do Node
//! por um `Store` read-only, via `peek_state` do núcleo) — hit cacheia, miss
//! adia, blocked NÃO condena (falso negativo é pior). Kill-switches:
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
//! hash sai. O HTTP público `/debrid/check` responde a AllDebrid como os
//! demais serviços (incondicional desde a R3).

use std::time::Duration;

use adom_core::{
    failure_reason, failure_verdict, normalize_cache_result, CacheAnswer, CacheVerdict,
    UnusableReason,
};
use serde_json::{json, Value};

use crate::alldebrid::{AllDebrid, CheckOpts};
use crate::alldebrid_cleanup::{account_scope, env_truthy, CleanupMode, CleanupPlan, DurablePeek};
use crate::debridlink::DebridLink;
use crate::error::DebridError;
use crate::holds_feed::HoldsFacts;
use crate::http::HttpClient;
use crate::premiumize::Premiumize;
use crate::realdebrid::RealDebrid;
use crate::store::Store;
use crate::torbox::TorBox;

#[path = "verdict_ledger.rs"]
mod verdict_ledger;
use verdict_ledger::{now_ms, rd_ledger_known, rd_renew_hits};
pub use verdict_ledger::{rd_gate_enabled, rd_ledger_enabled, rd_oracle_enabled};

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
            Ok(report) => {
                // Total do torrent (`tsz`), antes do veredito: só grava, nunca espera.
                let totals = report
                    .totals
                    .iter()
                    .map(|(hash, bytes)| (hash.clone(), *bytes as f64))
                    .collect();
                crate::file_sizes::spawn_record(Vec::new(), totals);
                (record(report.cached, report.complete), true)
            }
            Err(err) => (err_verdict(&err), true),
        },
        "torbox" => match TorBox::new(client)
            .check_cached(api_key, hashes, &[], timeout)
            .await
        {
            Ok(report) => {
                // Lista de vídeos (`fsz`) que o TorBox leu na checagem.
                crate::file_sizes::spawn_record(
                    crate::file_sizes::torbox_files(&report.files),
                    Vec::new(),
                );
                (record(report.cached, report.complete), true)
            }
            Err(err) => (err_verdict(&err), true),
        },
        "alldebrid" => {
            // `DEBRID_AL_CLEANUP` (default OFF) é a única porta para apagar.
            // Mesmo ON, o plano só nasce com `holds_complete` + inventário. O
            // hold volátil do autofetch mora no Node: ou os fatos chegam pelo
            // feed in-process (`DEBRID_AL_HOLDS=on`), ou a nativa segue
            // read-only — nunca "completo" por omissão.
            let cleanup = CleanupMode::from_env();
            // O leitor do `cache.db` do Node serve dois papéis nesta checagem:
            // filtro de upload (`adrm`, sempre) e guarda durável da limpeza.
            let durable = DurablePeek::from_env();
            let opts = alldebrid_opts(cleanup, timeout, facts, hashes, api_key, &durable);
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
/// - limpeza OFF (default): read-only para APAGAR; fatos e `drop_*` são
///   ignorados. O filtro de upload (`adrm`) continua valendo;
/// - ON **sem** fatos: `inventory_loaded:false` + `holds_complete:false` — a
///   nativa segue read-only (`holds_incomplete`), como antes do feed;
/// - ON **com** fatos: drops do Node (ou env), inventário/`knownBefore` e held
///   do lote; `holds_complete` só com [`HoldsFacts::covers`] (o flag do Node
///   sozinho não autoriza).
///
/// `durable` é o leitor do `cache.db` do Node e é lido ANTES do early return:
/// o `adrm:v1` (anti-reenchimento) é filtro de UPLOAD, leitura read-only sem
/// efeito colateral, e vale mesmo com a limpeza desligada — sem ele a checagem
/// re-sobe ao `/magnet/upload` o hash que a limpeza apagou de propósito. Só o
/// `CheckOpts.durable` (a guarda `adprot`/`adsub` da limpeza) depende da flag.
pub(crate) fn alldebrid_opts(
    cleanup: CleanupMode,
    timeout: Option<Duration>,
    facts: Option<&HoldsFacts>,
    hashes: &[String],
    api_key: &str,
    durable: &DurablePeek,
) -> CheckOpts {
    let mut opts = CheckOpts {
        timeout,
        cleanup,
        blocked: durable.blocked_hashes(&account_scope(api_key), now_ms()),
        ..CheckOpts::default()
    };
    if !cleanup.is_on() {
        // READ-ONLY para apagar: nem o inventário próprio é lido (`cleanup_run`
        // sai no primeiro portão) e o `adprot`/`adsub` não entra no `CheckOpts`.
        return opts;
    }
    opts.durable = Some(std::sync::Arc::new(durable.clone()));
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

/// JSON da resposta da rota `/debrid/check` (mesma forma para os 5 serviços).
///
/// `blocked` sempre sai no corpo (vazio inclusive): são os hashes que o
/// anti-reenchimento (`adrm`) tirou do `/magnet/upload` na AllDebrid — o Node
/// usa a lista para o escape "pronto no inventário" e os demais serviços nunca
/// têm o que devolver. `known`/`complete` continuam intocados: bloqueado não é
/// "frio conhecido" nem ausência de resposta.
pub fn outcome_json(outcome: &CheckOutcome, blocked: &[String]) -> Value {
    json!({
        "cached": outcome.cached,
        "blocked": blocked,
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
