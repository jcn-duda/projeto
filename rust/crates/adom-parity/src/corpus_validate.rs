use serde_json::Value;

use super::{CaseMeta, CaseRequest, Diagnostic, DiagnosticLevel, Manifest, RecordedResponse};

pub(crate) fn validate_case(
    meta: &CaseMeta,
    request: &CaseRequest,
    response: &RecordedResponse,
    manifest: &Manifest,
    diagnostics: &mut Vec<Diagnostic>,
) {
    let case_id = Some(meta.id.as_str());
    if request.method != "GET" {
        diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            format!("request.method={:?}; esperado GET", request.method),
        ));
    }
    if request.path.is_empty() || !request.path.contains("/stream/") {
        diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Error,
            case_id,
            format!("request.path sem /stream/: {:?}", request.path),
        ));
    }
    if request.user_config_sha256.is_some()
        && manifest.user_config_sha256.is_some()
        && request.user_config_sha256 != manifest.user_config_sha256
    {
        diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            "request.user_config_sha256 difere do manifest (caso de outra instalação?)",
        ));
    }

    if response.status.is_none() {
        diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            "response.status ausente",
        ));
    }
    if let (Some(expected), Some(actual)) = (meta.status, response.status) {
        if expected != actual {
            diagnostics.push(Diagnostic::new(
                DiagnosticLevel::Error,
                case_id,
                format!("response.status={actual} difere do manifest ({expected})"),
            ));
        }
    }
    if let (Some(expected), Some(actual)) = (meta.cache_max_age, response.cache_max_age) {
        if expected != actual {
            diagnostics.push(Diagnostic::new(
                DiagnosticLevel::Error,
                case_id,
                format!("response.cacheMaxAge={actual} difere do manifest ({expected})"),
            ));
        }
    }
    match (&response.body, &response.body_raw) {
        (None, None) => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Error,
            case_id,
            "response sem body nem body_raw",
        )),
        (Some(_), Some(_)) => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            "response traz body e body_raw ao mesmo tempo",
        )),
        _ => {}
    }
    if let Some(body) = &response.body {
        validate_body(meta, body, diagnostics);
    }
}

fn validate_body(meta: &CaseMeta, body: &Value, diagnostics: &mut Vec<Diagnostic>) {
    let case_id = Some(meta.id.as_str());
    let Some(object) = body.as_object() else {
        diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Error,
            case_id,
            "body não é objeto JSON",
        ));
        return;
    };
    match object.get("streams") {
        None => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            "body.streams ausente",
        )),
        Some(Value::Array(_)) => {}
        Some(_) => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Error,
            case_id,
            "body.streams não é array",
        )),
    }
    match object.get("cacheMaxAge") {
        None => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Warning,
            case_id,
            "body.cacheMaxAge ausente",
        )),
        Some(Value::Number(number)) => {
            if number.as_u64().is_none() {
                diagnostics.push(Diagnostic::new(
                    DiagnosticLevel::Warning,
                    case_id,
                    "body.cacheMaxAge não é inteiro não-negativo",
                ));
            } else if let (Some(expected), Some(actual)) = (
                meta.cache_max_age,
                number.as_u64().and_then(|n| u32::try_from(n).ok()),
            ) {
                if expected != actual {
                    diagnostics.push(Diagnostic::new(
                        DiagnosticLevel::Error,
                        case_id,
                        format!("body.cacheMaxAge={actual} difere do manifest ({expected})"),
                    ));
                }
            }
        }
        Some(_) => diagnostics.push(Diagnostic::new(
            DiagnosticLevel::Error,
            case_id,
            "body.cacheMaxAge não é número",
        )),
    }
}
