//! Transições puras do ledger RD (`src/debrid/rd-ledger.ts`).
//!
//! O Node continua dono do `cache.db` e do Map do processo. Aqui só entra o
//! estado já lido e sai o próximo valor com o TTL. O kill-switch e os números
//! (`hitTtl`, backoff) chegam prontos: este módulo não lê env nem fala HTTP.
//!
//! Miss nunca condena a release. O backoff só adia a próxima sonda, o `n`
//! continua crescendo e o TTL para no último degrau. `blocked` não é apagado
//! por hit nem por miss — falso negativo é pior que falso positivo.
//!
//! O golden é a saída do dist, gerada por
//! `scripts/rust/debrid-golden/rd-decision.mjs`. A sombra no processo e a
//! chave de integração ficam para depois; aqui não há I/O.

/// Prefixo lógico `rdc:v2:`. A chave não leva apiKey: o CDN é do serviço.
pub const LEDGER_PREFIX: &str = "rdc:v2:";

#[derive(Clone, Debug, PartialEq)]
pub struct LedgerWrite {
    pub s: &'static str,
    pub at: f64,
    pub n: f64,
    pub ttl_seconds: f64,
    /// Hash normalizado. Só miss/blocked devolvem; hit é por hash do chamador.
    pub hash: Option<String>,
}

/// 40 hex depois de lower. Qualquer outra forma é vazia e a leitura é unknown.
pub fn normalize_hash(hash: &str) -> String {
    let value = hash.to_ascii_lowercase();
    if value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
        value
    } else {
        String::new()
    }
}

pub fn ledger_key(hash: &str) -> String {
    format!("{LEDGER_PREFIX}{}", normalize_hash(hash))
}

/// Desligado, ausente ou `s` fora do trio → `unknown`.
pub fn peek_state(enabled: bool, stored_s: Option<&str>) -> &'static str {
    if !enabled {
        return "unknown";
    }
    match stored_s {
        Some("hit") => "hit",
        Some("miss") => "miss",
        Some("blocked") => "blocked",
        _ => "unknown",
    }
}

/// Hit refresca `{s:'hit', n:0}`. Bloqueio legal não é sobrescrito.
pub fn next_on_hit(enabled: bool, hit_ttl: f64, now: f64, current: &str) -> Option<LedgerWrite> {
    if !enabled || hit_ttl <= 0.0 || current == "blocked" {
        return None;
    }
    Some(LedgerWrite {
        s: "hit",
        at: now,
        n: 0.0,
        ttl_seconds: hit_ttl,
        hash: None,
    })
}

/// Miss adia a sonda. `blocked` não cede. Slot 0/NaN não escreve.
pub fn next_on_miss(
    enabled: bool,
    hash: &str,
    backoff_ms: &[f64],
    now: f64,
    current: &str,
    prior_s: Option<&str>,
    prior_n: Option<f64>,
) -> Option<LedgerWrite> {
    let normalized = normalize_hash(hash);
    if !enabled || normalized.is_empty() || backoff_ms.is_empty() || current == "blocked" {
        return None;
    }
    let attempts = if prior_s == Some("miss") {
        match prior_n {
            Some(n) => n + 1.0,
            None => f64::NAN,
        }
    } else {
        1.0
    };
    let ttl_ms = backoff_ttl_ms(backoff_ms, attempts)?;
    Some(LedgerWrite {
        s: "miss",
        at: now,
        n: attempts,
        ttl_seconds: ttl_seconds(ttl_ms),
        hash: Some(normalized),
    })
}

