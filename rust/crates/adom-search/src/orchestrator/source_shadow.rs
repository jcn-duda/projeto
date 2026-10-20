//! Sombra de FONTE (F2.1/F2.2): compara o coletor nativo com o `NodeCollector`
//! para o MESMO [`CollectJob`], sem tocar store/debrid/tail/efeitos.
//!
//! Liga por `SOURCES_RUST_SHADOW` (CSV, default vazio). Fontes com sombra:
//! `jackett` e `prowlarr`; Torrentio/BLUDV/Mico são registrados como ignorados
//! (log de boot) e NÃO rodam sombra até a normalização de identidade. Fonte que
//! já está em `SOURCES_RUST` também é ignorada - o corte nativo dela está
//! ativo, não é sombra.
//!
//! O coletor de produção responde normalmente; as comparações correm em
//! `tokio::spawn` e só alimentam métricas/log. O lado Node roda em
//! `read_only` (sem conta, banco, status/breaker nem cache bruto).
//!
//! Contrato comparado, por indexer:
//!
//! - conjunto de `info_hash` normalizado (itens de conta excluídos - o Node
//!   sempre roda inventário e o nativo não);
//! - `live.failed`/`pending`/`empty` e o agregado `all` (só quando AMBOS os
//!   lados têm veredito; `Unknown` = ramo `/all` ausente, não divergência).
//!
//! **Live do Prowlarr não é comparado:** o `collectRawLive` do Node só emite
//! `onQueryResult` para Jackett (por indexer) e Mico, então a referência
//! read-only do Prowlarr sai vazia. Comparar o live nativo (por FONTE) com
//! esse vazio daria divergência FALSA; a sombra dele compara a IDENTIDADE
//! (hashes por `_indexer`/tracker). O `live` nativo vale na produção com
//! `SOURCES_RUST=prowlarr`; quando o Node prometer o contrato, o flag
//! `compare_live` do par liga sem mexer no coletor.
//!
//! `partial` NÃO é divergência de fonte: é a janela de coleta do Node. Quando
//! difere, só incrementa `source.shadow.partial_divergence` (informativa) e
//! NÃO soma em `source.shadow.divergence`; `source.shadow.compared` continua
//! contando o par comparado, com a diferença de `partial` registrada à parte.
//!
//! Elegibilidade: a rota Node devolve `eligible:false` quando a fonte não está
//! nos `providers` efetivos; o pair pula a comparação e conta
//! `source.shadow.skipped` (sem `compared`/`divergence`). O nativo da sombra
//! roda `shadow` (ignora o breaker e não o registra), mas ainda produz live
//! a partir dos outcomes `primary` — inclusive os marcados `record_status:false`.
//! Sweep inline/tardio é secundário e NÃO entra no live da sombra: não mascara
//! falha principal nem inventa falha. `late_sweep` nem roda sombra
//! (`source.shadow.skipped_late`).
//!
//! Seleção de indexers (C0b): a referência usa o `ji` da REQUEST que viaja no
//! [`CollectJob`]; só sem `ji` (instalação sem seleção) cai no
//! `JACKETT_INDEXERS` do processo. Os dois lados consultam o mesmo conjunto.

use std::sync::Arc;
use std::time::Duration;

use adom_sources::now_ms;

use crate::orchestrator::collect::{CollectBatch, CollectJob, Collector, NodeCollector};
use crate::orchestrator::internal_routes::InternalRoutes;
use crate::orchestrator::jackett_collector::JackettCollector;
use crate::orchestrator::prowlarr_collector::ProwlarrCollector;

#[path = "source_shadow_compare.rs"]
mod compare;
pub use compare::{compare_batches, compare_batches_opts, ShadowComparison};

#[path = "source_shadow_metrics.rs"]
mod metrics;
use metrics::global_metrics;
pub use metrics::{
    source_shadow_metrics_snapshot, SourceShadowMetrics, COMPARED, DIVERGENCE, ERROR, ITEMS_EXTRA,
    ITEMS_MISSING, LIVE_DIVERGENCE, PARTIAL_DIVERGENCE, SKIPPED, SKIPPED_LATE, TIMEOUT,
};

