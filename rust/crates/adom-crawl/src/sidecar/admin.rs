//! Rotas administrativas do crawl no sidecar (`/crawl/*`).
//!
//! Porta para o sidecar as três operações que o painel ainda pedia ao Node:
//! devolver à fila o que o passe SECO do dry-run deixou (`requeue-simulated`),
//! reprocessar as páginas `no-work` (`reprocess-no-work`) e ler/gravar o cursor
//! de descoberta (`cursor`). O efeito durável é o MESMO do TS
//! (`src/providers/crawl-recovery.ts`, `crawl-actions.ts`,
//! `crawl-cursor-load.ts`): a SQL mora em [`crate::store::admin_ops`] e o
//! cursor nas MESMAS chaves do `crawl_state` (`cursor:movie`,
//! `cursor:tv_show` e o legado `cursor`).
//!
//! As duas rotas de reenfileiramento recebem `{ "site": "<id>" }` — o corpo que
//! o painel já manda ao `/dashboard-action.json`. `site` é OBRIGATÓRIO: o
//! sidecar não tem "primeiro site configurado" (quem sabe o site ativo é o
//! Node) e um alvo arbitrário tocaria a fila de um site que o operador não
//! ligou. Site fora do registry responde 400, nunca "0 URL(s)" em HTTP 200.
//!
//! Segurança: as mesmas regras de [`super::server`] — escuta em loopback,
//! token no header `X-Indexer-Test-Token` e limite de corpo padrão do axum
//! (2 MB). Corpo inválido é 400, inclusive campo com tipo errado (o `Json` do
//! axum responderia 422; [`bad_request`] normaliza).

use std::sync::Arc;

