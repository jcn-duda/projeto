//! Canário do CORTE nativo (`ROUTES_RUST=stream`) — instrumento F4.2/F4.3 do §9.4.
//!
//! A sombra congelada (`stream-shadow`) não roda quando o corte está ligado: o
//! `proxy.rs` dá prioridade ao token `stream` e o cliente não passa pelo Node.
//! Sem outro instrumento, o corte fica sem alarme de divergência. Este módulo
//! amostra uma fração DETERMINÍSTICA das buscas do corte (default 0 = OFF),
//! dispara em `tokio::spawn` uma segunda request ao Node e compara `streams`
//! sem segurar o cliente e sem alterar a resposta.
//!
//! Dois modos (`STREAM_CANARY_MODE`):
//!
//! - `frozen` (default até o deploy, rollback): a segunda request leva
//!   `X-Adom-Shadow-Id` + `X-Adom-Shadow-Frozen: 1`; o Node grava o caso em
//!   `STREAM_FROZEN_SHADOW_BASE/<id>` e o gateway reexecuta
//!   [`frozen_gate::run_case_with_expected`]. É o instrumento da janela §9.4
//!   atual e exige a captura congelada no Node.
//! - `direct` (F4.3): a segunda request leva SÓ `X-Adom-Shadow-Frozen: 1` (sem
//!   id → o Node não grava corpus) e o gateway compara o corpo REAL do corte
//!   com o corpo fresco do Node, por identidade (§9.3). NÃO usa `FrozenCase`,
//!   não hidrata `config.json` e não precisa de `STREAM_FROZEN_*` — o novo
//!   alarme sobrevive à aposentadoria da instrumentação congelada.
//!
//! Seleção: FNV-1a de 64 bits sobre o PATH (`/<config>/stream/<tipo>/<id>.json`,
//! que já inclui o segmento `encoded`) → `hash % 100 < percentual`. O mesmo path
//! cai sempre no mesmo balde (não repete/omite entre requisições); 0 nunca
//! amostra, 100 amostra todas.
//!
//! No modo `direct` o percentual > 0 também liga contadores NATIVOS
//! (`stream.canary.native.*`) sobre a resposta do corte, com fonte sem oráculo
//! Node: `cut`, `streams`, `empty`, `notice` e `invalid`. Eles são a base do
//! alarme de "o corte esvaziou" mesmo com o Node fora do ar.

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::body::Body;
use bytes::Bytes;
use http::header::{HeaderName, HeaderValue, USER_AGENT};
use http::{HeaderMap, Method, Request, Uri};
use serde_json::Value;

use adom_search::{parse_stream_path, StreamResponse};

use crate::shadow::{self, FrozenMetricNames, ShadowMetrics, ShadowRequest};

/// Percentual do canário (inteiro 0..100, default 0). Só age no corte.
pub const PERCENT_ENV: &str = "STREAM_CANARY_PERCENT";

/// `frozen` (default) ou `direct` (F4.3, sem `FrozenCase`).
pub const MODE_ENV: &str = "STREAM_CANARY_MODE";

/// Gauge (u64) com o percentual efetivo, sempre exposto em `/metrics`.
pub const PERCENT: &str = "stream.canary.percent";
/// Gauge 1 = modo direto (0 = congelado). Para saber qual alarme está ativo.
pub const DIRECT: &str = "stream.canary.direct";
/// Buscas efetivamente encaminhadas para a segunda request (congelada/direta).
pub const SAMPLED: &str = "stream.canary.sampled";
/// Comparações concluídas (denominador do alarme).
pub const COMPARED: &str = "stream.canary.compared";
/// 1 por busca que divergiu (independente da quantidade de itens).
pub const DIVERGENCE: &str = "stream.canary.divergence";
/// Soma dos itens divergentes (magnitude).
pub const DIVERGENCE_ITEMS: &str = "stream.canary.divergence.items";
/// Replay/segunda request estourou o prazo.
pub const TIMEOUT: &str = "stream.canary.timeout";
/// Falha da segunda request/captura/replay; NUNCA conta como divergência.
pub const ERROR: &str = "stream.canary.error";
/// Amostra pulada por aviso/coleta vazia (§9.4 item 6) — não comparável.
pub const SKIPPED: &str = "stream.canary.skipped";

// Contadores NATIVOS (sem oráculo Node), atualizados quando o canário está
// armado (percentual > 0). Ver o doc do módulo.
pub const NATIVE_CUT: &str = "stream.canary.native.cut";
pub const NATIVE_STREAMS: &str = "stream.canary.native.streams";
pub const NATIVE_EMPTY: &str = "stream.canary.native.empty";
pub const NATIVE_NOTICE: &str = "stream.canary.native.notice";
pub const NATIVE_INVALID: &str = "stream.canary.native.invalid";

