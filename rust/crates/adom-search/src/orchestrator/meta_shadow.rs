//! Sombra de METADADOS (C5): compara o nativo × `NodeMetaSource` para a MESMA
//! requisição, sem segurar o cliente.
//!
//! Liga por `META_RUST_SHADOW` (default OFF) e é INDEPENDENTE de `META_RUST`:
//!
//! - `META_RUST` OFF (default): a resposta sai do Node e a sombra roda o lado
//!   NATIVO contra o store (read-only quando o SQLite do Node está disponível);
//! - `META_RUST` ON: a resposta sai do nativo e a sombra roda a rota Node.
//!
//! A comparação NUNCA entra no caminho da resposta: o `resolve` devolve o
//! resultado do primário e o par é comparado em `tokio::spawn`, sob um prazo
//! próprio (`META_RUST_SHADOW_TIMEOUT_MS`). Falha/timeout do lado de referência
//! conta em `meta.shadow.error`/`timeout` — não é divergência.
//!
//! Amostragem: `META_RUST_SHADOW_PERCENT` (0..=100, default 100) escolhe a
//! requisição por hash FNV determinístico de `kind:id` (a mesma request cai
//! sempre do mesmo lado; não há sorteio por relógio). Requisição não amostrada
//! conta `meta.shadow.skipped_sample` e NÃO chama a referência.
//!
//! Contrato comparado (todos os campos que o build consome):
//! `name`, `names` (ORDEM incluída), `year`, `altYear`, coleção (raiz/query),
//! `homeReleaseAt`, `episodeAired` (ms) e as queries derivadas de título
//! pt-BR/original/varredura. `titles` (contexto DUAL) não entra: ele é
//! reconstruído do mesmo `pt/original/en` que já aparece em `names`/queries.
//!
//! Métricas em `/metrics`: `meta.shadow.compared`, `divergence`,
//! `divergence_fields`, `<campo>_divergence`, `timeout`, `error`, `skipped`,
//! `skipped_sample`.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::internal_routes::RouteFuture;
use super::meta::{MetaQuery, MetaSource, SearchMeta};

/// Env que liga a sombra de metadados.
pub const META_SHADOW_ENV: &str = "META_RUST_SHADOW";
/// Percentual amostrado (0..=100), default 100 quando a sombra está ligada.
pub const META_SHADOW_PERCENT_ENV: &str = "META_RUST_SHADOW_PERCENT";
/// Prazo do lado de referência (ms), default 5000.
pub const META_SHADOW_TIMEOUT_ENV: &str = "META_RUST_SHADOW_TIMEOUT_MS";

pub const COMPARED: &str = "meta.shadow.compared";
pub const DIVERGENCE: &str = "meta.shadow.divergence";
pub const DIVERGENCE_FIELDS: &str = "meta.shadow.divergence_fields";
pub const TIMEOUT: &str = "meta.shadow.timeout";
pub const ERROR: &str = "meta.shadow.error";
/// Primário falhou: não há par para comparar (não é divergência).
pub const SKIPPED: &str = "meta.shadow.skipped";
/// Fora da amostra (`META_RUST_SHADOW_PERCENT`).
pub const SKIPPED_SAMPLE: &str = "meta.shadow.skipped_sample";

pub const NAME_DIVERGENCE: &str = "meta.shadow.name_divergence";
pub const NAMES_DIVERGENCE: &str = "meta.shadow.names_divergence";
pub const YEAR_DIVERGENCE: &str = "meta.shadow.year_divergence";
pub const ALT_YEAR_DIVERGENCE: &str = "meta.shadow.alt_year_divergence";
pub const COLLECTION_DIVERGENCE: &str = "meta.shadow.collection_divergence";
pub const HOME_RELEASE_DIVERGENCE: &str = "meta.shadow.home_release_divergence";
pub const EPISODE_AIRED_DIVERGENCE: &str = "meta.shadow.episode_aired_divergence";
pub const PT_QUERY_DIVERGENCE: &str = "meta.shadow.pt_query_divergence";
pub const SWEEP_QUERY_DIVERGENCE: &str = "meta.shadow.sweep_query_divergence";
pub const ORIGINAL_QUERY_DIVERGENCE: &str = "meta.shadow.original_query_divergence";

