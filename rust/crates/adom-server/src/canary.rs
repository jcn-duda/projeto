//! Canário do CORTE nativo (`ROUTES_RUST=stream`) — instrumento F4.2 do §9.4.
//!
//! A sombra congelada (`stream-shadow`) não roda quando o corte está ligado: o
//! `proxy.rs` dá prioridade ao token `stream` e o cliente não passa pelo Node.
//! Sem outro instrumento, o corte fica sem alarme de divergência. Este módulo
//! amostra uma fração DETERMINÍSTICA das buscas do corte (default 0 = OFF),
//! dispara em `tokio::spawn` a MESMA segunda request congelada da sombra e
//! compara `streams` com o replay Rust, sem segurar o cliente e sem alterar a
//! resposta.
//!
//! Seleção: FNV-1a de 64 bits sobre o PATH (`/<config>/stream/<tipo>/<id>.json`,
//! que já inclui o segmento `encoded`) → `hash % 100 < percentual`. O mesmo path
//! cai sempre no mesmo balde (não repete/omite entre requisições); 0 nunca
//! amostra, 100 amostra todas.
//!
//! Requisitos operacionais (os mesmos da sombra congelada): o Node precisa de
//! `STREAM_FROZEN_MODE=shadow` + `STREAM_FROZEN_SHADOW_BASE` e o gateway de
//! `INTERNAL_SEARCH_URL` + `JACKETT_TEST_TOKEN` para hidratar `config.json`.
//! Sem a base congelada o canário fica inerte (não há como capturar o caso).

use std::collections::BTreeMap;
use std::path::PathBuf;

use axum::body::Body;
use http::header::{HeaderName, USER_AGENT};
use http::{HeaderMap, Request, Uri};

use adom_search::parse_stream_path;

use crate::shadow::{self, FrozenMetricNames, ShadowMetrics, ShadowRequest};

/// Percentual do canário (inteiro 0..100, default 0). Só age no corte.
pub const PERCENT_ENV: &str = "STREAM_CANARY_PERCENT";

/// Gauge (u64) com o percentual efetivo, sempre exposto em `/metrics`.
pub const PERCENT: &str = "stream.canary.percent";
/// Buscas efetivamente encaminhadas para a segunda request congelada.
pub const SAMPLED: &str = "stream.canary.sampled";
/// Comparações concluídas (denominador do alarme).
pub const COMPARED: &str = "stream.canary.compared";
/// 1 por busca que divergiu (independente da quantidade de itens).
pub const DIVERGENCE: &str = "stream.canary.divergence";
/// Soma dos itens divergentes (magnitude).
pub const DIVERGENCE_ITEMS: &str = "stream.canary.divergence.items";
/// Replay estourou o prazo.
pub const TIMEOUT: &str = "stream.canary.timeout";
/// Falha da segunda request/captura/replay; NUNCA conta como divergência.
pub const ERROR: &str = "stream.canary.error";
/// Amostra pulada por aviso/coleta vazia (§9.4 item 6) — não comparável.
pub const SKIPPED: &str = "stream.canary.skipped";

const KEYS: &[&str] = &[
    SAMPLED,
    COMPARED,
    DIVERGENCE,
    DIVERGENCE_ITEMS,
    TIMEOUT,
    ERROR,
    SKIPPED,
];

/// Nomes do mesmo comparador congelado, no namespace do canário.
pub const NAMES: FrozenMetricNames = FrozenMetricNames {
    label: "canary",
    compared: COMPARED,
    divergence: DIVERGENCE,
    divergence_items: DIVERGENCE_ITEMS,
    timeout: TIMEOUT,
    error: ERROR,
    skipped: Some(SKIPPED),
};

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
}

impl CanaryMetrics {
    pub fn new(percent: u8) -> Self {
        Self {
            counters: ShadowMetrics::default(),
            percent: percent.min(100),
        }
    }

    pub fn inner(&self) -> &ShadowMetrics {
        &self.counters
    }

    pub fn inc(&self, key: &str, by: u64) {
        self.counters.inc(key, by);
    }