use axum::{
    extract::{rejection::JsonRejection, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use super::server::{validate_token, AppState};
use crate::store::{
    CrawlStore, RequeueReport, StoreError, CURSOR_MOVIE_KEY, CURSOR_TV_SHOW_KEY, LEGACY_CURSOR_KEY,
};

/// Ação do painel atendida pela rota `requeue-simulated` (volta na resposta).
const ACTION_REQUEUE_SIMULATED: &str = "crawl-requeue-simulated";
/// Ação do painel atendida pela rota `reprocess-no-work`.
const ACTION_REPROCESS_NO_WORK: &str = "crawl-reprocess-no-work";

/// Corpo de `POST /crawl/requeue-simulated` e `POST /crawl/reprocess-no-work`.
#[derive(Debug, Deserialize)]
pub(super) struct RequeueRequest {
    #[serde(default)]
    site: String,
}

/// Resposta do reenfileiramento: contagem + amostra das chaves tocadas.
#[derive(Debug, Serialize)]
struct RequeueResponse {
    ok: bool,
    action: &'static str,
    site: String,
    requeued: u32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Query de `GET /crawl/cursor`.
#[derive(Debug, Deserialize)]
pub(super) struct CursorQuery {
    #[serde(default)]
    site: String,
}

/// Corpo de `POST /crawl/cursor` — patch: campo ausente não é tocado.
#[derive(Debug, Deserialize)]
pub(super) struct CursorPatch {
    #[serde(default)]
    site: String,
    #[serde(default)]
    movie: Option<String>,
    #[serde(default)]
    tv_show: Option<String>,
}

/// Estado do cursor devolvido por GET e POST (lido do banco depois da escrita).
#[derive(Debug, Serialize)]
struct CursorResponse {
    ok: bool,
    site: String,
    movie: String,
    tv_show: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Operação de reenfileiramento do store (mesma assinatura das duas).
type RequeueOp = fn(&CrawlStore, &str) -> Result<RequeueReport, StoreError>;

// ─── Requisitos de painel ───────────────────────────────────────────────────

/// `POST /crawl/requeue-simulated` — devolve à fila o que o dry-run deixou.
pub(super) async fn requeue_simulated(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<RequeueRequest>, JsonRejection>,
) -> Response {
    run_requeue(
        &state,
        &headers,
        payload,
        ACTION_REQUEUE_SIMULATED,
        CrawlStore::requeue_simulated,
    )
    .await
}

/// `POST /crawl/reprocess-no-work` — só as `no-work` voltam à fila.
pub(super) async fn reprocess_no_work(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<RequeueRequest>, JsonRejection>,
) -> Response {
    run_requeue(
        &state,
        &headers,
        payload,
        ACTION_REPROCESS_NO_WORK,
        CrawlStore::requeue_no_work,
    )
    .await
}

/// Caminho comum das duas rotas: token → corpo → site → store.
async fn run_requeue(
    state: &AppState,
    headers: &HeaderMap,
    payload: Result<Json<RequeueRequest>, JsonRejection>,
    action: &'static str,
    op: RequeueOp,
) -> Response {
    if let Err(resp) = validate_token(&state.auth_token, headers) {
        return resp;
    }
    let body = match payload {
        Ok(Json(body)) => body,
        Err(rejection) => return bad_request(Some(action), "", &rejection.body_text()),
    };
    let site = match site_from_request(&body.site, Some(action)) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let store = state.store.lock().await;
    match op(&store, &site) {
        Ok(report) => (
            StatusCode::OK,
            Json(RequeueResponse {
                ok: true,
                action,
                site,
                requeued: report.requeued,
                ids: report.ids,
                error: None,
            }),
        )
            .into_response(),
        Err(e) => server_error(Some(action), &site, &e.to_string()),
    }
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

/// `GET /crawl/cursor?site=<id>` — cursor por kind, como o card do painel lê.
pub(super) async fn cursor_get(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<CursorQuery>,
) -> Response {
    if let Err(resp) = validate_token(&state.auth_token, &headers) {
        return resp;
    }
    let site = match site_from_request(&query.site, None) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let store = state.store.lock().await;
    match cursor_view(&store, &site) {
        Ok((movie, tv_show)) => cursor_ok(site, movie, tv_show),
        Err(e) => server_error(None, &site, &e.to_string()),
    }
}

/// `POST /crawl/cursor` — grava `movie`/`tv_show` e devolve o estado durável.
///
/// Campo ausente NÃO é tocado; `""` limpa a chave nova. O legado (`cursor`) é
/// só leitura aqui, como no TS: quem o apaga é o "Zerar site".
pub(super) async fn cursor_set(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    payload: Result<Json<CursorPatch>, JsonRejection>,
) -> Response {
    if let Err(resp) = validate_token(&state.auth_token, &headers) {
        return resp;
    }
    let body = match payload {
        Ok(Json(body)) => body,
        Err(rejection) => return bad_request(None, "", &rejection.body_text()),
    };
    let site = match site_from_request(&body.site, None) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    if body.movie.is_none() && body.tv_show.is_none() {
        return bad_request(None, &site, "nada a gravar (movie/tv_show ausentes)");
    }
    let store = state.store.lock().await;
    match save_cursor(&store, &site, &body) {
        Ok((movie, tv_show)) => cursor_ok(site, movie, tv_show),
        Err(e) => server_error(None, &site, &e.to_string()),
    }
}

/// Grava o patch e devolve a vista resultante: a resposta é o estado DURÁVEL.
fn save_cursor(
    store: &CrawlStore,
    site: &str,
    patch: &CursorPatch,
) -> Result<(String, String), StoreError> {
    if let Some(movie) = &patch.movie {
        store.set_state(site, CURSOR_MOVIE_KEY, movie)?;
    }
    if let Some(tv_show) = &patch.tv_show {
        store.set_state(site, CURSOR_TV_SHOW_KEY, tv_show)?;
    }
    cursor_view(store, site)
}

/// Cursor por kind como o painel lê (`cursorsView` do TS): `cursor:movie` vence
/// e, vazio, cai no cursor LEGADO da Fase 6. Leitura quieta — não migra nem
/// escreve (a migração é da carga do motor).
fn cursor_view(store: &CrawlStore, site: &str) -> Result<(String, String), StoreError> {
    let movie = non_empty(store.get_state(site, CURSOR_MOVIE_KEY)?)
        .or(non_empty(store.get_state(site, LEGACY_CURSOR_KEY)?))
        .unwrap_or_default();
    let tv_show = non_empty(store.get_state(site, CURSOR_TV_SHOW_KEY)?).unwrap_or_default();
    Ok((movie, tv_show))
}

/// `None` e `""` são a MESMA coisa para o cursor: "nunca leu".
fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Id do site do pedido, validado contra o registry do raspador.
///
/// O registry inclui o TorrentGalaxy (perfil de resolver, sem fila de crawl):
/// aceitar um id a mais é inofensivo (0 linhas); recusar um site de verdade por
/// lista desatualizada é que seria erro.
#[allow(clippy::result_large_err)] // Response contém Body; é o contrato do axum handler
fn site_from_request(raw: &str, action: Option<&str>) -> Result<String, Response> {
    let site = raw.trim();
    if site.is_empty() {
        return Err(bad_request(action, "", "site obrigatório"));
    }
    if !crate::site_profiles::all_site_ids().contains(&site) {
        return Err(bad_request(
            action,
            site,
            &format!("site desconhecido: {site}"),
        ));
    }
    Ok(site.to_string())
}

fn cursor_ok(site: String, movie: String, tv_show: String) -> Response {
    (
        StatusCode::OK,
        Json(CursorResponse {
            ok: true,
            site,
            movie,
            tv_show,
            error: None,
        }),
    )
        .into_response()
}

fn bad_request(action: Option<&str>, site: &str, message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(error_body(action, site, message)),
    )
        .into_response()
}

fn server_error(action: Option<&str>, site: &str, message: &str) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(error_body(action, site, message)),
    )
        .into_response()
}

/// Envelope de erro no espírito do `/action`: `ok:false` + `error`, com
/// `action`/`site` quando fizerem sentido.
fn error_body(action: Option<&str>, site: &str, message: &str) -> serde_json::Value {
    let mut body = serde_json::json!({ "ok": false, "error": message });
    if let Some(action) = action {
        body["action"] = serde_json::Value::String(action.to_string());
    }
    if !site.is_empty() {
        body["site"] = serde_json::Value::String(site.to_string());
    }
    body
}
