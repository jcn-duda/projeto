//! API ADMINISTRATIVA do store nativo de `streams:v21` (loopback + token).
//!
//! O SWR do corte mora em `data/streams.db` (processo do gateway). Quem precisa
//! MEXER nele é o Node: `/resolve` invalida a obra quando o play prova
//! `NoVideoError`/`DubLieError`/`EpisodePickError`/451, o painel limpa o cache
//! no `clear-cache`, e o `/stream-trace.json` lê o ledger (dívida F4.4a do corte).
//!
//! Ela NÃO é pública: escuta só em loopback (`STREAM_STORE_ADMIN_LISTEN`,
//! default `127.0.0.1:8711`), exige `X-Indexer-Test-Token` e nunca é montada no
//! roteador da 7000 (o gateway recusa `/internal/*` antes do proxy). Sem token
//! configurado responde 503 — mesmo contrato da API interna de debrid.
//!
//! DUAS credenciais: o token daqui abre a superfície, mas o que APAGA exige
//! ainda o `destructive_token` (`STREAM_STORE_ADMIN_TOKEN`/`DEBRID_INTERNAL_TOKEN`),
//! nunca o de diagnóstico: `POST /sweeps/run` e `POST /streams/clear` recusam
//! sem ele (`409 streams_requires_admin_token`/`403 streams_token_insufficient`)
//! e só depois olham o `{"confirm":true}`.
//!
//! Rotas:
//!
//! | rota | efeito |
//! |---|---|
//! | `POST /streams/invalidate` `{"imdbId":"tt…"}` | apaga as chaves da obra (`invalidateStreamsForObra`) — token da superfície |
//! | `POST /streams/invalidate` `{"hash":"<40hex>"}` | apaga as entradas que mencionam o hash — token da superfície |
//! | `POST /streams/clear` `{}` | limpa o namespace todo (`clear-cache` global) — DESTRUTIVA + `confirm` |
//! | `POST /streams/clear` `{"suffix":":…"}` | limpa só um escopo (instalação) — DESTRUTIVA + `confirm` |
//! | `GET /streams/trace?type=&id=[&key=]` | ledger da obra (o `/stream-trace.json`) + recompute nativo quando `found` sem ledger |
//! | `GET /streams/stats` | ocupação/cota + contadores do cache no usuário (`hit`, `staleServed`, `miss`, `writes`, `hitRate`) |
//! | `GET /harvest` + `POST /harvest/{enqueue,pause,drain,clear}` | painel e controle do colhedor (`crate::harvest`) |
//! | `GET /sweeps` | status do agendador de varreduras AllDebrid (só memória) |
//! | `POST /sweeps/run` `{"kind":"sweepDead"}` | varredura manual de UM tipo (`crate::al_sweeps`) |
//! | `GET /rd-warm` + `POST /rd-warm/pause|resume|drain` | fila, pausa e dreno do warmer RD (`crate::rd_warmer`) |
//!
//! O colhedor nativo monta as rotas `/harvest*` neste MESMO roteador —
//! loopback e token são os mesmos, sem segundo servidor. Sem colhedor
//! (`harvest: None`) o contrato continua valendo com `enabled:false`.
//!
//! A superfície sobe SEMPRE que o corte nativo está de pé: não há rollback por
//! env. Desligá-la exigiria o Node voltar a ser o dono único de invalidação e o
//! gateway a não injetar `bad`/`lie` — o que é imagem/commit anterior, não flag.

use std::{net::SocketAddr, sync::Arc};

use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};

use adom_search::orchestrator::stream_cache_metrics;
use adom_store::StreamsStore;

use crate::{al_sweeps::SweepAdmin, autofetch::AutofetchHandle, harvest::HarvestHandle};

#[path = "store_admin_util.rs"]
mod util;
// Reexportada: `auth` e a rota DESTRUTIVA comparam tokens pela MESMA função.
pub(crate) use util::tokens_match;
// Handler do ledger (+ recompute nativo da dívida 4.2(b)): veio para cá pela
// catraca e para amarrar o `crate::stream::trace_recompute` num módulo só.
#[path = "trace_recompute_handler.rs"]
mod trace_handler;
// Catálogo durável da conta do operador (`/account-catalog/*`): rotas e guardas próprias.
#[path = "account_catalog.rs"]
mod account_catalog;

/// Env do endpoint interno. O Node lê a MESMA env (`src/config/stream-store.ts`).
pub const LISTEN_ENV: &str = "STREAM_STORE_ADMIN_LISTEN";
/// Token próprio; cai para `DEBRID_INTERNAL_TOKEN` e `JACKETT_TEST_TOKEN`.
pub const TOKEN_ENV: &str = "STREAM_STORE_ADMIN_TOKEN";

pub const DEFAULT_LISTEN: &str = "127.0.0.1:8711";

