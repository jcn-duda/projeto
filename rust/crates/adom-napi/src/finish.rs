//! Fronteira napi das decisões puras do FIM da busca (`adom_core::search_finish`):
//! commit no cache, promoção tardia e elegibilidade do SWR.
//!
//! O corpo TS de `src/providers/search-commit.ts` virou casca desta ponte; o
//! oráculo do golden é o TypeScript do worktree `../adom-esm` (o módulo é folha
//! e roda lá). Nada aqui lê config, cache ou relógio: os fatos entram por JSON e
//! a decisão volta por JSON, no mesmo formato que o TS consome.
//!
//! # Contrato de fronteira
//!
//! Objetos cruzam como STRING JSON; `debridKnown: null` chega como `None` (o
//! `undefined` do TS é estado REAL: a checagem no debrid nunca respondeu).
//! Entrada inválida devolve `napi::Error` — nenhuma função daqui pode panicar
//! por causa do JSON.

use adom_core as core;
use napi_derive::napi;
use serde::Deserialize;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Entradas (JSON)
// ---------------------------------------------------------------------------

/// Argumentos de `commitDecision`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct CommitInput {
    playable: bool,
    partial: bool,
    /// `null`/ausente = `undefined` no TS: estado REAL, não "falso".
    debrid_known: Option<bool>,
    needs_debrid_refresh: bool,
    has_fallback: bool,
    cache_ttl: i64,
    fallback_streams_ttl: i64,
}

/// Estado dos indexers vivos, opcional na promoção tardia.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LiveInput {
    needs_fallback: bool,
    has_any_failure: bool,
}

/// Argumentos de `latePromotionDecision`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LateInput {
    hit_partial: bool,
    hit_fallback: bool,
    hit_has_streams: bool,
    hit_debrid_known: bool,
    live: Option<LiveInput>,
    cache_ttl: i64,
}

fn parse_json<T: for<'de> Deserialize<'de>>(input: &str) -> napi::Result<T> {
    serde_json::from_str(input)
        .map_err(|e| napi::Error::from_reason(format!("entrada JSON inválida: {e}")))
}

fn to_json<T: serde::Serialize>(value: &T) -> napi::Result<String> {
    serde_json::to_string(value)
        .map_err(|e| napi::Error::from_reason(format!("saída JSON inválida: {e}")))
}

/// Entry do cache: ausente, `null` ou inválida não pode derrubar a chamada.
/// `null` explícito é "sem entrada" (o `Some(Value::Null)` do TS não é objeto).
fn parse_entry(entry_json: Option<String>) -> napi::Result<Option<Value>> {
    let Some(raw) = entry_json else {
        return Ok(None);
    };
    let value: Value = parse_json(&raw)?;
    Ok(if value.is_null() { None } else { Some(value) })
}

// ---------------------------------------------------------------------------
// Decisões
// ---------------------------------------------------------------------------

/// `commitDecision`: `{write, ttl, partial, debridKnown}`.
#[napi(catch_unwind)]
pub fn commit_decision(input: String) -> napi::Result<String> {
    let req: CommitInput = parse_json(&input)?;
    let decision = core::commit_decision(&core::CommitFacts {
        playable: req.playable,
        partial: req.partial,
        debrid_known: req.debrid_known,
        needs_debrid_refresh: req.needs_debrid_refresh,
        has_fallback: req.has_fallback,
        cache_ttl: req.cache_ttl,
        fallback_streams_ttl: req.fallback_streams_ttl,
    });
    to_json(&json!({
        "write": decision.write,
        "ttl": decision.ttl,
        "partial": decision.partial,
        "debridKnown": decision.debrid_known,
    }))
}

