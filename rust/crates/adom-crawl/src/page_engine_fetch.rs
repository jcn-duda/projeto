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