const KEYS: &[&str] = &[
    SAMPLED,
    COMPARED,
    DIVERGENCE,
    DIVERGENCE_ITEMS,
    TIMEOUT,
    ERROR,
    SKIPPED,
    NATIVE_CUT,
    NATIVE_STREAMS,
    NATIVE_EMPTY,
    NATIVE_NOTICE,
    NATIVE_INVALID,
];

/// Nomes do mesmo comparador, no namespace do canário.
pub const NAMES: FrozenMetricNames = FrozenMetricNames {
    label: "canary",
    compared: COMPARED,
    divergence: DIVERGENCE,
    divergence_items: DIVERGENCE_ITEMS,
    timeout: TIMEOUT,
    error: ERROR,
    skipped: Some(SKIPPED),
};

/// Caminho de comparação do canário.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Captura congelada + `FrozenCase` (comportamento F4.2, rollback).
    Frozen,
    /// Corpo real do corte × corpo fresco do Node (F4.3).
    Direct,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::Frozen => "frozen",
            Mode::Direct => "direct",
        }
    }
}

/// `direct` só com o valor exato; vazio/inválido = `frozen` (default/rollback).
pub fn mode_from_raw(raw: Option<&str>) -> Mode {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("direct") => Mode::Direct,
        _ => Mode::Frozen,
    }
}

pub fn mode_from_env() -> Mode {
    mode_from_raw(std::env::var(MODE_ENV).ok().as_deref())
}

/// Lê o percentual da env; ausência/inválido = 0; clamp em 0..100.
pub fn percent_from_env() -> u8 {
    percent_from_raw(std::env::var(PERCENT_ENV).ok().as_deref())
}

/// Parsing puro (testável): vazio/inválido → 0; negativo → 0; >100 → 100.
pub fn percent_from_raw(raw: Option<&str>) -> u8 {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<i64>().ok())
        .map(|value| value.clamp(0, 100) as u8)
        .unwrap_or(0)
}

/// Balde determinístico do path (0..99). FNV-1a 64 é estável entre processos e
/// versões do Rust (não usa o hasher aleatório do `HashMap`).
pub fn bucket(path: &str) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in path.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash % 100
}

/// `true` se o path cai na amostra. 0 nunca; 100 sempre.
pub fn is_sampled(path: &str, percent: u8) -> bool {
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    bucket(path) < u64::from(percent)
}

/// Contadores do canário. `ShadowMetrics` é só um mapa de contadores; a
/// instância aqui começa vazia (`default`, sem as chaves da sombra) para o
/// snapshot não sobrescrever `stream.shadow.*` em `/metrics`.
#[derive(Clone, Default)]
pub struct CanaryMetrics {
    counters: ShadowMetrics,
    percent: u8,
    direct: u64,
}

impl CanaryMetrics {
    pub fn new(percent: u8) -> Self {
        Self::with_mode(percent, Mode::Frozen)
    }

    pub fn with_mode(percent: u8, mode: Mode) -> Self {
        Self {
            counters: ShadowMetrics::default(),
            percent: percent.min(100),
            direct: u64::from(mode == Mode::Direct),
        }
    }

    pub fn inner(&self) -> &ShadowMetrics {
        &self.counters
    }

    pub fn inc(&self, key: &str, by: u64) {
        self.counters.inc(key, by);
    }

    /// Snapshot para `/metrics`: chaves do canário (zeradas inclusive) +
    /// `stream.canary.percent` e o gauge do modo.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut snapshot = self.counters.snapshot();
        for key in KEYS {
            snapshot.entry((*key).to_string()).or_insert(0);
        }
        snapshot.insert(PERCENT.to_string(), u64::from(self.percent));
        snapshot.insert(DIRECT.to_string(), self.direct);
        snapshot
    }
}

/// Configuração + contadores do canário no `AppState`.
#[derive(Clone)]
pub struct Canary {
    percent: u8,
    mode: Mode,
    /// Raiz da captura congelada (`STREAM_FROZEN_SHADOW_BASE`). Só no modo
    /// `frozen`; `None` = canário congelado inerte (sem captura).
    frozen_base: Option<PathBuf>,
    metrics: CanaryMetrics,
}

impl Canary {
    pub fn new(percent: u8) -> Self {
        Self {
            percent: percent.min(100),
            mode: Mode::Frozen,
            frozen_base: None,
            metrics: CanaryMetrics::new(percent),
        }
    }

