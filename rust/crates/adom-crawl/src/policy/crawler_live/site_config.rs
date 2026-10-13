//! Resolução de configuração efetiva por site (subset de `crawler_live`).

use super::*;

// ---------------------------------------------------------------------------
// Resolução de Configuração Efetiva por Site (site_config_of)
// ---------------------------------------------------------------------------

/// Calcula a configuração efetiva para um determinado site (`site_id`), aplicando
/// overrides específicos se presentes e garantindo a **trava de segurança**:
///
/// - `delay_ms`: `live.delay_ms.max(over.delay_ms)` (o delay só pode AUMENTAR, nunca relaxar o piso global).
/// - `max_per_hour`: `live.max_per_hour.min(over.max_per_hour)` (o teto só pode DIMINUIR, nunca relaxar o teto global).
/// - `enabled`: se houver override, usa `over.enabled`; caso contrário `live.sites.contains(site_id)`.
/// - `dry_run`: se houver override, usa `over.dry_run`; caso contrário `live.dry_run`.
pub fn site_config_of(
    live: &CrawlerLiveConfig,
    site_id: &str,
    overrides: Option<&CrawlerSiteOverride>,
) -> CrawlerSiteConfig {
    let over = overrides.or_else(|| live.site_overrides.get(site_id));

    let mut overridden = Vec::new();

    let enabled = if let Some(o) = over {
        if let Some(en) = o.enabled {
            overridden.push("enabled".to_string());
            en
        } else {
            live.sites.iter().any(|s| s == site_id)
        }
    } else {
        live.sites.iter().any(|s| s == site_id)
    };

    let dry_run = if let Some(o) = over {
        if let Some(dr) = o.dry_run {
            overridden.push("dryRun".to_string());
            dr
        } else {
            live.dry_run
        }
    } else {
        live.dry_run
    };

    let base_delay = live.delay_ms;
    let delay_ms = if let Some(o) = over {
        if let Some(d) = o.delay_ms {
            overridden.push("delayMs".to_string());
            // Trava de segurança: delay só pode AUMENTAR (o piso global é sempre respeitado)
            // NÃO clampa base nem override aqui — só no sanitizePatch/sanitizeSitePatch
            base_delay.max(d.max(0))
        } else {
            base_delay
        }
    } else {
        base_delay
    };

    let base_max_per_hour = live.max_per_hour;
    let max_per_hour = if let Some(o) = over {
        if let Some(m) = o.max_per_hour {
            overridden.push("maxPerHour".to_string());
            // Trava de segurança: teto só pode DIMINUIR (o teto global nunca é excedido)
            // NÃO clampa base nem override aqui — só no sanitizePatch/sanitizeSitePatch
            base_max_per_hour.min(m.max(1))
        } else {
            base_max_per_hour
        }
    } else {
        base_max_per_hour
    };

    CrawlerSiteConfig {
        enabled,
        dry_run,
        delay_ms,
        max_per_hour,
        idle_window_ms: clamp_idle_window_ms(live.idle_window_ms),
        max_tries: clamp_max_tries(live.max_tries),
        error_pause_streak: clamp_error_pause_streak(live.error_pause_streak),
        layout_canary: clamp_layout_canary(live.layout_canary),
        incremental_interval_min: clamp_incremental_interval_min(live.incremental_interval_min),
        series_enabled: live.series_enabled,
        series_max_cards: clamp_series_max_cards(live.series_max_cards),
        series_max_buttons: clamp_series_max_buttons(live.series_max_buttons),
        require_probe: live.require_probe,
        overridden,
    }
}

/// Identifica a lista consolidada de sites conhecidos pelo motor:
/// a união dos sites padrão do ambiente (`live.sites`) com os sites configurados
/// via overrides do painel (`live.site_overrides`), preservando a ordem e sem duplicatas.
pub fn known_sites(live: &CrawlerLiveConfig) -> Vec<String> {
    let mut result = Vec::new();
    for s in &live.sites {
        let trimmed = s.trim();
        if !trimmed.is_empty() && !result.iter().any(|existing| existing == trimmed) {
            result.push(trimmed.to_string());
        }
    }
    for site_id in live.site_overrides.keys() {
        let trimmed = site_id.trim();
        if !trimmed.is_empty() && !result.iter().any(|existing| existing == trimmed) {
            result.push(trimmed.to_string());
        }
    }
    result
}

/// Cadência de timer: calcula o menor `delay_ms` entre todos os sites habilitados.
/// Se nenhum site estiver ativo, retorna o `delay_ms` global.
pub fn cadence_delay_ms(live: &CrawlerLiveConfig) -> i64 {
    let delays: Vec<i64> = known_sites(live)
        .iter()
        .map(|id| site_config_of(live, id, None))
        .filter(|cfg| cfg.enabled)
        .map(|cfg| cfg.delay_ms)
        .collect();

    if delays.is_empty() {
        clamp_delay_ms(live.delay_ms)
    } else {
        *delays.iter().min().unwrap_or(&live.delay_ms)
    }
}

/// Retorna uma cópia da configuração com `delay_ms` ajustado para a cadência do timer.
pub fn with_cadence(live: &CrawlerLiveConfig) -> CrawlerLiveConfig {
    let next = cadence_delay_ms(live);
    let mut updated = live.clone();
    updated.delay_ms = next;
    updated
}
