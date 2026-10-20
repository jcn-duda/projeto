//! Sombra de `/stream` (`ROUTES_RUST=stream-shadow`).
//!
//! Contrato `docs/rust-stream-contract.md` §9.1: o Node responde ao cliente; o
//! Rust observa em `tokio::spawn` e **só compara**. Não escreve cache, não
//! chama debrid, não devolve nada ao cliente.
//!
//! Dois caminhos de comparação, nesta ordem:
//!
//! 1. **captura congelada por requisição** (`STREAM_FROZEN_SHADOW_BASE`): a
//!    resposta NORMAL do cliente não serve de `expected` — ela pode vir do SWR
//!    ou do fast-path parcial e não é reproduzível a partir das entradas. Depois
//!    de observá-la, a sombra faz uma **segunda request** ao mesmo Node com o
//!    mesmo path/headers + `X-Adom-Shadow-Id` e `X-Adom-Shadow-Frozen: 1`
//!    (`behaviorFrozen`: SWR/fast-path desligados). O Node grava
//!    `<base>/<id>/{request,inputs,expected,manifest}` e o corpo DESSA request é
//!    o `expected`; o gateway hidrata `inputs/config.json` pelo
//!    `POST /internal/search/config` e reexecuta
//!    [`frozen_gate::run_case_with_expected`] — mesma montagem do gate
//!    congelado, sem ruído de coleta.
//! 2. **fallback** (comportamento anterior, só sem `STREAM_FROZEN_SHADOW_BASE`):
//!    [`crate::stream::build_shadow_orchestrator`] (`shadow_mode` +
//!    `NoDebridFactory` + `NoopTailEffects`) contra as rotas ao vivo. Falha da
//!    segunda request NUNCA vira divergência.
//!
//! Gate atual: comparação por **identidade** (§9.3 parcial — `infoHash` / URL
//! relativa mascarando host+sig+config / `externalUrl`, ordem via `BTreeSet`).
//! Isso **não** autoriza o corte por rota do §9.4 sozinho (faltam cobertura,
//! janela ≥72 h, distribuição, corpus e2e e revisor humano).
//!
//! Sem token/env para remontar (fallback) e sem base congelada: **pula** — não
//! incrementa `compared` nem acusa `divergence` (falso positivo envenenaria o
//! critério de corte).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use adom_search::orchestrator::{frozen_gate, NodeRoutes, Orchestrator, StreamRequest};
use adom_search::{parse_stream_path, relative_url, reply_deadline_ms, StreamItem, StreamResponse};
use axum::body::Body;
use bytes::Bytes;
use http::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use http::{HeaderMap, Request as HttpRequest, StatusCode, Uri};
use http_body_util::BodyExt;
use serde_json::Value;

/// Nomes do contrato `docs/rust-stream-contract.md` §9.2.
pub const COMPARED: &str = "stream.shadow.compared";
pub const DIVERGENCE: &str = "stream.shadow.divergence";
pub const DIVERGENCE_ITEMS: &str = "stream.shadow.divergence.items";
pub const TIMEOUT: &str = "stream.shadow.timeout";
pub const ERROR: &str = "stream.shadow.error";

const KEYS: &[&str] = &[COMPARED, DIVERGENCE, DIVERGENCE_ITEMS, TIMEOUT, ERROR];

/// Contadores da sombra. Sempre expõe as chaves do §9 (zeradas até haver
/// observação). `Clone` barato via `Arc` para o `tokio::spawn`.
#[derive(Clone, Default)]
pub struct ShadowMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl ShadowMetrics {
    pub fn new() -> Self {
        let metrics = Self::default();
        let _ = metrics.snapshot();
        metrics
    }

    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        for key in KEYS {
            guard.entry((*key).to_string()).or_insert(0);
        }
        guard.clone()
    }

    pub fn inc(&self, key: &str, by: u64) {
        if by == 0 {
            return;
        }
        let mut guard = self.counts.lock().unwrap_or_else(|err| err.into_inner());
        let entry = guard.entry(key.to_string()).or_insert(0);
        *entry = (*entry).saturating_add(by);
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> u64 {
        self.snapshot().get(key).copied().unwrap_or(0)
    }
}

/// Remontador opcional: só existe com `JACKETT_TEST_TOKEN` (e base loopback).
pub type ShadowRemount = Orchestrator;

