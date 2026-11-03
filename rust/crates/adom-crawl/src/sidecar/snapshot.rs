//! Foto do `crawl.db` para o painel: `GET /crawl/site-snapshot?site=<id>&limit=<n>`.
//!
//! O painel Node deixa de abrir o `crawl.db` e lê tudo daqui. A forma do
//! corpo segue o contrato (camelCase) e a semântica do TS: `crawl-store.ts`
//! (contagens, listas, erros, run) e `crawl-status.ts` (agrupamento estável
//! de erros de série). As leituras são SELECT, em uma transação só, para a
//! foto sair de um mesmo instante do WAL.
//!
//! Segurança: mesma regra das rotas de [`super::admin`] (token no header,
//! `site` do registry, 401/400/500 no envelope `{ok:false,error}`).

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::admin::{bad_request, cursor_view, server_error, site_from_request};
use super::server::{validate_token, AppState};
use crate::store::read_ops::{RunSnapshot, StatusTally, VitalsTally};
use crate::store::{CrawlStore, StoreError, UrlRow};

/// Chave do veredito da sonda em `crawl_state` (`PROBE_STATE_KEY` do TS).
pub(super) const PROBE_VERDICT_KEY: &str = "probe:verdict";

/// `limit` quando a query não traz o parâmetro.
const DEFAULT_LIMIT: u32 = 50;
/// Teto de `limit`: acima disso o valor é cortado (não é erro).
const MAX_LIMIT: u32 = 200;
/// Mesmo teto do TS (`STATUS_ERROR_GROUPS_LIMIT`). O corte é nos motivos CRUS,
/// antes de juntar os que o `stable_error_reason` une.
const ERROR_GROUPS_LIMIT: u32 = 10;

/// Query de `GET /crawl/site-snapshot`. `limit` chega cru para o parse ser
/// nosso (valor não numérico vira 400, não 422 do axum).
#[derive(Debug, Deserialize)]
pub(super) struct SnapshotQuery {
    #[serde(default)]
    site: String,
    #[serde(default)]
    limit: Option<String>,
}

// ─── Corpo da resposta (contrato) ───────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SnapshotResponse {
    pub site: String,
    pub counters: CountersOut,
    pub latest_run: Option<RunOut>,
    pub magnets_found: u32,
    pub lists: ListsOut,
    pub error_groups: Vec<GroupOut>,
    pub state: StateOut,
    pub vitals: VitalsOut,
}