/// `latePromotionDecision`: `{action, reason, ttl, debridKnown}`.
///
/// A casca TS monta o `live` com SÓ o booleano do ramo que o núcleo vai ler —
/// o curto-circuito do TS antigo (`needsFallback()` só na reserva,
/// `hasAnyFailure()` só na lista vazia) continua valendo.
#[napi(catch_unwind)]
pub fn late_promotion_decision(input: String) -> napi::Result<String> {
    let req: LateInput = parse_json(&input)?;
    let live = req.live.as_ref().map(|live| core::LiveState {
        needs_fallback: live.needs_fallback,
        has_any_failure: live.has_any_failure,
    });
    let decision = core::late_promotion_decision(&core::LateFacts {
        hit_partial: req.hit_partial,
        hit_fallback: req.hit_fallback,
        hit_has_streams: req.hit_has_streams,
        hit_debrid_known: req.hit_debrid_known,
        live,
        cache_ttl: req.cache_ttl,
    });
    to_json(&json!({
        "action": decision.action.as_str(),
        "reason": decision.reason.as_str(),
        "ttl": decision.ttl,
        "debridKnown": decision.debrid_known,
    }))
}

/// `debridRefreshSatisfied`: a entrada nasceu de uma checagem CONFIÁVEL.
#[napi(catch_unwind)]
pub fn debrid_refresh_satisfied(entry_json: Option<String>) -> napi::Result<bool> {
    let entry = parse_entry(entry_json)?;
    Ok(core::debrid_refresh_satisfied(entry.as_ref()))
}

/// `staleRefreshEligible`: SWR só serve entrada promovível E tocável.
#[napi(catch_unwind)]
pub fn stale_refresh_eligible(entry_json: Option<String>, playable: bool) -> napi::Result<bool> {
    let entry = parse_entry(entry_json)?;
    Ok(core::stale_refresh_eligible(entry.as_ref(), playable))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_devolve_json_do_nucleo() {
        let out = commit_decision(
            json!({
                "playable": true,
                "partial": false,
                "debridKnown": null,
                "needsDebridRefresh": false,
                "hasFallback": false,
                "cacheTtl": 900,
                "fallbackStreamsTtl": 120,
            })
            .to_string(),
        )
        .expect("entrada válida");
        let parsed: Value = serde_json::from_str(&out).expect("saída JSON");
        assert_eq!(parsed["write"], json!(true));
        assert_eq!(parsed["ttl"], json!(900));
        assert_eq!(parsed["debridKnown"], json!(true));
    }

    #[test]
    fn late_copia_debrid_e_respeita_o_ramo() {
        let out = late_promotion_decision(
            json!({
                "hitPartial": true,
                "hitFallback": false,
                "hitHasStreams": false,
                "hitDebridKnown": false,
                "live": { "needsFallback": false, "hasAnyFailure": true },
                "cacheTtl": 900,
            })
            .to_string(),
        )
        .expect("entrada válida");
        let parsed: Value = serde_json::from_str(&out).expect("saída JSON");
        assert_eq!(parsed["action"], json!("none"));
        assert_eq!(parsed["reason"], json!("sem_resposta_dos_indexers"));
        assert_eq!(parsed["debridKnown"], json!(false));
    }

    #[test]
    fn entry_nula_ou_invalida_nao_e_refresh_confiavel() {
        assert!(!debrid_refresh_satisfied(None).expect("sem entrada"));
        assert!(!stale_refresh_eligible(Some("null".into()), true).expect("null"));
        let entry = json!({ "partial": false, "debridKnown": true }).to_string();
        assert!(debrid_refresh_satisfied(Some(entry.clone())).expect("entry"));
        assert!(stale_refresh_eligible(Some(entry), true).expect("entry"));
        assert!(debrid_refresh_satisfied(Some("{".into())).is_err());
        assert!(stale_refresh_eligible(Some("42".into()), false).is_ok());
    }

    #[test]
    fn entrada_invalida_devolve_erro_sem_panico() {
        assert!(commit_decision("{".into()).is_err());
        assert!(late_promotion_decision("\"nao-e-objeto\"".into()).is_err());
        assert!(debrid_refresh_satisfied(Some("\"sem-json\"".into())).is_ok());
        assert!(commit_decision(json!({"playable": "sim"}).to_string()).is_err());
    }
}