    /// Configuração explícita no modo congelado (testes e compatibilidade).
    pub fn with_base(percent: u8, frozen_base: Option<PathBuf>) -> Self {
        Self::with_mode(percent, Mode::Frozen, frozen_base)
    }

    /// Configuração explícita: percentual + modo + base congelada.
    pub fn with_mode(percent: u8, mode: Mode, frozen_base: Option<PathBuf>) -> Self {
        let percent = percent.min(100);
        Self {
            percent,
            mode,
            frozen_base,
            metrics: CanaryMetrics::with_mode(percent, mode),
        }
    }

    /// Lê `STREAM_CANARY_PERCENT`/`STREAM_CANARY_MODE` só quando o corte está
    /// ligado; fora dele o percentual fica 0 (a sombra continua sendo o
    /// instrumento do §9.4). A base congelada é lida uma vez no boot e só no
    /// modo `frozen` — o modo `direct` não depende dela.
    pub fn from_env(stream_cut: bool) -> Self {
        if !stream_cut {
            return Self::new(0);
        }
        let mode = mode_from_env();
        if mode == Mode::Frozen {
            return Self::with_base(percent_from_env(), crate::proxy::frozen_shadow_base());
        }
        Self::with_mode(percent_from_env(), mode, None)
    }

    pub fn percent(&self) -> u8 {
        self.percent
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn frozen_base(&self) -> Option<&std::path::Path> {
        self.frozen_base.as_deref()
    }

    pub fn metrics(&self) -> &CanaryMetrics {
        &self.metrics
    }

    /// `true` quando há amostragem (os contadores nativos ligam junto).
    pub fn armed(&self) -> bool {
        self.percent > 0
    }

    /// Planeja a amostra da requisição. `None` = não amostra, modo congelado
    /// sem base, HEAD no modo direto ou path inválido — nenhuma segunda
    /// request é feita.
    pub fn plan(&self, req: &Request<Body>, node_base: &Uri) -> Option<CanaryPlan> {
        let path = req.uri().path();
        // O corpo do corte (fonte do modo direto) só existe em GET.
        if self.mode == Mode::Direct && *req.method() != Method::GET {
            return None;
        }
        if !is_sampled(path, self.percent) {
            return None;
        }
        plan_parts(
            path,
            req.headers(),
            node_base,
            self.mode,
            self.frozen_base.clone(),
            self.percent,
            crate::proxy::new_shadow_id(),
        )
    }

    /// Contadores NATIVOS sobre o corpo do corte (sem Node). Chamado para toda
    /// resposta do corte quando o canário está armado (`percent > 0`), amostre
    /// ou não. `None` = HEAD (sem corpo).
    pub fn observe_cut(&self, body: Option<&[u8]>) {
        if !self.armed() {
            return;
        }
        if let Some(bytes) = body {
            observe_native(bytes, &self.metrics);
        }
    }

    /// Fire-and-forget: a resposta do corte já foi montada. `sampled` conta a
    /// amostra mesmo que a segunda request falhe depois (o erro tem contador
    /// próprio). `body` é o corpo REAL devolvido ao cliente (GET).
    pub fn spawn(&self, plan: CanaryPlan, body: Option<Bytes>) {
        let metrics = self.metrics.clone();
        tokio::spawn(async move {
            if let Some(bytes) = body.as_deref() {
                observe_native(bytes, &metrics);
            }
            match plan.mode {
                Mode::Frozen => run(plan, metrics).await,
                Mode::Direct => match body {
                    Some(bytes) => run_direct(plan, bytes, metrics).await,
                    None => {
                        metrics.inc(SAMPLED, 1);
                        metrics.inc(ERROR, 1);
                    }
                },
            }
        });
    }
}

/// Executa a amostra congelada: conta `sampled` e roda a comparação congelada.
pub(crate) async fn run(plan: CanaryPlan, metrics: CanaryMetrics) {
    metrics.inc(SAMPLED, 1);
    shadow::observe_frozen_request(&plan.request, &plan.encoded, metrics.inner(), NAMES).await;
}

/// Executa a amostra DIRETA: segunda request fresca ao Node (sem id, sem
/// captura) e comparação de identidade com o corpo real do corte.
pub(crate) async fn run_direct(plan: CanaryPlan, cut_body: Bytes, metrics: CanaryMetrics) {
    metrics.inc(SAMPLED, 1);
    match fetch_direct_body(&plan.request).await {
        Ok(node_body) => compare_direct(&node_body, &cut_body, &plan.encoded, &metrics),
        Err(err) => {
            eprintln!(
                "[canary] request direta falhou em {}: {err}",
                plan.request.path
            );
            metrics.inc(ERROR, 1);
        }
    }
}

/// SEGUNDA request, sem `X-Adom-Shadow-Id`: o Node roda no comportamento fresco
/// (`X-Adom-Shadow-Frozen: 1`) mas NÃO grava corpus. O corpo é o oráculo fresco.
async fn fetch_direct_body(req: &ShadowRequest) -> Result<Value, String> {
    let extra = [(
        HeaderName::from_static(shadow::SHADOW_FROZEN_HEADER),
        HeaderValue::from_static("1"),
    )];
    let bytes = shadow::get_node_body(req, &extra).await?;
    serde_json::from_slice(&bytes).map_err(|err| format!("direto: json {err}"))
}

/// Compara o corpo do Node (fresco) com o corpo do corte. Aviso/vazio do Node
/// não é comparável (§9.4 item 6); aviso no CORTE é divergência de verdade (o
/// Node tinha lista e o corte esvaziou) — não pula.
fn compare_direct(node: &Value, cut_body: &[u8], encoded: &str, metrics: &CanaryMetrics) {
    if shadow::notice_only(node) {
        eprintln!("[canary] Node devolveu aviso/coleta vazia: comparação pulada");
        metrics.inc(SKIPPED, 1);
        return;
    }
    let cut_value: Value = match serde_json::from_slice(cut_body) {
        Ok(value) => value,
        Err(err) => {
            eprintln!("[canary] corpo do corte inválido: {err}");
            metrics.inc(ERROR, 1);
            return;
        }
    };
    let node_resp: StreamResponse = match serde_json::from_value(node.clone()) {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("[canary] corpo do Node inválido: {err}");
            metrics.inc(ERROR, 1);
            return;
        }
    };
    let cut_resp: StreamResponse = match serde_json::from_value(cut_value) {
        Ok(resp) => resp,
        Err(err) => {
            eprintln!("[canary] corpo do corte inválido: {err}");
            metrics.inc(ERROR, 1);
            return;
        }
    };
    shadow::record_comparison_named(&node_resp, &cut_resp, Some(encoded), metrics.inner(), NAMES);
}