/// Env que liga a sombra de fonte (CSV dos tokens nativos).
pub const SOURCE_SHADOW_ENV: &str = "SOURCES_RUST_SHADOW";
/// Env do corte nativo - fonte presente aqui não roda sombra.
pub const SOURCES_ENV: &str = "SOURCES_RUST";

#[path = "source_shadow_sources.rs"]
mod sources;
use sources::has_live_reference;
use sources::ignored_shadow_tokens;
pub use sources::shadow_sources;

/// Fontes que o Node conhece no collect (usado para `skip_sources`).
const NODE_SOURCES: &[&str] = &["jackett", "prowlarr", "torrentio", "bludv", "mico"];

fn sources_from_env() -> Vec<&'static str> {
    let shadow = std::env::var(SOURCE_SHADOW_ENV).unwrap_or_default();
    let sources = std::env::var(SOURCES_ENV).unwrap_or_default();
    let ignored = ignored_shadow_tokens(&shadow, &sources);
    if !ignored.is_empty() {
        eprintln!(
            "[source-shadow] ignorado(s) em {SOURCE_SHADOW_ENV}: {} \
             (sombra: jackett,prowlarr)",
            ignored.join(",")
        );
    }
    shadow_sources(&shadow, &sources)
}

/// Envolve o coletor de produção quando `SOURCES_RUST_SHADOW` pedir fontes.
///
/// Sem rotas internas do Node não há com o que comparar: devolve o coletor
/// original (log de aviso). Falha ao montar um cliente nativo também só remove
/// aquela fonte da sombra - nunca derruba a busca.
pub fn wrap_collector_with_source_shadow(
    primary: Arc<dyn Collector>,
    routes: Option<Arc<dyn InternalRoutes>>,
) -> Arc<dyn Collector> {
    let sources = sources_from_env();
    if sources.is_empty() {
        return primary;
    }
    let Some(routes) = routes else {
        eprintln!(
            "[source-shadow] SOURCES_RUST_SHADOW={} sem rotas Node - sombra desligada",
            sources.join(",")
        );
        return primary;
    };

    let mut pairs = Vec::new();
    for source in sources {
        match native_collector(source) {
            Ok(native) => {
                // O Node da sombra roda SÓ a fonte comparada, em READ-ONLY:
                // sem inventário da conta, captura/banco, status/breaker ou
                // cache bruto. As demais fontes ficam em `skip_sources` para
                // não poluir o conjunto comparado. O `ji` da request viaja no
                // job (C0b); o override do processo é só fallback do Jackett.
                let node = Arc::new(node_collector_for_source(
                    routes.clone(),
                    source,
                    native.indexers,
                ));
                pairs.push(ShadowPair {
                    source,
                    native: native.collector,
                    node,
                    compare_live: has_live_reference(source),
                });
            }
            Err(err) => eprintln!("[source-shadow] {source}: coletor nativo indisponível: {err}"),
        }
    }
    if pairs.is_empty() {
        return primary;
    }
    eprintln!(
        "[source-shadow] armado: {} (compare-only)",
        pairs
            .iter()
            .map(|pair| pair.source)
            .collect::<Vec<_>>()
            .join("+")
    );
    Arc::new(SourceShadowCollector {
        primary,
        pairs,
        metrics: global_metrics().clone(),
    })
}

/// Coletor nativo da sombra + o override de indexers do `NodeCollector`.
struct NativeShadow {
    collector: Arc<dyn Collector>,
    /// `Some` só para o Jackett (`JACKETT_INDEXERS` do processo); `None` para
    /// fontes que não têm indexers (Prowlarr) — aí a referência usa o `ji` do
    /// job, sem override.
    indexers: Option<Vec<String>>,
}