/// Monta o orquestrador **compare-only** ligado às rotas internas do Node.
/// `None` sem token — o FALLBACK então não compara; o caminho congelado (segunda
/// request + replay) não depende deste remount.
///
/// Usa [`crate::stream::build_shadow_orchestrator`] (sem debrid / SWR / tail).
pub fn remount_from_env() -> Option<ShadowRemount> {
    NodeRoutes::from_env()?;
    Some(crate::stream::build_shadow_orchestrator())
}

/// `true` para `/stream/<type>/<id>.json` e `/<config>/stream/<type>/<id>.json`.
pub fn is_stream_path(path: &str) -> bool {
    parse_stream_path(path).is_some()
}

/// Header que liga a captura congelada à requisição (`X-Adom-Shadow-Id`).
/// Vai só na SEGUNDA request (a normal do cliente nunca o leva).
pub const SHADOW_ID_HEADER: &str = "x-adom-shadow-id";
/// Marca a segunda request como comportamento frozen (`behaviorFrozen`: SWR e
/// fast-path desligados no Node), para o corpo ser reproduzível.
pub const SHADOW_FROZEN_HEADER: &str = "x-adom-shadow-frozen";

/// Contexto da requisição capturado no proxy (path + UA + origin), os headers
/// que a segunda request herda e o alvo da captura congelada.
#[derive(Debug, Clone)]
pub struct ShadowRequest {
    pub path: String,
    pub user_agent: Option<String>,
    pub origin: Option<String>,
    /// Id gerado pelo gateway e mandado só na segunda request (`X-Adom-Shadow-Id`).
    pub shadow_id: Option<String>,
    /// `STREAM_FROZEN_SHADOW_BASE` — raiz onde o Node grava `<id>/`.
    pub frozen_base: Option<PathBuf>,
    /// Headers da request do cliente já filtrados (hop-by-hop fora, sem os
    /// headers da sombra). A segunda request os reusa para o Node calcular o
    /// MESMO `originOf` da resposta normal — o diff mascara host, mas precisa
    /// mascarar exatamente o que o Node escreveu.
    pub headers: HeaderMap,
    /// Base do Node (`GATEWAY_UPSTREAM`), alvo da segunda request.
    pub node_base: Uri,
}

/// Observação fire-and-forget do corpo que o Node devolveu para o CLIENTE.
///
/// O corpo normal não é o `expected` (pode vir do SWR/fast-path e não é
/// reproduzível); com `STREAM_FROZEN_SHADOW_BASE` a sombra dispara a segunda
/// request frozen e compara contra ela.
///
/// - Captura congelada ok: `compared`/`divergence`/`divergence.items`.
/// - Sem base congelada e sem `remount`: pula (sem `compared`/`divergence`).
/// - Segunda request / captura incompleta / config / replay: `error` (nunca
///   `divergence`).
/// - Prazo estourado: `timeout`.
/// - Remontagem ok: sempre `compared`; `divergence`/`items` só se os conjuntos
///   de identidade diferirem.
pub async fn observe_node_response(
    status: StatusCode,
    body: Bytes,
    req: ShadowRequest,
    metrics: ShadowMetrics,
    remount: Option<ShadowRemount>,
) {
    if !status.is_success() {
        // `/stream` quase sempre é 200; não-sucesso não entra no denominador.
        return;
    }
    if req.frozen_base.is_none() && remount.is_none() {
        return;
    }

    let Some(stream_req) = StreamRequest::from_path(
        &req.path,
        req.user_agent.as_deref(),
        req.origin.as_deref(),
        None,
    ) else {
        metrics.inc(ERROR, 1);
        return;
    };
    let encoded = stream_req.encoded.as_deref().unwrap_or("");

    // 1) Caminho congelado: segunda request com `behaviorFrozen`; o `expected`
    //    é o corpo DELA (nunca o corpo normal), e só `streams` é comparado.
    if let (Some(id), Some(base)) = (req.shadow_id.as_deref(), req.frozen_base.as_deref()) {
        if !valid_shadow_id(id) {
            metrics.inc(ERROR, 1);
            return;
        }
        let dir = base.join(id);
        match capture_frozen_body(&req, id).await {
            Ok(frozen_body) => {
                if let Err(err) = wait_frozen_case(&dir, FROZEN_DIR_WAIT).await {
                    eprintln!("[shadow] captura congelada incompleta em {id}: {err}");
                    metrics.inc(ERROR, 1);
                    return;
                }
                observe_frozen(&dir, &frozen_body, &req, encoded, &metrics).await;
            }
            Err(err) => {
                // Segunda request falhou: `error`, nunca divergência (o corpo
                // normal não é comparável de forma honesta).
                eprintln!("[shadow] segunda request frozen falhou em {id}: {err}");
                metrics.inc(ERROR, 1);
            }
        }
        return;
    }

    // 2) Fallback: remontagem ao vivo (comportamento anterior).
    let Some(orch) = remount else {
        return;
    };
    debug_assert!(
        orch.shadow_mode(),
        "sombra deve usar build_shadow_orchestrator (shadow_mode)"
    );

    let node: StreamResponse = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(_) => {
            metrics.inc(ERROR, 1);
            return;
        }
    };

    let reply_ms = reply_deadline_ms(
        req.user_agent.as_deref(),
        orch.config().stremio_reply_ms,
        orch.config().app_reply_ms,
    );
    let rust_body = match tokio::time::timeout(
        Duration::from_millis(reply_ms.saturating_add(500)),
        orch.handle(stream_req.clone()),
    )
    .await
    {
        Ok(response) => response,
        Err(_) => {
            metrics.inc(TIMEOUT, 1);
            return;
        }
    };

    record_comparison(&node, &rust_body, stream_req.encoded.as_deref(), &metrics);
}