/// Contadores nativos de uma resposta do corte (Node fora da conta).
fn observe_native(body: &[u8], metrics: &CanaryMetrics) {
    metrics.inc(NATIVE_CUT, 1);
    match serde_json::from_slice::<Value>(body) {
        Ok(value) => {
            let count = value
                .get("streams")
                .and_then(Value::as_array)
                .map(|streams| streams.len())
                .unwrap_or(0) as u64;
            metrics.inc(NATIVE_STREAMS, count);
            if count == 0 {
                metrics.inc(NATIVE_EMPTY, 1);
            }
            if shadow::notice_only(&value) {
                metrics.inc(NATIVE_NOTICE, 1);
            }
        }
        Err(_) => metrics.inc(NATIVE_INVALID, 1),
    }
}

/// Caso a executar fora do caminho da resposta.
pub struct CanaryPlan {
    request: ShadowRequest,
    encoded: String,
    mode: Mode,
}

/// Monta o plano com parâmetros explícitos (testes). `percent` é reavaliado
/// aqui para o teste cobrir 0/50/100 sem tocar em env.
fn plan_parts(
    path: &str,
    headers: &HeaderMap,
    node_base: &Uri,
    mode: Mode,
    frozen_base: Option<PathBuf>,
    percent: u8,
    shadow_id: String,
) -> Option<CanaryPlan> {
    if !is_sampled(path, percent) {
        return None;
    }
    // A base só é exigida (e usada) no modo congelado; o direto compara o
    // corpo do Node e não precisa de corpus em disco.
    let frozen_base = match mode {
        Mode::Frozen => Some(frozen_base?),
        Mode::Direct => None,
    };
    let encoded = parse_stream_path(path)?.encoded.unwrap_or_default();
    let mut forwarded = crate::proxy::forward_headers(headers);
    // Headers da sombra são do gateway; cliente não os atravessa.
    forwarded.remove(HeaderName::from_static(shadow::SHADOW_ID_HEADER));
    forwarded.remove(HeaderName::from_static(shadow::SHADOW_FROZEN_HEADER));
    Some(CanaryPlan {
        request: ShadowRequest {
            path: path.to_string(),
            user_agent: header_text(headers, USER_AGENT),
            origin: crate::stream::request_origin(headers),
            shadow_id: Some(shadow_id),
            frozen_base,
            direct: mode == Mode::Direct,
            headers: forwarded,
            node_base: node_base.clone(),
        },
        encoded,
        mode,
    })
}

fn header_text(headers: &HeaderMap, name: HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

#[cfg(test)]
#[path = "canary_tests.rs"]
mod canary_tests;
