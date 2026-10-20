//! Sombra da checagem AllDebrid (`DEBRID_AL_RUST=shadow`): nativo × Node.
//!
//! A nativa é o lado VIVO (é ela que responde ao build quando o caminho
//! nativo está ligado). O Node entra como REFERÊNCIA, em thread própria e
//! DEPOIS da resposta — o cliente nunca espera a comparação. Só há par quando
//! o Node deu veredito utilizável (`known:true`, sem `unusable`); referência
//! degradada conta `skipped`/`error`/`timeout`, nunca divergência.
//!
//! Custo: a consulta da AllDebrid é um upload real; a referência Node envia o
//! lote de novo. A amostra (`DEBRID_AL_SHADOW_PERCENT`, default 100) e o teto
//! (`DEBRID_AL_SHADOW_MAX_HASHES`, default 50) limitam esse custo. Nenhum dos
//! dois lados limpa a conta: a nativa é read-only e o
//! `/internal/debrid/check` do Node também não limpa (a limpeza do Node só
//! acontece dentro da busca dele).
//!
//! Métricas: `debrid.al.shadow.*` (ver `debrid_al_metrics.rs`).

use std::collections::BTreeSet;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use adom_debrid::alldebrid_mode::{
    sample_includes, shadow_max_hashes_from, shadow_percent_from, shadow_timeout_ms_from,
    SHADOW_MAX_HASHES_ENV, SHADOW_PERCENT_ENV, SHADOW_TIMEOUT_ENV,
};
use adom_debrid::verdict::CheckOutcome;

use super::debrid_al_metrics as metrics;

/// Chamada bloqueante da referência Node (`FallbackCheck::check`).
pub type ReferenceCall = Box<dyn FnOnce() -> Result<CheckOutcome, String> + Send>;

pub struct ReferenceConfig {
    /// Veredito da nativa que o build já consumiu.
    pub native: CheckOutcome,
    /// Hashes efetivamente comparados (subconjunto ≤ teto da sombra).
    pub hashes: Vec<String>,
    /// Chamada da referência Node; não roda no caminho da resposta.
    pub reference: ReferenceCall,
}

/// Dispara a comparação em fundo (thread, independente de runtime tokio — o
/// `FallbackCheck` é síncrono).
pub fn spawn(cfg: ReferenceConfig) {
    std::thread::spawn(move || run(cfg));
}

/// Corpo síncrono da sombra (testável sem esperar thread).
pub fn run(cfg: ReferenceConfig) {
    let metrics = metrics::global_metrics();
    let percent = shadow_percent_from(std::env::var(SHADOW_PERCENT_ENV).ok().as_deref());
    if !sample_includes(percent, &cfg.hashes) {
        metrics.inc(metrics::SKIPPED_SAMPLE, 1);
        return;
    }
    let timeout = Duration::from_millis(shadow_timeout_ms_from(
        std::env::var(SHADOW_TIMEOUT_ENV).ok().as_deref(),
    ));
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send((cfg.reference)());
    });
    let started = Instant::now();
    match rx.recv_timeout(timeout) {
        Ok(Ok(node)) => compare_and_count(&cfg.native, &node, &cfg.hashes, started),
        Ok(Err(error)) => {
            metrics.inc(metrics::ERROR, 1);
            eprintln!("[debrid-shadow] referência Node falhou: {error}");
        }
        Err(_) => {
            metrics.inc(metrics::TIMEOUT, 1);
            eprintln!("[debrid-shadow] referência Node estourou {timeout:?}");
        }
    }
}

fn compare_and_count(
    native: &CheckOutcome,
    node: &CheckOutcome,
    hashes: &[String],
    started: Instant,
) {
    let metrics = metrics::global_metrics();
    if native.unusable.is_some() || !native.known || node.unusable.is_some() || !node.known {
        // Sem veredito fechado dos DOIS lados não há par: "não sei" de um lado
        // não é divergência de cache.
        metrics.inc(metrics::SKIPPED, 1);
        return;
    }
    let (missing, extra) = compare(native, node, hashes);
    metrics.inc(metrics::COMPARED, 1);
    if missing > 0 || extra > 0 {
        metrics.inc(metrics::DIVERGENCE, 1);
        metrics.inc(metrics::ITEMS_MISSING, missing as u64);
        metrics.inc(metrics::ITEMS_EXTRA, extra as u64);
        eprintln!(
            "[debrid-shadow] divergência: nativo={} node={} faltando_no_nativo={missing} \
             sobrando_no_nativo={extra} ref_ms={}",
            native.cached.len(),
            node.cached.len(),
            started.elapsed().as_millis()
        );
    }
}

/// Prazo ABSOLUTO da referência Node. A sombra roda DEPOIS da resposta, então
/// o `deadline_at` da busca já pode ter vencido; a referência ganha o próprio
/// teto (`DEBRID_AL_SHADOW_TIMEOUT_MS`).
pub fn fresh_deadline_ms() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let timeout = shadow_timeout_ms_from(std::env::var(SHADOW_TIMEOUT_ENV).ok().as_deref());
    now.saturating_add(timeout as i64)
}

/// Hashes que a sombra realmente compara. O teto limita o custo do upload
/// extra; o resultado nativo é filtrado pelo MESMO conjunto, senão hash não
/// perguntado viraria divergência falsa.
pub fn probe_hashes(hashes: &[String]) -> Vec<String> {
    let max = shadow_max_hashes_from(std::env::var(SHADOW_MAX_HASHES_ENV).ok().as_deref());
    hashes.iter().take(max).cloned().collect()
}

/// `(faltando no nativo, sobrando no nativo)` restrito a `hashes`.
pub fn compare(native: &CheckOutcome, node: &CheckOutcome, hashes: &[String]) -> (usize, usize) {
    let probe: BTreeSet<String> = hashes.iter().map(|h| h.to_lowercase()).collect();
    let native_set: BTreeSet<String> = native
        .cached
        .iter()
        .map(|h| h.to_lowercase())
        .filter(|h| probe.contains(h))
        .collect();
    let node_set: BTreeSet<String> = node
        .cached
        .iter()
        .map(|h| h.to_lowercase())
        .filter(|h| probe.contains(h))
        .collect();
    (
        node_set.difference(&native_set).count(),
        native_set.difference(&node_set).count(),
    )
}

/// Contabiliza uma checagem nativa do caminho vivo (`on`/`shadow`).
pub fn note_native(check: &adom_debrid::verdict::ServiceCheck) {
    let metrics = metrics::global_metrics();
    metrics.inc(metrics::NATIVE_CHECKS, 1);
    if check.outcome.unusable.is_some() {
        metrics.inc(metrics::NATIVE_UNUSABLE, 1);
    }
    if !check.outcome.known {
        metrics.inc(metrics::NATIVE_KNOWN_FALSE, 1);
    }
}

/// O caminho nativo não conseguiu nem enviar o upload e caiu no Node.
pub fn note_fallback() {
    metrics::global_metrics().inc(metrics::NATIVE_FALLBACK, 1);
}

/// Atalho para o snapshot do gateway.
pub use super::debrid_al_metrics::debrid_al_metrics_snapshot;

#[cfg(test)]
#[path = "debrid_shadow_tests.rs"]
mod debrid_shadow_tests;
