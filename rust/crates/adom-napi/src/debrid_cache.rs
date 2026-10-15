//! Veredito de cache a partir da resposta que o Node já tem. Sem HTTP.

use napi_derive::napi;

#[napi(object)]
pub struct DebridCacheVerdict {
    pub cached: Vec<String>,
    pub known: bool,
    pub reason: Option<String>,
    pub message: Option<String>,
}

fn verdict_of(verdict: adom_core::CacheVerdict) -> DebridCacheVerdict {
    let (reason, message) = match verdict.unusable {
        Some(unusable) => (
            Some(unusable.reason.as_str().to_string()),
            Some(unusable.message),
        ),
        None => (None, None),
    };
    DebridCacheVerdict {
        cached: verdict.cached,
        known: verdict.known,
        reason,
        message,
    }
}

/// `complete` ausente (`None`) é o `!== false` do TS. `failure` preenchido
/// classifica o erro já separado pelo Node (auth/quota/rate/falha).
#[napi(catch_unwind)]
pub fn debrid_cache_verdict(
    form: String,
    cached: Vec<String>,
    complete: Option<bool>,
    failure: Option<String>,
    message: Option<String>,
) -> DebridCacheVerdict {
    let verdict = if let Some(failure) = failure {
        adom_core::failure_verdict(&failure, message.as_deref().unwrap_or(""))
    } else if form == "set" {
        adom_core::normalize_cache_result(adom_core::CacheAnswer::Set(cached))
    } else {
        adom_core::normalize_cache_result(adom_core::CacheAnswer::Record { cached, complete })
    };
    verdict_of(verdict)
}

/// Boolean exportado do adaptador. Não lê a conta.
#[napi(catch_unwind)]
pub fn debrid_cache_check_honest(service: String) -> bool {
    adom_core::cache_check_honest(&service)
}