/// Config da API administrativa.
#[derive(Clone, Debug)]
pub struct AdminConfig {
    pub listen: SocketAddr,
    pub token: String,
    /// Segunda credencial, só para as rotas destrutivas; `None` = não configurada.
    pub destructive_token: Option<String>,
}

/// Endereço + token. A superfície sobe sempre; só `Err` (endereço inválido ou
/// fora de loopback) impede o bind.
pub fn config_from_env() -> Result<AdminConfig, String> {
    let listen = std::env::var(LISTEN_ENV)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let addr: SocketAddr = listen
        .parse()
        .map_err(|_| format!("{LISTEN_ENV} invalido: {listen}"))?;
    if !addr.ip().is_loopback() {
        return Err(format!("API do streams.db só escuta em loopback: {listen}"));
    }
    let token = token_from_env();
    Ok(AdminConfig {
        listen: addr,
        token,
        destructive_token: destructive_token_from_env(),
    })
}

/// `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN` → `JACKETT_TEST_TOKEN`.
/// A ordem é a mesma que o Node usa para achar o token do outro lado.
pub fn token_from_env() -> String {
    for key in [TOKEN_ENV, "DEBRID_INTERNAL_TOKEN", "JACKETT_TEST_TOKEN"] {
        let Ok(value) = std::env::var(key) else {
            continue;
        };
        let value = value.trim().to_string();
        if !value.is_empty() {
            return value;
        }
    }
    String::new()
}

/// Token DESTRUTIVO: `STREAM_STORE_ADMIN_TOKEN` → `DEBRID_INTERNAL_TOKEN`.
/// `JACKETT_TEST_TOKEN` fica FORA de propósito (diagnóstico não apaga magnet).
pub fn destructive_token_from_env() -> Option<String> {
    [TOKEN_ENV, "DEBRID_INTERNAL_TOKEN"].iter().find_map(|key| {
        let value = std::env::var(key).ok()?.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

pub(crate) struct AdminState {
    token: String,
    store: Arc<StreamsStore>,
    /// Graça do SWR — o mesmo `STREAM_STALE_GRACE_SECONDS` da busca: o trace
    /// enxerga exatamente o que a busca enxergaria (inclusive stale).
    grace_seconds: u64,
    /// Colhedor nativo; `None` = desligado, store indisponível ou corte nativo
    /// desligado: `/harvest*` responde o contrato com `enabled:false`.
    pub(crate) harvest: Option<HarvestHandle>,
    /// Worker Chupim preparado; a fase atual não lê fila nem chama debrid.
    pub(crate) autofetch: Option<AutofetchHandle>,
    /// Agendador das varreduras da AllDebrid; `None` = rota sem runtime
    /// (`enabled:false` + `disabledReason:"not_wired"`), nunca 500.
    pub(crate) sweeps: Option<SweepAdmin>,
    pub(crate) ownership_kv: Option<Arc<adom_index::NativeKv>>,
    /// Warmer RD (fila/pausa/dreno); `None` = `DEBRID_RD_WARM` desligado.
    pub(crate) warmer: Option<Arc<crate::rd_warmer::Warmer>>,
    /// Credencial das rotas DESTRUTIVAS; `None` = nenhuma configurada (409).
    pub(crate) destructive_token: Option<String>,
}

/// Roteador completo (auth + rotas); `pub(crate)` para os testes de rota.
#[allow(clippy::too_many_arguments)] // um dono por eixo: store, graça, harvest, chupim, varreduras, posse, warmer
pub(crate) fn router_with_ownership(
    cfg: &AdminConfig,
    store: Arc<StreamsStore>,
    grace_seconds: u64,
    harvest: Option<HarvestHandle>,
    autofetch: Option<AutofetchHandle>,
    sweeps: Option<SweepAdmin>,
    ownership: Router<Arc<AdminState>>,
    ownership_kv: Option<Arc<adom_index::NativeKv>>,
    warmer: Option<Arc<crate::rd_warmer::Warmer>>,
) -> Router {
    if cfg.token.is_empty() {
        eprintln!("[gateway] streams admin sem token; responde 503");
    }
    let state = Arc::new(AdminState {
        token: cfg.token.clone(),
        store,
        grace_seconds,
        harvest,
        autofetch,
        sweeps,
        ownership_kv,
        warmer,
        destructive_token: cfg.destructive_token.clone(),
    });
    Router::new()
        .route("/streams/invalidate", post(invalidate))
        // O handler mora no `util`: as duas guardas desta rota não cabiam aqui
        // sem estourar a catraca de 400 linhas.
        .route("/streams/clear", post(util::clear))
        .route("/streams/trace", get(trace_handler::trace))
        .route("/streams/stats", get(stats))
        .route("/indexers/status", get(indexer_status))
        .merge(crate::autofetch::admin_router())
        .merge(ownership)
        .merge(crate::harvest::admin_router())
        .merge(crate::al_sweeps::admin_router())
        .merge(crate::rd_warmer::admin_router())
        .merge(crate::magnet_bank_admin::admin_router())
        .merge(crate::catalog_admin::router())
        .merge(account_catalog::admin_router())
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .with_state(state)
}

/// Sobe a API e devolve SÓ quando o socket fecha (erro) — o chamador faz
/// `tokio::spawn`. Falha de bind é logada e não derruba o gateway.
pub async fn serve(
    cfg: AdminConfig,
    store: Arc<StreamsStore>,
    grace_seconds: u64,
    harvest: Option<HarvestHandle>,
    autofetch: Option<AutofetchHandle>,
    sweeps: Option<SweepAdmin>,
    warmer: Option<Arc<crate::rd_warmer::Warmer>>,
) -> Result<(), String> {
    let listen = cfg.listen;
    let ownership = crate::ownership_admin::router();
    let ownership_kv = crate::ownership_admin::from_env();
    let app = router_with_ownership(
        &cfg,
        store,
        grace_seconds,
        harvest,
        autofetch,
        sweeps,
        ownership,
        ownership_kv,
        warmer,
    );
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|err| format!("nao escutei {listen}: {err}"))?;
    let bound = listener
        .local_addr()
        .map_err(|err| format!("endereco local: {err}"))?;
    eprintln!("[gateway] streams admin (streams.db) em {bound}");
    axum::serve(listener, app)
        .await
        .map_err(|err| format!("API do streams.db encerrou: {err}"))
}

async fn auth(
    State(state): State<Arc<AdminState>>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if state.token.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "ok": false, "error": "streams_admin_disabled" })),
        )
            .into_response();
    }
    let got = req
        .headers()
        .get("x-indexer-test-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !tokens_match(&state.token, got) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "ok": false, "error": "unauthorized" })),
        )
            .into_response();
    }
    next.run(req).await
}