/// Compara duas respostas já montadas (testes e caminho do observe).
pub fn record_comparison(
    node: &StreamResponse,
    rust: &StreamResponse,
    config_segment: Option<&str>,
    metrics: &ShadowMetrics,
) {
    metrics.inc(COMPARED, 1);
    let left = identity_set(&node.streams, config_segment);
    let right = identity_set(&rust.streams, config_segment);
    let items = divergent_item_count(&left, &right);
    if items > 0 {
        metrics.inc(DIVERGENCE, 1);
        metrics.inc(DIVERGENCE_ITEMS, items);
    }
}

// ── captura congelada por requisição ────────────────────────────────────────

/// Default do Node em loopback com `GATEWAY=on` (mesmo do `NodeRoutes`).
const DEFAULT_INTERNAL_BASE: &str = "http://127.0.0.1:7100";
/// Teto HTTP da hidratação de `config.json` (loopback, corpo pequeno). 5 s
/// estourava sob a carga da sombra (lote + 2ª request); 15 s cobre a pressão
/// sem mascarar falha real.
const CONFIG_TIMEOUT: Duration = Duration::from_millis(15_000);
/// Teto da SEGUNDA request. Ela é a busca CONGELADA de verdade — índice +
/// coleta ao vivo, sem SWR — e sob concorrência (4 workers) o teto antigo de
/// 20 s estourava com `frozen: prazo esgotado`, virando `error` em massa em vez
/// de comparação. 60 s é folga sobre o prazo do Node (`APP_REPLY_DEADLINE_MS`
/// sem SWR + tail), não um alvo: a sombra nunca segura o cliente.
const FROZEN_NODE_TIMEOUT: Duration = Duration::from_secs(60);
/// Espera pelo flush do dir depois da resposta frozen (o Node grava durante a
/// request; a resposta pode chegar com o último arquivo ainda no buffer).
/// 1 s era curto sob carga e virava `error` de captura incompleta em ~1/8 dos
/// casos; 10 s não muda o caminho feliz (retorna no primeiro poll completo).
const FROZEN_DIR_WAIT: Duration = Duration::from_secs(10);
/// Intervalo da espera do dir.
const FROZEN_DIR_POLL: Duration = Duration::from_millis(20);
/// Teto do replay congelado. As rotas congeladas não fazem I/O de rede; o prazo
/// existe só para não deixar task pendurada se um dublê travar. Igual ao da
/// segunda request: o replay carrega/anota o caso inteiro e, sob carga, um teto
/// menor que o da captura só produziria `timeout` falso.
const FROZEN_REPLAY_TIMEOUT: Duration = Duration::from_secs(60);