const KEYS: &[&str] = &[
    COMPARED,
    DIVERGENCE,
    DIVERGENCE_FIELDS,
    TIMEOUT,
    ERROR,
    SKIPPED,
    SKIPPED_SAMPLE,
    NAME_DIVERGENCE,
    NAMES_DIVERGENCE,
    YEAR_DIVERGENCE,
    ALT_YEAR_DIVERGENCE,
    COLLECTION_DIVERGENCE,
    HOME_RELEASE_DIVERGENCE,
    EPISODE_AIRED_DIVERGENCE,
    PT_QUERY_DIVERGENCE,
    SWEEP_QUERY_DIVERGENCE,
    ORIGINAL_QUERY_DIVERGENCE,
];

/// Contadores da sombra de metadados. `Clone` barato (`Arc<Mutex<..>>`).
#[derive(Clone, Default)]
pub struct MetaShadowMetrics {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
}

impl MetaShadowMetrics {
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

static GLOBAL: OnceLock<MetaShadowMetrics> = OnceLock::new();

fn global_metrics() -> &'static MetaShadowMetrics {
    GLOBAL.get_or_init(MetaShadowMetrics::new)
}

/// Snapshot das métricas `meta.shadow.*` para a rota `/metrics` do gateway.
pub fn meta_shadow_metrics_snapshot() -> BTreeMap<String, u64> {
    global_metrics().snapshot()
}

/// `META_RUST_SHADOW` ligado? Ausente/vazio = OFF.
pub fn meta_shadow_enabled() -> bool {
    std::env::var(META_SHADOW_ENV)
        .map(|raw| super::meta_native::flag_enabled(&raw))
        .unwrap_or(false)
}

/// Percentual amostrado (default 100 quando a sombra está ligada). Fora da
/// faixa é grampeado; valor não numérico cai no default.
pub fn meta_shadow_percent_from(raw: Option<&str>) -> u8 {
    raw.and_then(|raw| raw.trim().parse::<i64>().ok())
        .map(|value| value.clamp(0, 100) as u8)
        .unwrap_or(100)
}

/// Prazo do lado de referência; default 5000 ms, piso 1.
pub fn meta_shadow_timeout_ms_from(raw: Option<&str>) -> i64 {
    raw.and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(5_000)
}

/// FNV-1a 64 — determinístico e barato; a MESMA request cai sempre do mesmo
/// lado da amostra (nada de `rand`, nada de relógio).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A requisição entra na amostra? `0` = nunca, `100` = sempre.
pub fn sample_includes(percent: u8, kind: &str, id: &str) -> bool {
    if percent == 0 {
        return false;
    }
    if percent >= 100 {
        return true;
    }
    fnv1a(&format!("{kind}:{id}")) % 100 < u64::from(percent)
}

/// Campos divergentes entre os dois lados.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct MetaComparison {
    pub name: bool,
    pub names: bool,
    pub year: bool,
    pub alt_year: bool,
    pub collection: bool,
    pub home_release: bool,
    pub episode_aired: bool,
    pub pt_query: bool,
    pub sweep_query: bool,
    pub original_query: bool,
}

impl MetaComparison {
    pub fn fields(&self) -> u64 {
        [
            self.name,
            self.names,
            self.year,
            self.alt_year,
            self.collection,
            self.home_release,
            self.episode_aired,
            self.pt_query,
            self.sweep_query,
            self.original_query,
        ]
        .iter()
        .filter(|diverged| **diverged)
        .count() as u64
    }

    pub fn diverged(&self) -> bool {
        self.fields() > 0
    }
}

/// Compara dois [`SearchMeta`] campo a campo. PURA.
pub fn compare_meta(primary: &SearchMeta, reference: &SearchMeta) -> MetaComparison {
    MetaComparison {
        name: primary.name != reference.name,
        names: primary.names != reference.names,
        year: primary.year_text() != reference.year_text(),
        alt_year: primary.alt_year != reference.alt_year,
        collection: primary.multi_work_root != reference.multi_work_root
            || primary.multi_work_query != reference.multi_work_query,
        home_release: primary.home_release_at != reference.home_release_at,
        episode_aired: primary.episode_aired_at_ms != reference.episode_aired_at_ms,
        pt_query: primary.pt_query != reference.pt_query,
        sweep_query: primary.sweep_query != reference.sweep_query,
        original_query: primary.original_query != reference.original_query,
    }
}

/// Envolve o primário com a sombra. A referência (`other`) roda só em
/// background: nenhuma requisição espera por ela.
pub fn wrap_meta_with_shadow(
    primary: Arc<dyn MetaSource>,
    reference: Arc<dyn MetaSource>,
    percent: u8,
    timeout_ms: i64,
) -> Arc<dyn MetaSource> {
    Arc::new(MetaShadowSource {
        primary,
        reference,
        metrics: global_metrics().clone(),
        percent,
        timeout_ms: timeout_ms.max(1),
    })
}