/// `POST /streams/invalidate` — apaga o cache de UMA obra (ou de um hash).
///
/// De propósito NÃO exige `confirm` nem a credencial destrutiva: é o reparo do
/// caminho quente. O `/resolve` pede a obra quando o play prova
/// `NoVideoError`/`DubLieError`/`EpisodePickError`/451 e o sidecar do crawl
/// invalida a página que acabou de ingerir (`adom-crawl::ingest`). Um `confirm`
/// aqui deixaria o play sem reconstrução (ou cada página raspada em 409) e a
/// credencial destrutiva teria de morar em mais dois processos para apagar UMA
/// obra — o dano é limitado (o próximo `stream` reconstrói) e não alcança outra
/// obra. Quem zera o namespace é o `/streams/clear`, esse sim com as duas.
async fn invalidate(State(state): State<Arc<AdminState>>, Json(body): Json<Value>) -> Response {
    let imdb = body.get("imdbId").and_then(Value::as_str).unwrap_or("");
    let hash = body.get("hash").and_then(Value::as_str).unwrap_or("");
    if imdb.is_empty() == hash.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": "envie imdbId OU hash" })),
        )
            .into_response();
    }
    let (scope, result) = if !imdb.is_empty() {
        ("obra", state.store.invalidate_for_obra(imdb))
    } else {
        ("hash", state.store.invalidate_for_hash(hash))
    };
    match result {
        Ok(removed) => {
            Json(json!({ "ok": true, "scope": scope, "removed": removed })).into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": err })),
        )
            .into_response(),
    }
}

async fn stats(State(state): State<Arc<AdminState>>) -> Response {
    // Hit-rate REAL do cache: os contadores `stream.cache.*` moram no processo
    // do gateway (rota/commit/promoção), não no store — por isso o snapshot
    // vem do orquestrador e não daqui. `hitRate` é `null` sem NENHUMA consulta.
    let snapshot = adom_search::orchestrator::stream_cache_metrics_snapshot();
    let of = |key: &str| snapshot.get(key).copied().unwrap_or(0);
    Json(json!({
        "ok": true,
        "entries": state.store.len().unwrap_or(0),
        "quota": state.store.quota(),
        "hit": of(stream_cache_metrics::HIT),
        "staleServed": of(stream_cache_metrics::STALE_SERVED),
        "miss": of(stream_cache_metrics::MISS),
        "writes": of(stream_cache_metrics::WRITE),
        "hitRate": stream_cache_metrics::hit_rate(&snapshot),
    }))
    .into_response()
}
/// `GET /indexers/status` — última consulta medida de cada indexer nas buscas
/// vivas + a foto do circuito (`adom_sources::jackett::status_board`). O Node
/// traduz para o `indexer-status.ts`; sem isto o painel ficava "desconhecido".
async fn indexer_status() -> Response {
    let now = adom_sources::now_ms();
    Json(json!({
        "ok": true,
        "now": now,
        "indexers": adom_sources::jackett::status_board::snapshot(now),
    }))
    .into_response()
}

#[cfg(test)]
#[path = "rd_warmer_admin_tests.rs"]
mod rd_warmer_admin_tests;
#[cfg(test)]
#[path = "store_admin_tests.rs"]
mod store_admin_tests;
