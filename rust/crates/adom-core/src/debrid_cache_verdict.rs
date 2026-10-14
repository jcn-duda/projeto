//! Veredito puro da checagem de cache.
//!
//! Espelha a decisão de `src/debrid/cache-check.ts`: resposta já obtida
//! (Set ou `{ cached, complete }`) e erro já classificado viram
//! `{ cached, known, unusable? }`. HTTP, `dropUncached`, cache, magnetdb,
//! métricas e notify ficam no Node — este módulo não os chama.
//!
//! `known: false` não significa "nada em cache". Os hashes que a resposta
//! nomeou continuam em `cached`; o que não veio simplesmente não foi
//! perguntado. Rate limit é transitório e não entra em `unusable`.

/// Motivo que só o usuário conserta. Rate limit não é um destes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnusableReason {
    Auth,
    Quota,
}

impl UnusableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Quota => "quota",
        }
    }

    /// Só `auth` e `quota`. `rate` e `falha` não são unusable.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auth" => Some(Self::Auth),
            "quota" => Some(Self::Quota),
            _ => None,
        }
    }
}

/// Marca gravada no veredito. `message` já veio extraída; não há log nem notify.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unusable {
    pub reason: UnusableReason,
    pub message: String,
}

/// Resultado da decisão. `unusable` ausente quando o serviço só não respondeu
/// (ou pediu para esperar): a lista segue, sem ⚡, e o passe tardio pode repetir.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CacheVerdict {
    pub cached: Vec<String>,
    pub known: bool,
    pub unusable: Option<Unusable>,
}

/// Resposta já obtida do adaptador, no formato de `normalizeCacheResult`.
pub enum CacheAnswer {
    /// Set puro: a lista fechou. `known` é true mesmo vazia.
    Set(Vec<String>),
    /// Objeto. `complete == Some(false)` é o único "não sei"
    /// (`complete !== false` no TS). Ausente e `null` contam como fechado.
    Record {
        cached: Vec<String>,
        complete: Option<bool>,
    },
}

/// Copia o Set do JS: primeira ocorrência, ordem de inserção, sem lower-case.
fn unique_in_order(hashes: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(hashes.len());
    for hash in hashes {
        if seen.insert(hash.clone()) {
            out.push(hash);
        }
    }
    out
}

fn unknown() -> CacheVerdict {
    CacheVerdict {
        cached: Vec::new(),
        known: false,
        unusable: None,
    }
}

/// `normalizeCacheResult` sem o log. Set → known true. Objeto → known é
/// `complete !== false`. Hashes do lote incompleto voltam do mesmo jeito:
/// não provam que o resto está fora do cache.
pub fn normalize_cache_result(answer: CacheAnswer) -> CacheVerdict {
    let (cached, known) = match answer {
        CacheAnswer::Set(cached) => (cached, true),
        CacheAnswer::Record { cached, complete } => (cached, complete != Some(false)),
    };
    CacheVerdict {
        cached: unique_in_order(cached),
        known,
        unusable: None,
    }
}

/// `unusableReason`. `is_auth` / `is_quota` são o retorno de `isAuthError` /
/// `isQuotaError` — o short-circuit do rate limit já aconteceu dentro de
/// `isQuotaError`. Auth ganha de quota.
pub fn unusable_reason(is_auth: bool, is_quota: bool) -> Option<UnusableReason> {
    if is_auth {
        Some(UnusableReason::Auth)
    } else if is_quota {
        Some(UnusableReason::Quota)
    } else {
        None
    }
}

/// Retorno de `unusable()` sem métrica, log nem notify. Cached vazio e
/// `known: false`: a conta não vai resolver, a lista volta como P2P.
pub fn unusable_verdict(reason: UnusableReason, message: &str) -> CacheVerdict {
    CacheVerdict {
        cached: Vec::new(),
        known: false,
        unusable: Some(Unusable {
            reason,
            message: message.to_string(),
        }),
    }
}

/// `failureReason`. Rate não é unusable: cai em `"rate"`, não em auth/quota.
/// O resto que não é auth nem quota é `"falha"`.
pub fn failure_reason(is_auth: bool, is_quota: bool, is_rate: bool) -> &'static str {
    if let Some(reason) = unusable_reason(is_auth, is_quota) {
        reason.as_str()
    } else if is_rate {
        "rate"
    } else {
        "falha"
    }
}