struct MetaShadowSource {
    primary: Arc<dyn MetaSource>,
    reference: Arc<dyn MetaSource>,
    metrics: MetaShadowMetrics,
    percent: u8,
    timeout_ms: i64,
}

impl MetaSource for MetaShadowSource {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        let primary = self.primary.clone();
        let reference = self.reference.clone();
        let metrics = self.metrics.clone();
        let percent = self.percent;
        let timeout_ms = self.timeout_ms;
        Box::pin(async move {
            if !sample_includes(percent, &req.kind, &req.id) {
                metrics.inc(SKIPPED_SAMPLE, 1);
                return primary.resolve(req).await;
            }
            let result = primary.resolve(req.clone()).await;
            let para_comparar = result.clone();
            tokio::spawn(async move {
                run_reference(reference, req, para_comparar, metrics, timeout_ms).await;
            });
            result
        })
    }
}

async fn run_reference(
    reference: Arc<dyn MetaSource>,
    req: MetaQuery,
    primary: Result<SearchMeta, String>,
    metrics: MetaShadowMetrics,
    timeout_ms: i64,
) {
    let Ok(primary) = primary else {
        // Primário falhou: nada a comparar (o fallback do orquestrador decide a
        // resposta, não a sombra).
        metrics.inc(SKIPPED, 1);
        return;
    };
    let future = reference.resolve(req);
    match tokio::time::timeout(Duration::from_millis(timeout_ms as u64), future).await {
        Err(_) => {
            metrics.inc(TIMEOUT, 1);
            eprintln!("[meta-shadow] referência não respondeu no prazo (não é divergência)");
        }
        Ok(Err(err)) => {
            metrics.inc(ERROR, 1);
            eprintln!("[meta-shadow] referência falhou: {err} (não é divergência)");
        }
        Ok(Ok(reference)) => {
            record_comparison(&primary, &reference, &metrics);
        }
    }
}

/// Compara e contabiliza UM par. `compared` só sobe com os dois lados OK.
fn record_comparison(
    primary: &SearchMeta,
    reference: &SearchMeta,
    metrics: &MetaShadowMetrics,
) -> MetaComparison {
    metrics.inc(COMPARED, 1);
    let comparison = compare_meta(primary, reference);
    for (diverged, key) in [
        (comparison.name, NAME_DIVERGENCE),
        (comparison.names, NAMES_DIVERGENCE),
        (comparison.year, YEAR_DIVERGENCE),
        (comparison.alt_year, ALT_YEAR_DIVERGENCE),
        (comparison.collection, COLLECTION_DIVERGENCE),
        (comparison.home_release, HOME_RELEASE_DIVERGENCE),
        (comparison.episode_aired, EPISODE_AIRED_DIVERGENCE),
        (comparison.pt_query, PT_QUERY_DIVERGENCE),
        (comparison.sweep_query, SWEEP_QUERY_DIVERGENCE),
        (comparison.original_query, ORIGINAL_QUERY_DIVERGENCE),
    ] {
        if diverged {
            metrics.inc(key, 1);
        }
    }
    let fields = comparison.fields();
    metrics.inc(DIVERGENCE_FIELDS, fields);
    if comparison.diverged() {
        metrics.inc(DIVERGENCE, 1);
        eprintln!(
            "[meta-shadow] divergência em {} campo(s): {}",
            fields,
            summarize(primary, reference, &comparison)
        );
    }
    comparison
}

fn summarize(primary: &SearchMeta, reference: &SearchMeta, comparison: &MetaComparison) -> String {
    let mut out: Vec<String> = Vec::new();
    if comparison.name {
        out.push(format!("name={:?}×{:?}", primary.name, reference.name));
    }
    if comparison.names {
        out.push(format!("names={:?}×{:?}", primary.names, reference.names));
    }
    if comparison.year {
        out.push(format!(
            "year={}×{}",
            primary.year_text(),
            reference.year_text()
        ));
    }
    if comparison.collection {
        out.push(format!(
            "collection={:?}×{:?}",
            primary.multi_work_root, reference.multi_work_root
        ));
    }
    if comparison.home_release {
        out.push(format!(
            "home={:?}×{:?}",
            primary.home_release_at, reference.home_release_at
        ));
    }
    if comparison.episode_aired {
        out.push(format!(
            "episodeAired={:?}×{:?}",
            primary.episode_aired_at_ms, reference.episode_aired_at_ms
        ));
    }
    out.join(" ")
}

#[cfg(test)]
#[path = "meta_shadow_tests.rs"]
mod tests;
