//! Erro do fetch de página — saiu do `page_engine.rs` pela catraca de 400
//! linhas. Separa falha comum de ADIÁVEL (Fase 0 do 429): fala `String`
//! (descoberta e `page_engine_vaca`, com `?`) e `PageOutcome` (o loop).

use crate::motor::site_clock::retry_after_capped;
use crate::motor::types::PageOutcome;

/// Erro do fetch de página: separa falha comum de ADIÁVEL (Fase 0 do 429).
/// Fala `String` (descoberta e `page_engine_vaca`, com `?`) e `PageOutcome`.
pub(crate) enum FetchError {
    /// Falha comum: rede, layout, status sem relevância ao ritmo.
    Msg(String),
    /// 429/503: o site pediu espera — prazo já com piso e teto.
    Deferred { retry_after_ms: u64, label: String },
}

impl From<FetchError> for String {
    fn from(e: FetchError) -> Self {
        match e {
            FetchError::Msg(m) => m,
            // Rótulo EXATO = contrato do store e dos contadores do painel.
            FetchError::Deferred { label, .. } => label,
        }
    }
}

impl From<FetchError> for PageOutcome {
    fn from(e: FetchError) -> Self {
        match e {
            FetchError::Msg(m) => PageOutcome::Failed(m),
            FetchError::Deferred {
                retry_after_ms,
                label,
            } => PageOutcome::Deferred {
                retry_after_ms,
                label,
            },
        }
    }
}

/// Falha que chegou como `String` (cadeia do Vaca, saltos internos com `?`)
/// volta a ser adiável pelo rótulo exato: sem isto o 429 no meio da cadeia
/// virava falha comum, gastava `tries` e não segurava o site.
pub(crate) fn outcome_of_message(msg: String) -> PageOutcome {
    match msg.as_str() {
        "http_429" => fetch_error_of(429, None).into(),
        "http_503" => fetch_error_of(503, None).into(),
        _ => PageOutcome::Failed(msg),
    }
}

/// Não-2xx → erro tipado: 429/503 ADIÁVEIS; demais ficam `http_{status}`.
pub(crate) fn fetch_error_of(status: u16, raw_retry_after: Option<u64>) -> FetchError {
    match status {
        429 | 503 => FetchError::Deferred {
            retry_after_ms: retry_after_capped(raw_retry_after),
            label: format!("http_{status}"),
        },
        _ => FetchError::Msg(format!("http_{status}")),
    }
}