/// Id aceito no nome do diretório: o gateway gera hexadecimal com `-`; fechar
/// o alfabeto impede traversal (`../`) e nomes arbitrários.
fn valid_shadow_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// SEGUNDA request ao Node, no MESMO path/headers, marcada com
/// `X-Adom-Shadow-Id` + `X-Adom-Shadow-Frozen: 1`. O corpo dela é o `expected`
/// (a resposta normal pode vir do SWR/fast-path). `Err` = falha de
/// transporte/status/JSON: a sombra conta `error`, nunca divergência.
async fn capture_frozen_body(req: &ShadowRequest, id: &str) -> Result<Value, String> {
    let uri = crate::proxy::upstream_uri(&req.node_base, &req.path)
        .map_err(|()| "frozen: path inválido".to_string())?;
    let mut headers = req.headers.clone();
    // Body vazio + resposta JSON: fora o que poderia pedir 304/gzip/corpo.
    headers.remove(http::header::CONTENT_LENGTH);
    headers.remove(http::header::ACCEPT_ENCODING);
    headers.remove(http::header::IF_NONE_MATCH);
    headers.remove(http::header::IF_MODIFIED_SINCE);
    headers.insert(
        HeaderName::from_static(SHADOW_ID_HEADER),
        HeaderValue::from_str(id).map_err(|err| format!("id inválido: {err}"))?,
    );
    headers.insert(
        HeaderName::from_static(SHADOW_FROZEN_HEADER),
        HeaderValue::from_static("1"),
    );
    let mut request = HttpRequest::builder()
        .method(http::Method::GET)
        .uri(uri)
        .body(Body::empty())
        .map_err(|err| format!("requisição frozen: {err}"))?;
    *request.headers_mut() = headers;

    let client = crate::proxy::client();
    let response = tokio::time::timeout(FROZEN_NODE_TIMEOUT, client.request(request))
        .await
        .map_err(|_| "frozen: prazo esgotado".to_string())?
        .map_err(|err| format!("frozen: rede {err}"))?;
    let status = response.status();
    let bytes = tokio::time::timeout(FROZEN_NODE_TIMEOUT, response.into_body().collect())
        .await
        .map_err(|_| "frozen: corpo atrasou".to_string())?
        .map_err(|err| format!("frozen: corpo {err}"))?
        .to_bytes();
    if !status.is_success() {
        let snippet: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
        return Err(format!("frozen: HTTP {status}: {snippet}"));
    }
    serde_json::from_slice(&bytes).map_err(|err| format!("frozen: json {err}"))
}

/// Espera o dir `<base>/<id>` ficar completo para o replay. `collect`/`meta`
/// são o contrato com o Node; `request.json` entra porque `FrozenCase::load` o
/// exige. Sem flush no prazo → `Err` (o chamador conta `error`, nunca
/// divergência).
async fn wait_frozen_case(dir: &Path, budget: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if frozen_case_ready(dir) {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(format!("{} sem collect/meta/request", dir.display()));
        }
        tokio::time::sleep(FROZEN_DIR_POLL).await;
    }
}

