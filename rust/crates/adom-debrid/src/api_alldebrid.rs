//! Play da AllDebrid na rota interna `/debrid/link`.
//!
//! Checagem, conta e `/debrid/files` continuam 501. Sem log de chave ou magnet.
//! A resposta leva os efeitos que o TS grava no próprio processo e que o Node
//! aplica: `unavailable` (davail=0 do frio) e `files` (prova de áudio,
//! resolução e tamanho).

use std::time::Duration;

use adom_core::PlayHint;
use axum::response::Response;
use serde_json::{json, Value};

use super::{adapter_error, AppState, RequestBody};
use crate::alldebrid::{AllDebrid, PlayError, PlayFile, PlayResult, ResolveOpts};
use crate::http::HttpClient;

const POLL_WAIT: Duration = Duration::from_millis(700);

/// `held` ausente protege. `drop_uncached_env` segue `DEBRID_DROP_UNCACHED`.
pub fn resolve_opts(held: Option<bool>, drop_uncached_env: Option<&str>) -> ResolveOpts {
    ResolveOpts {
        poll_wait: POLL_WAIT,
        drop_uncached: drop_uncached(drop_uncached_env),
        // Sem o campo, apagar um frio destruiria o download que o Node segura.
        held: held.unwrap_or(true),
    }
}

/// Igual ao TS: `String(env || 'true') === 'true'`. Vazio fica ligado; `"false"` desliga.
fn drop_uncached(raw: Option<&str>) -> bool {
    let value = raw.filter(|value| !value.is_empty()).unwrap_or("true");
    value == "true"
}

pub(super) async fn resolve_link(
    client: HttpClient,
    body: &RequestBody,
    hint: &PlayHint,
) -> Result<PlayResult, PlayError> {
    let env = std::env::var("DEBRID_DROP_UNCACHED").ok();
    let opts = resolve_opts(body.held, env.as_deref());
    AllDebrid::new(client)
        .resolve_link(&body.api_key, &body.hash, hint, &opts)
        .await
}

/// `POST /debrid/link` da AllDebrid: o mesmo `{url}` dos outros serviços mais
/// os efeitos. Erro de play segue o JSON comum, com `files` quando o TS já
/// teria gravado a prova (mentira de dublagem).
pub(super) async fn link(
    state: &AppState,
    body: &RequestBody,
    client: HttpClient,
    hint: &PlayHint,
) -> Response {
    match resolve_link(client, body, hint).await {
        Ok(played) => super::json_status(axum::http::StatusCode::OK, played_json(&played)),
        Err(PlayError { error, files }) => {
            let response = adapter_error(state, &body.service, &body.api_key, error);
            match files {
                Some(files) => with_files(response, &files).await,
                None => response,
            }
        }
    }
}

pub(super) fn played_json(played: &PlayResult) -> Value {
    let mut out = json!({ "url": played.url, "unavailable": played.unavailable });
    if let (Some(files), Some(map)) = (&played.files, out.as_object_mut()) {
        map.insert("files".into(), files_json(files));
    }
    out
}

fn files_json(files: &[PlayFile]) -> Value {
    Value::Array(
        files
            .iter()
            .map(|file| json!({ "path": file.path, "size": file.size }))
            .collect(),
    )
}

/// Acrescenta `files` ao JSON de erro já montado, mantendo status e corpo.
async fn with_files(response: Response, files: &[PlayFile]) -> Response {
    let (parts, body) = response.into_parts();
    let Ok(bytes) = axum::body::to_bytes(body, usize::MAX).await else {
        return Response::from_parts(parts, axum::body::Body::empty());
    };
    let mut value: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({}));
    if let Some(map) = value.as_object_mut() {
        map.insert("files".into(), files_json(files));
    }
    super::json_status(parts.status, value)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use serde_json::{json, Value};

    use super::{played_json, resolve_opts, with_files};
    use crate::alldebrid::{PlayFile, PlayResult};

    fn file(path: &str, size: f64) -> PlayFile {
        PlayFile {
            path: path.into(),
            size,
        }
    }

    #[test]
    fn json_do_play_leva_os_efeitos_que_o_node_aplica() {
        let ready = PlayResult {
            url: Some("https://cdn.test/a".into()),
            unavailable: false,
            files: Some(vec![file("A/a.mkv", 10.0)]),
        };
        assert_eq!(
            played_json(&ready),
            json!({"url": "https://cdn.test/a", "unavailable": false,
                   "files": [{"path": "A/a.mkv", "size": 10.0}]})
        );
        let cold = PlayResult {
            unavailable: true,
            ..PlayResult::default()
        };
        assert_eq!(
            played_json(&cold),
            json!({"url": null, "unavailable": true})
        );
    }

    #[tokio::test]
    async fn erro_com_lista_mantem_status_e_corpo() {
        let base = (
            StatusCode::NOT_ACCEPTABLE,
            axum::Json(json!({"error": "dub_lie", "kind": "dub_lie"})),
        )
            .into_response();
        let out = with_files(base, &[file("x.mkv", 1.0)]).await;
        assert_eq!(out.status(), StatusCode::NOT_ACCEPTABLE);
        let bytes = axum::body::to_bytes(out.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["kind"], "dub_lie");
        assert_eq!(body["files"][0]["path"], "x.mkv");
    }

    #[test]
    fn resolve_opts_ausente_protege_false_nao_e_env_false_nao_derruba() {
        let absent = resolve_opts(None, None);
        assert!(absent.held);
        assert!(absent.drop_uncached);
        assert_eq!(absent.poll_wait, Duration::from_millis(700));

        let told = resolve_opts(Some(true), None);
        assert!(told.held);
        assert!(told.drop_uncached);

        let open = resolve_opts(Some(false), None);
        assert!(!open.held);
        assert!(open.drop_uncached);

        // held false autorizaria o apagamento; a env é que segura o frio.
        let spared = resolve_opts(Some(false), Some("false"));
        assert!(!spared.held);
        assert!(!spared.drop_uncached);
    }
}