/// Coletor nativo da sombra. O Jackett entra em modo sombra (ignora breaker e
/// não registra status); o Prowlarr não tem breaker/status e usa o cliente
/// normal.
fn native_collector(source: &str) -> Result<NativeShadow, String> {
    match source {
        "jackett" => {
            let collector = JackettCollector::from_env()
                .map_err(|err| format!("JackettClient: {err}"))?
                .with_shadow(true);
            let indexers = collector.client().config().indexers.clone();
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: Some(indexers),
            })
        }
        "prowlarr" => {
            let collector =
                ProwlarrCollector::from_env().map_err(|err| format!("ProwlarrClient: {err}"))?;
            Ok(NativeShadow {
                collector: Arc::new(collector),
                indexers: None,
            })
        }
        other => Err(format!("fonte sem sombra: {other}")),
    }
}

/// O `NodeCollector` de referência da sombra: só a fonte comparada e sem
/// efeitos (`read_only`). `skip_sources` lista todas as outras fontes do Node;
/// `indexers` (quando presente) é o FALLBACK do `ji` (vale só quando o job não
/// traz seleção) — o C0b passou a mandar a seleção da request pelo job.
fn node_collector_for_source(
    routes: Arc<dyn InternalRoutes>,
    source: &str,
    indexers: Option<Vec<String>>,
) -> NodeCollector {
    let skip_sources: Vec<String> = NODE_SOURCES
        .iter()
        .filter(|token| **token != source)
        .map(|token| (*token).to_string())
        .collect();
    let collector = NodeCollector::new(routes)
        .with_skip_sources(skip_sources)
        .with_read_only(true)
        .with_shadow_source(source);
    match indexers {
        Some(indexers) => collector.with_indexers_override(indexers),
        None => collector,
    }
}

/// Lado Node da sombra: além do lote, entrega a elegibilidade da fonte.
/// Abstração pequena para o teste exercitar o skip sem montar rotas HTTP.
type ReferenceFuture<'a> = std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<(CollectBatch, bool), String>> + Send + 'a>,
>;

trait ReferenceCollector: Send + Sync {
    fn reference<'a>(&'a self, job: CollectJob) -> ReferenceFuture<'a>;
}

impl ReferenceCollector for NodeCollector {
    fn reference<'a>(&'a self, job: CollectJob) -> ReferenceFuture<'a> {
        Box::pin(async move { self.collect_reference(job).await })
    }
}

#[derive(Clone)]
struct ShadowPair {
    source: &'static str,
    native: Arc<dyn Collector>,
    node: Arc<dyn ReferenceCollector>,
    /// Só quando o Node promete `live` para esta fonte (`has_live_reference`).
    compare_live: bool,
}

/// Coletor de produção com sombra fire-and-forget: a resposta usa SEMPRE o
/// coletor primário; a sombra roda no mesmo job e só registra métricas.
pub struct SourceShadowCollector {
    primary: Arc<dyn Collector>,
    pairs: Vec<ShadowPair>,
    metrics: SourceShadowMetrics,
}

impl Collector for SourceShadowCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<CollectBatch, String>> + Send + 'a>,
    > {
        Box::pin(async move {
            for pair in &self.pairs {
                let pair = pair.clone();
                let job = job.clone();
                let metrics = self.metrics.clone();
                tokio::spawn(async move {
                    run_pair(pair, job, metrics).await;
                });
            }
            self.primary.collect(job).await
        })
    }
}