/// Captura completa o bastante para o replay. Além do collect (busca viva),
/// aceita o caminho INDEX-SERVED: a 2ª request em produção pode responder do
/// índice e não chamar `collect`; o `FrozenCase` então monta por `index.json`.
fn frozen_case_ready(dir: &Path) -> bool {
    if !dir.join("request.json").is_file() || !dir.join("inputs/meta.json").is_file() {
        return false;
    }
    if dir.join("inputs/collect.json").is_file() {
        return true;
    }
    let index = dir.join("inputs/index.json");
    let Ok(bytes) = std::fs::read(&index) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return false;
    };
    value
        .get("value")
        .and_then(|v| v.get("servedFromIndex"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Replay do caso congelado e contagem §9.2.
///
/// O chamador já esperou o dir ficar completo; falha de replay (JSON quebrado,
/// config ausente/sem `options`, diretório concorrente) é `error`, NUNCA
/// `divergence` — só o diff de `streams` conta como divergência.
async fn observe_frozen(
    dir: &Path,
    expected: &Value,
    req: &ShadowRequest,
    encoded: &str,
    metrics: &ShadowMetrics,
) {
    // §9.4 item 6: expected de AVISO/coleta vazia não é comparável — a 2ª
    // request congelada pode herdar o prazo/coleta vazia da original e devolver
    // o aviso ("Procurando fontes — reabra em instantes") enquanto a captura
    // tem o lote; o replay então monta a lista e o comparador acusaria uma
    // divergência de PIPELINE que não existe. PULA (não conta `compared` nem
    // `divergence`); retry não resolve — a coleta vazia é transiente e a
    // captura já é a melhor evidência do build.
    if notice_only(expected) {
        eprintln!(
            "[shadow] expected de aviso/coleta vazia em {}: comparação pulada",
            dir.display()
        );
        return;
    }
    if let Err(err) = hydrate_config(dir, encoded).await {
        eprintln!(
            "[shadow] config do caso {} indisponível: {err}",
            dir.display()
        );
        metrics.inc(ERROR, 1);
        return;
    }
    let origin = req.origin.as_deref().unwrap_or("");
    let replay = tokio::time::timeout(
        FROZEN_REPLAY_TIMEOUT,
        frozen_gate::run_case_with_expected(dir, expected, origin, encoded),
    )
    .await;
    let detail = match replay {
        Ok(Ok(())) => {
            metrics.inc(COMPARED, 1);
            return;
        }
        Ok(Err(detail)) => detail,
        Err(_) => {
            metrics.inc(TIMEOUT, 1);
            return;
        }
    };
    // O comparador emite uma linha `#<índice>` por item divergente; sem
    // nenhuma, o `Err` é falha de replay (não diff) e vira `error`.
    let items = detail.lines().filter(|line| line.starts_with('#')).count() as u64;
    if items == 0 {
        eprintln!(
            "[shadow] replay congelado falhou em {}: {detail}",
            dir.display()
        );
        metrics.inc(ERROR, 1);
        return;
    }
    metrics.inc(COMPARED, 1);
    metrics.inc(DIVERGENCE, 1);
    metrics.inc(DIVERGENCE_ITEMS, items);
    eprintln!(
        "[shadow] divergência congelada em {}: {detail}",
        dir.display()
    );
}

/// Grava `inputs/config.json` com os knobs do Node para o `encoded` desta
/// requisição. Se a rota falhar mas o arquivo já existir (o record grava o
/// config ANTES do `/stream`), usa o arquivo — melhor que cair no remount.
async fn hydrate_config(dir: &Path, encoded: &str) -> Result<(), String> {
    let path = dir.join("inputs/config.json");
    match config_from_node(encoded).await {
        Ok(value) => {
            let bytes = serde_json::to_vec(&value).map_err(|err| format!("config json: {err}"))?;
            std::fs::write(&path, bytes).map_err(|err| format!("{}: {err}", path.display()))
        }
        Err(err) => {
            if path.is_file() {
                eprintln!(
                    "[shadow] /internal/search/config falhou ({err}); usando {}",
                    path.display()
                );
                return Ok(());
            }
            Err(err)
        }
    }
}

/// POST `/internal/search/config` (loopback + `X-Indexer-Test-Token`) com
/// `{encoded}`. Mesmo token/base do `NodeRoutes`; o token nunca sai de
/// loopback — se `INTERNAL_SEARCH_URL` apontar para fora, nem tenta.
async fn config_from_node(encoded: &str) -> Result<Value, String> {
    let token = std::env::var("JACKETT_TEST_TOKEN")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .ok_or_else(|| "sem JACKETT_TEST_TOKEN".to_string())?;
    let base = std::env::var("INTERNAL_SEARCH_URL")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| DEFAULT_INTERNAL_BASE.to_string());
    if !is_loopback_base(&base) {
        return Err(format!("INTERNAL_SEARCH_URL fora de loopback: {base}"));
    }
    let payload = serde_json::json!({
        "encoded": adom_search::encoded_for_internal(Some(encoded)),
    });
    let request = HttpRequest::builder()
        .method(http::Method::POST)
        .uri(format!(
            "{}/internal/search/config",
            base.trim_end_matches('/')
        ))
        .header(CONTENT_TYPE, "application/json")
        .header(
            HeaderName::from_static("x-indexer-test-token"),
            HeaderValue::from_str(&token).map_err(|err| format!("token inválido: {err}"))?,
        )
        .body(Body::from(payload.to_string()))
        .map_err(|err| format!("requisição de config: {err}"))?;
    let client = crate::proxy::client();
    let response = tokio::time::timeout(CONFIG_TIMEOUT, client.request(request))
        .await
        .map_err(|_| "config: prazo esgotado".to_string())?
        .map_err(|err| format!("config: rede {err}"))?;
    let status = response.status();
    let bytes = tokio::time::timeout(CONFIG_TIMEOUT, response.into_body().collect())
        .await
        .map_err(|_| "config: corpo atrasou".to_string())?
        .map_err(|err| format!("config: corpo {err}"))?
        .to_bytes();
    if !status.is_success() {
        // 401/503 do guarda interno: o corpo diz qual (token ausente/inválido).
        let snippet: String = String::from_utf8_lossy(&bytes).chars().take(200).collect();
        return Err(format!("config: HTTP {status}: {snippet}"));
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|err| format!("config: json {err}"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(format!(
            "config: {}",
            value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("ok:false")
        ));
    }
    if value.get("options").and_then(Value::as_object).is_none() {
        return Err("config: resposta sem options".to_string());
    }
    Ok(value)
}

/// Só loopback (mesma invariante de `InternalSearchClient`).
fn is_loopback_base(base: &str) -> bool {
    let Some(rest) = base
        .strip_prefix("http://")
        .or_else(|| base.strip_prefix("https://"))
    else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        inner.split(']').next().unwrap_or("")
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if port.chars().all(|ch| ch.is_ascii_digit()) {
            host
        } else {
            authority
        }
    } else {
        authority
    };
    matches!(host, "localhost" | "127.0.0.1" | "::1")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Identidades estáveis de uma lista (ordem fora do conjunto).
pub fn identity_set(streams: &[StreamItem], config_segment: Option<&str>) -> BTreeSet<String> {
    streams
        .iter()
        .map(|item| item_identity(item, config_segment))
        .collect()
}

fn item_identity(item: &StreamItem, config_segment: Option<&str>) -> String {
    if let Some(hash) = &item.info_hash {
        return format!("ih:{}", hash.to_ascii_lowercase());
    }
    if let Some(url) = &item.url {
        let masked = mask_url(url, config_segment);
        if let Some(hash) = resolve_hash(&masked) {
            return format!("resolve:{}", hash.to_ascii_lowercase());
        }
        return format!("url:{masked}");
    }
    if let Some(ext) = &item.external_url {
        return format!("ext:{}", mask_url(ext, config_segment));
    }
    "empty".to_string()
}

/// Host → path relativo; `sig` → `{{sig}}`; segmento de config → `{{config}}`.
pub fn mask_url(raw: &str, config_segment: Option<&str>) -> String {
    let mut text = relative_url(raw);
    if let Some(segment) = config_segment {
        let segment = segment.trim_matches('/');
        if !segment.is_empty() {
            text = text.replace(&format!("/{segment}/"), "/{{config}}/");
        }
    }
    mask_sig_param(&text)
}

fn resolve_hash(url: &str) -> Option<&str> {
    let rest = url.split("/resolve/").nth(1)?;
    let hash = rest.split(['?', '/', '#']).next().unwrap_or(rest);
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

fn mask_sig_param(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'?' | b'&' => {
                out.push(bytes[index] as char);
                index += 1;
                let name_start = index;
                while index < bytes.len() && !matches!(bytes[index], b'=' | b'&' | b'#') {
                    index += 1;
                }
                let name = &text[name_start..index];
                if name == "sig" && bytes.get(index) == Some(&b'=') {
                    out.push_str("sig={{sig}}");
                    index += 1; // '='
                    while index < bytes.len() && !matches!(bytes[index], b'&' | b'#') {
                        index += 1;
                    }
                } else {
                    out.push_str(&text[name_start..index]);
                }
            }
            _ => {
                out.push(bytes[index] as char);
                index += 1;
            }
        }
    }
    out
}

/// Magnitude §9.2: quantos ids estão só de um lado (diferença simétrica).
pub fn divergent_item_count(node: &BTreeSet<String>, rust: &BTreeSet<String>) -> u64 {
    node.symmetric_difference(rust).count() as u64
}

/// Corpo do Node SEM lista comparável: nenhum stream, ou só avisos
/// (`{"name": "...", "notice": true}`). Aviso é o `Procurando fontes` da coleta
/// vazia/parcial — não é decisão de pipeline (§9.4 item 6).
pub fn notice_only(body: &Value) -> bool {
    match body.get("streams").and_then(Value::as_array) {
        None => true,
        Some(streams) => streams.iter().all(|stream| {
            stream
                .get("notice")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        }),
    }
}

#[cfg(test)]
#[path = "shadow_tests.rs"]
mod compare_tests;