/// Erro já classificado (`failure_reason`) → veredito. `"rate"` e `"falha"`
/// devolvem known false sem `unusable` — o mesmo objeto, o diagnóstico é que
/// muda. Só auth e quota carregam a marca.
pub fn failure_verdict(failure: &str, message: &str) -> CacheVerdict {
    match UnusableReason::parse(failure) {
        Some(reason) => unusable_verdict(reason, message),
        None => unknown(),
    }
}

/// Boolean EXPORTADO do adaptador, não o clone dinâmico do registry.
/// Premiumize, TorBox e AllDebrid declaram `cacheCheck = true`. Debrid-Link
/// e o `realdebrid-core` declaram `false` — o dinamismo do Real-Debrid é
/// ledger + oráculo, e não este flag. Serviço desconhecido também é false.
pub fn cache_check_honest(service: &str) -> bool {
    matches!(service, "premiumize" | "torbox" | "alldebrid")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn hashes(value: &Value) -> Vec<String> {
        value
            .as_array()
            .unwrap_or_else(|| panic!("cached não é lista: {value}"))
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| panic!("hash não é string: {item}"))
                    .to_string()
            })
            .collect()
    }

    fn verdict_json(verdict: &CacheVerdict) -> Value {
        let mut map = serde_json::Map::new();
        map.insert(
            "cached".to_string(),
            Value::Array(verdict.cached.iter().cloned().map(Value::String).collect()),
        );
        map.insert("known".to_string(), Value::Bool(verdict.known));
        if let Some(unusable) = &verdict.unusable {
            map.insert(
                "unusable".to_string(),
                serde_json::json!({
                    "reason": unusable.reason.as_str(),
                    "message": unusable.message,
                }),
            );
        }
        Value::Object(map)
    }

    fn flag(input: &Value, key: &str) -> bool {
        input
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or_else(|| panic!("{key} ausente"))
    }

    #[test]
    fn debrid_cache_verdict_golden() {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/golden/debrid_cache_verdict.json");
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("golden {}: {err}", path.display()));
        let doc: Value = serde_json::from_str(&raw).expect("golden json");
        let cases = doc.get("cases").and_then(Value::as_array).expect("cases");
        assert!(!cases.is_empty());

        for case in cases {
            let id = case.get("id").and_then(Value::as_str).expect("id");
            let op = case.get("op").and_then(Value::as_str).expect("op");
            let input = case.get("input").expect("input");
            let expect = case.get("expect").expect("expect");
            match op {
                "normalize" => {
                    let cached = hashes(input.get("cached").expect("cached"));
                    let answer = match input.get("form").and_then(Value::as_str) {
                        Some("set") => CacheAnswer::Set(cached),
                        Some("object") => {
                            // Só o booleano false é incompleto. null e ausência
                            // são `!== false` no TS.
                            let complete = match input.get("complete") {
                                None | Some(Value::Null) => None,
                                Some(Value::Bool(value)) => Some(*value),
                                other => panic!("{id}: complete {other:?}"),
                            };
                            CacheAnswer::Record { cached, complete }
                        }
                        other => panic!("{id}: form {other:?}"),
                    };
                    let got = verdict_json(&normalize_cache_result(answer));
                    assert_eq!(got, *expect, "{id}");
                }
                "failure" => {
                    let is_auth = flag(input, "isAuthError");
                    let is_quota = flag(input, "isQuotaError");
                    let is_rate = flag(input, "isRateLimitError");
                    let message = input
                        .get("message")
                        .and_then(Value::as_str)
                        .expect("message");
                    let got_reason = unusable_reason(is_auth, is_quota).map(UnusableReason::as_str);
                    let expect_reason = match expect.get("unusableReason") {
                        Some(Value::Null) => None,
                        Some(Value::String(value)) => Some(value.as_str()),
                        other => panic!("{id}: unusableReason {other:?}"),
                    };
                    assert_eq!(got_reason, expect_reason, "{id} unusableReason");
                    let got_failure = failure_reason(is_auth, is_quota, is_rate);
                    let expect_failure = expect
                        .get("failureReason")
                        .and_then(Value::as_str)
                        .expect("failureReason");
                    assert_eq!(got_failure, expect_failure, "{id} failureReason");
                    let got_verdict = verdict_json(&failure_verdict(got_failure, message));
                    assert_eq!(
                        &got_verdict,
                        expect.get("verdict").expect("verdict"),
                        "{id} verdict"
                    );
                }
                "honest" => {
                    let service = input
                        .get("service")
                        .and_then(Value::as_str)
                        .expect("service");
                    let expect_flag = expect.as_bool().expect("cacheCheck bool");
                    assert_eq!(cache_check_honest(service), expect_flag, "{id}");
                }
                other => panic!("{id}: op {other}"),
            }
        }
    }
}