async fn run_pair(pair: ShadowPair, job: CollectJob, metrics: SourceShadowMetrics) {
    let source = pair.source;
    // Varredura tardia não é consulta principal: sem sombra (não compara,
    // não conta divergência e não mexe em compared).
    if job.late_sweep {
        metrics.inc(SKIPPED_LATE, 1);
        eprintln!("[source-shadow] {source}: late_sweep pulado (não é consulta principal)");
        return;
    }
    let native_collector = pair.native.clone();
    let node_collector = pair.node.clone();
    let deadline = job.deadline_at;
    let native = native_collector.collect(job.clone());
    let node = node_collector.reference(job);
    let both = async move { tokio::join!(native, node) };
    let left = deadline.saturating_sub(now_ms()).max(1) as u64;

    match tokio::time::timeout(Duration::from_millis(left), both).await {
        Err(_) => {
            metrics.inc(TIMEOUT, 1);
            eprintln!("[source-shadow] {source}: timeout sem comparação (não é divergência)");
        }
        Ok((Ok(_), Ok((_, false)))) => {
            // Fonte fora dos `providers` efetivos: o vazio é proposital e não
            // há referência válida. Não compara e não conta divergência.
            metrics.inc(SKIPPED, 1);
            eprintln!(
                "[source-shadow] {source}: pulado (fonte ausente dos providers; \
                 não conta como divergência)"
            );
        }
        Ok((Ok(native), Ok((node, true)))) => {
            if pair.compare_live {
                record_comparison(source, &native, &node, &metrics);
            } else {
                record_comparison_opts(source, &native, &node, &metrics, false);
            }
        }
        Ok((native, node)) => {
            // `source.shadow.timeout` é SÓ o prazo do PAR (wrapper acima).
            // Timeout de UM indexer chega como `Failed` nos dois lotes e é
            // comparado normalmente — não vira timeout da sombra.
            let node = node.map(|(batch, _)| batch);
            let reason = describe_error(&native, &node);
            metrics.inc(ERROR, 1);
            eprintln!("[source-shadow] {source}: {reason} (não é divergência)");
        }
    }
}

fn describe_error(
    native: &Result<CollectBatch, String>,
    node: &Result<CollectBatch, String>,
) -> String {
    match (native, node) {
        (Err(err), _) => format!("erro nativo: {err}"),
        (_, Err(err)) => format!("erro Node: {err}"),
        _ => "erro desconhecido".to_string(),
    }
}

/// Compara e contabiliza UM par. `compared` só sobe com os dois lados OK.
fn record_comparison(
    source: &str,
    native: &CollectBatch,
    node: &CollectBatch,
    metrics: &SourceShadowMetrics,
) -> ShadowComparison {
    record_comparison_opts(source, native, node, metrics, true)
}

/// Variante que decide se o `live` entra na comparação. Fonte sem contrato de
/// `live` no Node (Prowlarr) compara só identidade — o live nativo dela não
/// tem referência e nunca pode virar divergência.
fn record_comparison_opts(
    source: &str,
    native: &CollectBatch,
    node: &CollectBatch,
    metrics: &SourceShadowMetrics,
    compare_live: bool,
) -> ShadowComparison {
    metrics.inc(COMPARED, 1);
    let comparison = if compare_live {
        compare_batches(native, node)
    } else {
        compare_batches_opts(native, node, false)
    };
    metrics.inc(ITEMS_MISSING, comparison.missing_count);
    metrics.inc(ITEMS_EXTRA, comparison.extra_count);
    if comparison.live_divergence {
        metrics.inc(LIVE_DIVERGENCE, 1);
    }
    if comparison.partial_divergence {
        // Informativa: janela do Node ≠ divergência de fonte.
        metrics.inc(PARTIAL_DIVERGENCE, 1);
    }
    if comparison.diverged() {
        metrics.inc(DIVERGENCE, 1);
        eprintln!(
            "[source-shadow] {source}: divergência {}",
            summarize(&comparison)
        );
    }
    comparison
}

fn summarize(comparison: &ShadowComparison) -> String {
    format!(
        "faltando={} extra={} live={} partial={}",
        comparison.missing_count,
        comparison.extra_count,
        comparison.live_divergence,
        comparison.partial_divergence
    )
}

#[cfg(test)]
#[path = "source_shadow_test_support.rs"]
mod test_support;

#[cfg(test)]
#[path = "source_shadow_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "source_shadow_metrics_tests.rs"]
mod metrics_tests;