/// Vitals do card contados no site inteiro (`CrawlStore::site_vitals`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct VitalsOut {
    pub pages_last_hour: u32,
    pub http429: StatOut,
    pub expired: StatOut,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StatOut {
    pub total: u32,
    pub last_hour: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CountersOut {
    pub total: u32,
    pub by_status: ByStatusOut,
}

/// Mesma ordem de chaves do `emptyCounters` do TS. `no-torrent` está aqui
/// porque o TS o conta, embora o contrato da rota não o liste.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ByStatusOut {
    pub pending: u32,
    pub inflight: u32,
    pub done: u32,
    #[serde(rename = "no-torrent")]
    pub no_torrent: u32,
    #[serde(rename = "no-work")]
    pub no_work: u32,
    pub error: u32,
    pub simulated: u32,
    pub partial: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunOut {
    pub id: i64,
    pub site: String,
    pub phase: &'static str,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub cursor: String,
    pub counters: Map<String, Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListsOut {
    pub done: Vec<RowOut>,
    pub no_work: Vec<RowOut>,
    pub partial: Vec<RowOut>,
    pub error: Vec<RowOut>,
}

/// Linha de lista. `error` e `progress` vazios saem como `null`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RowOut {
    pub url: String,
    pub imdb: Option<String>,
    pub releases: u32,
    pub checked_at: i64,
    pub error: Option<String>,
    pub tries: u32,
    pub progress: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct GroupOut {
    pub reason: String,
    pub count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StateOut {
    /// Veredito da sonda como foi gravado (JSON cru); `null` = nunca gravado.
    pub probe_verdict: Option<String>,
    pub cursor_movie: String,
    pub cursor_tv_show: String,
}

// ─── Handler ────────────────────────────────────────────────────────────────

/// `GET /crawl/site-snapshot` — token, site, limit, depois a foto.
pub(super) async fn site_snapshot(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SnapshotQuery>,
) -> Response {
    if let Err(resp) = validate_token(&state.auth_token, &headers) {
        return resp;
    }
    let site = match site_from_request(&query.site, None) {
        Ok(site) => site,
        Err(resp) => return resp,
    };
    let limit = match parse_limit(query.limit.as_deref()) {
        Ok(limit) => limit,
        Err(message) => return bad_request(None, &site, message),
    };
    let store = state.store.lock().await;
    match build_snapshot(&store, &site, limit) {
        Ok(snapshot) => (StatusCode::OK, Json(snapshot)).into_response(),
        Err(e) => server_error(None, &site, &e.to_string()),
    }
}

/// `limit` ausente ou vazio = 50; número fora de [0, 200] é cortado ao teto.
fn parse_limit(raw: Option<&str>) -> Result<u32, &'static str> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_LIMIT);
    };
    let n: i64 = raw.parse().map_err(|_| "limit inválido")?;
    Ok(n.clamp(0, i64::from(MAX_LIMIT)) as u32)
}

/// Monta a foto inteira do site numa transação de leitura só.
pub(super) fn build_snapshot(
    store: &CrawlStore,
    site: &str,
    limit: u32,
) -> Result<SnapshotResponse, StoreError> {
    let tx = store.conn().unchecked_transaction()?;
    let tally = store.status_tally(site)?;
    let latest = store.latest_run(site)?;
    let magnets_found = store.sum_releases(site)?;
    let lists = ListsOut {
        done: rows_out(store.list_by_status(site, "done", limit)?),
        no_work: rows_out(store.list_by_status(site, "no-work", limit)?),
        partial: rows_out(store.list_by_status(site, "partial", limit)?),
        error: rows_out(store.list_by_status(site, "error", limit)?),
    };
    let raw_groups = store.error_groups(site, ERROR_GROUPS_LIMIT)?;
    let probe_verdict = store.get_state(site, PROBE_VERDICT_KEY)?;
    let (cursor_movie, cursor_tv_show) = cursor_view(store, site)?;
    let vitals = store.site_vitals(site, crate::motor::types::now_ms())?;
    tx.commit()?;

    Ok(SnapshotResponse {
        site: site.to_string(),
        counters: counters_out(&tally),
        latest_run: latest.map(run_out),
        magnets_found,
        lists,
        error_groups: merge_error_groups(raw_groups),
        state: StateOut {
            probe_verdict,
            cursor_movie,
            cursor_tv_show,
        },
        vitals: vitals_out(&vitals),
    })
}

fn vitals_out(v: &VitalsTally) -> VitalsOut {
    VitalsOut {
        pages_last_hour: v.pages_last_hour,
        http429: StatOut {
            total: v.http429_total,
            last_hour: v.http429_last_hour,
        },
        expired: StatOut {
            total: v.expired_total,
            last_hour: v.expired_last_hour,
        },
    }
}

fn counters_out(t: &StatusTally) -> CountersOut {
    CountersOut {
        total: t.total,
        by_status: ByStatusOut {
            pending: t.pending,
            inflight: t.inflight,
            done: t.done,
            no_torrent: t.no_torrent,
            no_work: t.no_work,
            error: t.error,
            simulated: t.simulated,
            partial: t.partial,
        },
    }
}

fn run_out(r: RunSnapshot) -> RunOut {
    RunOut {
        id: r.id,
        site: r.site,
        phase: r.phase,
        started_at: r.started_at,
        finished_at: r.finished_at,
        cursor: r.cursor,
        counters: r.counters,
    }
}

fn rows_out(rows: Vec<UrlRow>) -> Vec<RowOut> {
    rows.into_iter().map(row_out).collect()
}

fn row_out(r: UrlRow) -> RowOut {
    RowOut {
        url: r.url,
        imdb: r.imdb,
        releases: r.releases,
        checked_at: r.checked_at,
        error: non_empty(r.error),
        tries: r.tries,
        progress: non_empty(r.progress),
    }
}

fn non_empty(text: String) -> Option<String> {
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

// ─── Agrupamento estável de erros (crawl-status.ts) ─────────────────────────

/// Motivo ESTÁVEL de agrupamento. Truncagem de série e estouro de progresso
/// gravam detalhes variáveis no `error` (`cards 2/4`, `botões 40/40`); o motivo
/// é o rótulo antes do detalhe. `/^label\b/i` do TS, sem regex: prefixo ASCII
/// sem diferenciar maiúsculas e sem letra, dígito ou `_` logo depois.
pub(super) fn stable_error_reason(raw: &str) -> String {
    let text = raw.trim();
    if has_label(text, "series_truncated") {
        return "series_truncated".to_string();
    }
    if has_label(text, "series_stall") {
        return "series_stall".to_string();
    }
    if text.is_empty() {
        "erro".to_string()
    } else {
        text.to_string()
    }
}

fn has_label(text: &str, label: &str) -> bool {
    let Some(head) = text.get(..label.len()) else {
        return false;
    };
    if !head.eq_ignore_ascii_case(label) {
        return false;
    }
    match text[label.len()..].chars().next() {
        Some(c) => !(c.is_ascii_alphanumeric() || c == '_'),
        None => true,
    }
}

/// Junta os motivos crus pelo motivo estável, somando as ocorrências. Ordem:
/// frequência desc, depois motivo asc (a mesma do `mergeErrorGroups`).
pub(super) fn merge_error_groups(raw: Vec<(String, u32)>) -> Vec<GroupOut> {
    let mut merged: BTreeMap<String, u32> = BTreeMap::new();
    for (reason, count) in raw {
        let key = stable_error_reason(&reason);
        *merged.entry(key).or_insert(0) += count;
    }
    let mut groups: Vec<GroupOut> = merged
        .into_iter()
        .map(|(reason, count)| GroupOut { reason, count })
        .collect();
    groups.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
    groups
}
