//! Configuração do colhedor nativo — MESMOS nomes e defaults de
//! `src/config/harvest.ts`.
//!
//! Não existe env de rollback: o worker é incondicional. Só
//! `HARVEST_ENABLED=false` desliga (como no Node), e nesse caso o gateway
//! não sobe a thread.
//!
//! `JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS` mora aqui porque é **só** do
//! colhedor: o orçamento dedicado dos indexers index-only. A régua é a mesma
//! de `src/config/jackett.ts` (default 90 s, clamp 5 s..120 s).

/// Defaults e leitura de ambiente do colhedor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarvestConfig {
    pub enabled: bool,
    pub interval_ms: u64,
    pub idle_window_ms: i64,
    pub max_per_hour: u32,
    pub indexer_delay_ms: u64,
    pub queue_max: usize,
    pub entry_ttl: u64,
    pub drain_max_works: usize,
    pub queue_preview: usize,
    /// `HARVEST_BR_FIRST` — priorização por evidência BR (default true).
    pub br_first: bool,
    /// `HARVEST_BR_MAX_WAIT_MS` — anti-fome do tier regular (`0` = off).
    pub br_max_wait_ms: i64,
    /// Orçamento dos indexers index-only (só a consulta de colheita).
    pub index_only_harvest_timeout_ms: u64,
}

impl Default for HarvestConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_ms: 60_000,
            idle_window_ms: 600_000,
            max_per_hour: 120,
            indexer_delay_ms: 1_500,
            queue_max: 200,
            entry_ttl: 604_800,
            drain_max_works: 5,
            queue_preview: 8,
            br_first: true,
            br_max_wait_ms: 6 * 3600 * 1000,
            index_only_harvest_timeout_ms: 90_000,
        }
    }
}

impl HarvestConfig {
    /// Lê `HARVEST_*` do ambiente. Valor ausente/ilegível cai no default do TS
    /// (o `num(env, default)` devolve o default para `NaN`).
    pub fn from_env() -> Self {
        let drain_max_works = num_or("HARVEST_DRAIN_MAX_WORKS", 5.0).trunc();
        let queue_preview = num_or("HARVEST_QUEUE_PREVIEW", 8.0).trunc();
        let timeout = num_or("JACKETT_INDEX_ONLY_HARVEST_TIMEOUT_MS", 90_000.0);
        Self {
            enabled: bool_or("HARVEST_ENABLED", true),
            // O TS não clampeia o intervalo; um valor 0 é aceito e o loop
            // aplica o piso de 1 ms no `sleep`.
            interval_ms: num_or("HARVEST_INTERVAL_MS", 60_000.0).max(0.0) as u64,
            idle_window_ms: num_or("HARVEST_IDLE_WINDOW_MS", 600_000.0).max(0.0) as i64,
            max_per_hour: num_or("HARVEST_MAX_HOUR", 120.0).max(0.0) as u32,
            indexer_delay_ms: num_or("HARVEST_INDEXER_DELAY_MS", 1_500.0).max(0.0) as u64,
            queue_max: num_or("HARVEST_QUEUE_MAX", 200.0).max(0.0) as usize,
            entry_ttl: num_or("HARVEST_ENTRY_TTL", 604_800.0).max(0.0) as u64,
            drain_max_works: drain_max_works.max(1.0) as usize,
            queue_preview: queue_preview.max(0.0) as usize,
            br_first: bool_or("HARVEST_BR_FIRST", true),
            br_max_wait_ms: num_or("HARVEST_BR_MAX_WAIT_MS", 21_600_000.0).max(0.0) as i64,
            index_only_harvest_timeout_ms: timeout.clamp(5_000.0, 120_000.0) as u64,
        }
    }
}

/// `String(env || 'true') === 'true'` do TS.
fn bool_or(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(raw) => raw.trim() == "true",
        Err(_) => default,
    }
}

/// `BR_PROBE_TTL_S` — TTL do registro da sonda (`autofetch:v3:probe:<sha>`).
/// Mesma régua de `src/config/debrid.ts`: default 12 h, piso de 60 s.
///
/// A sonda é gravada pelo colhedor (`Settler`), então o TTL tem que sair
/// daqui: `DEFAULT_PROBE_TTL_SECONDS` fixo no loop ignorava o env e o Node
/// (`brProbeTtl`) lia um registro com prazo diferente do que escreveu.
pub(crate) fn br_probe_ttl_seconds() -> u64 {
    clamp_probe_ttl(num_or("BR_PROBE_TTL_S", 43_200.0))
}

/// `Math.max(60, trunc(n))` do Node.
fn clamp_probe_ttl(value: f64) -> u64 {
    value.max(60.0) as u64
}

/// `Number(env)` com fallback para `NaN` (default do TS).
fn num_or(key: &str, default: f64) -> f64 {
    let Ok(raw) = std::env::var(key) else {
        return default;
    };
    match raw.trim().parse::<f64>() {
        Ok(value) if value.is_finite() => value,
        _ => default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_batem_com_o_node() {
        let cfg = HarvestConfig::default();
        assert!(cfg.enabled);
        assert_eq!(cfg.interval_ms, 60_000);
        assert_eq!(cfg.idle_window_ms, 600_000);
        assert_eq!(cfg.max_per_hour, 120);
        assert_eq!(cfg.indexer_delay_ms, 1_500);
        assert_eq!(cfg.queue_max, 200);
        assert_eq!(cfg.entry_ttl, 604_800);
        assert_eq!(cfg.drain_max_works, 5);
        assert_eq!(cfg.queue_preview, 8);
        assert!(cfg.br_first);
        assert_eq!(cfg.br_max_wait_ms, 21_600_000);
        assert_eq!(cfg.index_only_harvest_timeout_ms, 90_000);
    }

    #[test]
    fn timeout_index_only_respeita_clamp_do_ts() {
        // A régua do Node: min(120_000, max(5_000, n)).
        assert_eq!(clamp_timeout(1_000.0), 5_000);
        assert_eq!(clamp_timeout(90_000.0), 90_000);
        assert_eq!(clamp_timeout(999_999.0), 120_000);
    }

    fn clamp_timeout(value: f64) -> u64 {
        value.clamp(5_000.0, 120_000.0) as u64
    }

    /// O TTL da sonda segue a régua do Node, e o piso NÃO é o lease: com
    /// `BR_PROBE_TTL_S=60` quem protege o `pending` é o clamp do
    /// `BrProbe::write_pending` (TTL ≥ lease), não este valor.
    #[test]
    fn probe_ttl_segue_a_regua_do_ts() {
        assert_eq!(clamp_probe_ttl(0.0), 60);
        assert_eq!(clamp_probe_ttl(1.0), 60);
        let do_crate = adom_harvest::DEFAULT_PROBE_TTL_SECONDS;
        assert_eq!(
            clamp_probe_ttl(do_crate as f64),
            do_crate,
            "default do env ausente = default do crate"
        );
        assert_eq!(clamp_probe_ttl(86_400.0), 86_400);
    }
}