/// Bloqueio cobre hit e miss. TTL não positivo ou hash inválido não escreve.
pub fn next_on_blocked(
    enabled: bool,
    hash: &str,
    blocked_ttl: f64,
    now: f64,
) -> Option<LedgerWrite> {
    let normalized = normalize_hash(hash);
    if !enabled || blocked_ttl <= 0.0 || normalized.is_empty() {
        return None;
    }
    Some(LedgerWrite {
        s: "blocked",
        at: now,
        n: 0.0,
        ttl_seconds: blocked_ttl,
        hash: Some(normalized),
    })
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// Índice no estilo JS: não-inteiro ou negativo não existe (`undefined`).
fn backoff_ttl_ms(backoff: &[f64], attempts: f64) -> Option<f64> {
    if !attempts.is_finite() {
        return None;
    }
    let index = js_min(attempts - 1.0, (backoff.len() as f64) - 1.0);
    if !index.is_finite() || index < 0.0 || index.fract() != 0.0 {
        return None;
    }
    let ttl_ms = *backoff.get(index as usize)?;
    if ttl_ms == 0.0 || ttl_ms.is_nan() {
        return None;
    }
    Some(ttl_ms)
}

fn ttl_seconds(ttl_ms: f64) -> f64 {
    js_max(1.0, (ttl_ms / 1000.0).ceil())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn doc() -> Value {
        serde_json::from_str(include_str!("../tests/golden/debrid_rd_decision.json")).unwrap()
    }

    fn num(v: f64) -> Value {
        if v.is_finite() && v.fract() == 0.0 && v.abs() <= i64::MAX as f64 {
            json!(v as i64)
        } else {
            json!(v)
        }
    }

    fn write_json(write: Option<LedgerWrite>) -> Value {
        match write {
            None => json!({ "write": null }),
            Some(w) => {
                let mut obj = serde_json::Map::new();
                obj.insert("s".into(), json!(w.s));
                obj.insert("at".into(), num(w.at));
                obj.insert("n".into(), num(w.n));
                obj.insert("ttlSeconds".into(), num(w.ttl_seconds));
                if let Some(hash) = w.hash {
                    obj.insert("hash".into(), json!(hash));
                }
                json!({ "write": obj })
            }
        }
    }

    fn f64s(v: &Value) -> Vec<f64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|item| item.as_f64().unwrap())
            .collect()
    }

    fn eval(case: &Value) -> Value {
        let i = &case["input"];
        match case["op"].as_str().unwrap() {
            "normalize_hash" => json!({ "hash": normalize_hash(i["hash"].as_str().unwrap()) }),
            "ledger_key" => json!({ "key": ledger_key(i["hash"].as_str().unwrap()) }),
            "peek_state" => {
                let stored = if i["stored"].is_null() {
                    None
                } else {
                    i["stored"].get("s").and_then(|s| s.as_str())
                };
                json!({ "state": peek_state(i["enabled"].as_bool().unwrap(), stored) })
            }
            "next_on_hit" => write_json(next_on_hit(
                i["enabled"].as_bool().unwrap(),
                i["hitTtl"].as_f64().unwrap(),
                i["now"].as_f64().unwrap(),
                i["current"].as_str().unwrap(),
            )),
            "next_on_miss" => {
                let (prior_s, prior_n) = if i["prior"].is_null() {
                    (None, None)
                } else {
                    (
                        i["prior"].get("s").and_then(|s| s.as_str()),
                        i["prior"].get("n").and_then(|n| n.as_f64()),
                    )
                };
                write_json(next_on_miss(
                    i["enabled"].as_bool().unwrap(),
                    i["hash"].as_str().unwrap(),
                    &f64s(&i["backoffMs"]),
                    i["now"].as_f64().unwrap(),
                    i["current"].as_str().unwrap(),
                    prior_s,
                    prior_n,
                ))
            }
            "next_on_blocked" => write_json(next_on_blocked(
                i["enabled"].as_bool().unwrap(),
                i["hash"].as_str().unwrap(),
                i["blockedTtl"].as_f64().unwrap(),
                i["now"].as_f64().unwrap(),
            )),
            other => panic!("op desconhecida: {other}"),
        }
    }

    #[test]
    fn ledger_matches_dist_oracle() {
        let parsed = doc();
        let cases = parsed["ledger"].as_array().unwrap();
        assert!(cases.len() >= 20, "golden curto demais");
        for case in cases {
            let id = case["id"].as_str().unwrap();
            assert_eq!(eval(case), case["expect"], "{id}");
        }
    }
}