    /// Snapshot para `/metrics`: chaves do canário (zeradas inclusive) +
    /// `stream.canary.percent`.
    pub fn snapshot(&self) -> BTreeMap<String, u64> {
        let mut snapshot = self.counters.snapshot();
        for key in KEYS {
            snapshot.entry((*key).to_string()).or_insert(0);
        }
        snapshot.insert(PERCENT.to_string(), u64::from(self.percent));
        snapshot
    }
}

/// Configuração + contadores do canário no `AppState`.
#[derive(Clone)]
pub struct Canary {
    percent: u8,
    /// Raiz da captura congelada (`STREAM_FROZEN_SHADOW_BASE`). Lida no boot;
    /// `None` = canário inerte (sem captura não há comparação).
    frozen_base: Option<PathBuf>,
    metrics: CanaryMetrics,
}

impl Canary {
    pub fn new(percent: u8) -> Self {
        Self::with_base(percent, None)
    }

    /// Configuração explícita (testes): percentual + base congelada.
    pub fn with_base(percent: u8, frozen_base: Option<PathBuf>) -> Self {
        let percent = percent.min(100);
        Self {
            percent,
            frozen_base,
            metrics: CanaryMetrics::new(percent),
        }
    }

    /// Lê `STREAM_CANARY_PERCENT` só quando o corte está ligado; fora dele o
    /// percentual fica 0 (a sombra continua sendo o instrumento do §9.4).
    /// A base congelada é lida uma vez no boot.
    pub fn from_env(stream_cut: bool) -> Self {
        if stream_cut {
            Self::with_base(percent_from_env(), crate::proxy::frozen_shadow_base())
        } else {
            Self::new(0)
        }
    }

    pub fn percent(&self) -> u8 {
        self.percent
    }

    pub fn frozen_base(&self) -> Option<&std::path::Path> {
        self.frozen_base.as_deref()
    }

    pub fn metrics(&self) -> &CanaryMetrics {
        &self.metrics
    }

    /// Planeja a amostra da requisição. `None` = não amostra, sem base
    /// congelada ou path inválido — nenhuma segunda request é feita.
    pub fn plan(&self, req: &Request<Body>, node_base: &Uri) -> Option<CanaryPlan> {
        let path = req.uri().path();
        if !is_sampled(path, self.percent) {
            return None;
        }
        let frozen_base = self.frozen_base.clone()?;
        plan_parts(
            path,
            req.headers(),
            node_base,
            Some(frozen_base),
            self.percent,
            crate::proxy::new_shadow_id(),
        )
    }

    /// Fire-and-forget: a resposta do corte já foi montada. `sampled` conta a
    /// amostra mesmo que a segunda request falhe depois (o erro tem contador
    /// próprio).
    pub fn spawn(&self, plan: CanaryPlan) {
        let metrics = self.metrics.clone();
        tokio::spawn(async move {
            run(plan, metrics).await;
        });
    }
}

/// Executa a amostra: conta `sampled` e roda a comparação congelada. Separado
/// de [`Canary::spawn`] para o teste chamar direto e observar as métricas.
pub(crate) async fn run(plan: CanaryPlan, metrics: CanaryMetrics) {
    metrics.inc(SAMPLED, 1);
    shadow::observe_frozen_request(&plan.request, &plan.encoded, metrics.inner(), NAMES).await;
}

/// Caso congelado a executar fora do caminho da resposta.
pub struct CanaryPlan {
    request: ShadowRequest,
    encoded: String,
}

/// Monta o plano com parâmetros explícitos (testes). `percent` é reavaliado
/// aqui para o teste cobrir 0/50/100 sem tocar em env.
fn plan_parts(
    path: &str,
    headers: &HeaderMap,
    node_base: &Uri,
    frozen_base: Option<PathBuf>,
    percent: u8,
    shadow_id: String,
) -> Option<CanaryPlan> {
    if !is_sampled(path, percent) {
        return None;
    }
    let frozen_base = frozen_base?;
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
            frozen_base: Some(frozen_base),
            headers: forwarded,
            node_base: node_base.clone(),
        },
        encoded,
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
