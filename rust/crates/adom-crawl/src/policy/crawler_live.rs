//! Configuração ao vivo do crawler e regras de override por site (Fase 4 e Fase 8).
//!
//! Porte fiel e tipado de:
//! - `src/utils/crawler-live-schema.ts` (clamps, defaults, limites de séries)
//! - `src/utils/crawler-live-site.ts` (overrides por site, trava de segurança, cadência)
//!
//! # Trava de Segurança (Fase 8)
//! O override de um site NUNCA afrouxa o global nos knobs de ritmo e teto:
//! - `delay_ms`: o delay do site só pode **AUMENTAR** (é um piso de ritmo, `live.delay_ms.max(over.delay_ms)`).
//! - `max_per_hour`: o teto do site só pode **DIMINUIR** (é um teto horário, `live.max_per_hour.min(over.max_per_hour)`).
//!
//! Sem isso, múltiplos sites com teto relaxado poderiam multiplicar o tráfego além
//! do orçamento global definido pelo operador.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// Constantes e Limites (Clamps)
// ---------------------------------------------------------------------------

pub const MIN_DELAY_MS: i64 = 0;
pub const MAX_DELAY_MS: i64 = 60_000;

pub const MIN_MAX_PER_HOUR: i64 = 1;
pub const MAX_MAX_PER_HOUR: i64 = 10_000;

pub const MIN_IDLE_WINDOW_MS: i64 = 0;
pub const MAX_IDLE_WINDOW_MS: i64 = 3_600_000;

pub const MIN_MAX_TRIES: i64 = 1;
pub const MAX_MAX_TRIES: i64 = 10;

pub const MIN_ERROR_PAUSE_STREAK: i64 = 1;
pub const MAX_ERROR_PAUSE_STREAK: i64 = 100;

pub const MIN_LAYOUT_CANARY: i64 = 1;
pub const MAX_LAYOUT_CANARY: i64 = 100;

pub const MIN_INCREMENTAL_INTERVAL_MIN: i64 = 1;
pub const MAX_INCREMENTAL_INTERVAL_MIN: i64 = 1440;

pub const MIN_SERIES_MAX_CARDS: i64 = 1;
pub const MAX_SERIES_MAX_CARDS: i64 = 100;

pub const MIN_SERIES_MAX_BUTTONS: i64 = 1;
pub const MAX_SERIES_MAX_BUTTONS: i64 = 200;

pub const SITE_OVERRIDE_KEYS: &[&str] = &["enabled", "dryRun", "delayMs", "maxPerHour"];

// ---------------------------------------------------------------------------
// Funções Auxiliares de Clamp
// ---------------------------------------------------------------------------

#[inline]
pub fn clamp_delay_ms(v: i64) -> i64 {
    v.clamp(MIN_DELAY_MS, MAX_DELAY_MS)
}

#[inline]
pub fn clamp_max_per_hour(v: i64) -> i64 {
    v.clamp(MIN_MAX_PER_HOUR, MAX_MAX_PER_HOUR)
}

#[inline]
pub fn clamp_idle_window_ms(v: i64) -> i64 {
    v.clamp(MIN_IDLE_WINDOW_MS, MAX_IDLE_WINDOW_MS)
}

#[inline]
pub fn clamp_max_tries(v: i64) -> i64 {
    v.clamp(MIN_MAX_TRIES, MAX_MAX_TRIES)
}

#[inline]
pub fn clamp_error_pause_streak(v: i64) -> i64 {
    v.clamp(MIN_ERROR_PAUSE_STREAK, MAX_ERROR_PAUSE_STREAK)
}

#[inline]
pub fn clamp_layout_canary(v: i64) -> i64 {
    v.clamp(MIN_LAYOUT_CANARY, MAX_LAYOUT_CANARY)
}

#[inline]
pub fn clamp_incremental_interval_min(v: i64) -> i64 {
    v.clamp(MIN_INCREMENTAL_INTERVAL_MIN, MAX_INCREMENTAL_INTERVAL_MIN)
}

#[inline]
pub fn clamp_series_max_cards(v: i64) -> i64 {
    v.clamp(MIN_SERIES_MAX_CARDS, MAX_SERIES_MAX_CARDS)
}

#[inline]
pub fn clamp_series_max_buttons(v: i64) -> i64 {
    v.clamp(MIN_SERIES_MAX_BUTTONS, MAX_SERIES_MAX_BUTTONS)
}

// ---------------------------------------------------------------------------
// Modelos de Dados
// ---------------------------------------------------------------------------

/// Override persistido de um site específico (subset fechado de chaves).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlerSiteOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "dry_run")]
    pub dry_run: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "delay_ms")]
    pub delay_ms: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        alias = "max_per_hour"
    )]
    pub max_per_hour: Option<i64>,
}

impl CrawlerSiteOverride {
    pub fn new() -> Self {
        Self::default()
    }

    /// Retorna uma cópia sanitizada com os valores numéricos respeitando os clamps.
    pub fn sanitized(&self) -> Self {
        Self {
            enabled: self.enabled,
            dry_run: self.dry_run,
            delay_ms: self.delay_ms.map(clamp_delay_ms),
            max_per_hour: self.max_per_hour.map(clamp_max_per_hour),
        }
    }
}

/// Mapa de overrides por site (`site_id -> CrawlerSiteOverride`).
pub type CrawlerSiteOverrides = HashMap<String, CrawlerSiteOverride>;

/// Configuração global e ao vivo do crawler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlerLiveConfig {
    /// Kill-switch geral (CRAWL_ENABLED).
    pub enabled: bool,
    /// Modo simulação (CRAWL_DRY_RUN): raspa sem persistir no banco vivo nem índice.
    #[serde(alias = "dry_run")]
    pub dry_run: bool,
    /// Pausa mínima entre requisições em milissegundos.
    #[serde(alias = "delay_ms")]
    pub delay_ms: i64,
    /// Teto de requisições por hora.
    #[serde(alias = "max_per_hour")]
    pub max_per_hour: i64,
    /// Janela de ociosidade em milissegundos antes de rodar o crawler.
    #[serde(alias = "idle_window_ms")]
    pub idle_window_ms: i64,
    /// Tentativas por URL antes de marcar erro permanente.
    #[serde(alias = "max_tries")]
    pub max_tries: i64,
    /// Erros consecutivos que pausam a raspagem do site.
    #[serde(alias = "error_pause_streak")]
    pub error_pause_streak: i64,
    /// Páginas consecutivas sem botão que disparam canário de layout alterado.
    #[serde(alias = "layout_canary")]
    pub layout_canary: i64,
    /// Intervalo do ciclo incremental em minutos.
    #[serde(alias = "incremental_interval_min")]
    pub incremental_interval_min: i64,
    /// Descoberta de séries habilitada.
    #[serde(alias = "series_enabled")]
    pub series_enabled: bool,
    /// Teto de cards de temporada visitados por página de série.
    #[serde(alias = "series_max_cards")]
    pub series_max_cards: i64,
    /// Teto de botões de download seguidos por página de série.
    #[serde(alias = "series_max_buttons")]
    pub series_max_buttons: i64,
    /// Exigir veredito da sonda de 40 páginas para rodar o site.
    #[serde(alias = "require_probe")]
    pub require_probe: bool,
    /// Lista de sites ativos pelo padrão do ambiente (.env).
    #[serde(default)]
    pub sites: Vec<String>,
    /// Overrides por site configurados via painel.
    #[serde(default, alias = "site_overrides")]
    pub site_overrides: CrawlerSiteOverrides,
}

impl Default for CrawlerLiveConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            dry_run: true,
            delay_ms: 1000,
            max_per_hour: 1500,
            idle_window_ms: 600_000,
            max_tries: 3,
            error_pause_streak: 5,
            layout_canary: 10,
            incremental_interval_min: 60,
            series_enabled: true,
            series_max_cards: 10,
            series_max_buttons: 40,
            require_probe: false,
            sites: vec!["vacatorrent".to_string()],
            site_overrides: HashMap::new(),
        }
    }
}

impl CrawlerLiveConfig {
    /// Sanitiza todos os campos numéricos aplicando os clamps.
    pub fn sanitize(&mut self) {
        self.delay_ms = clamp_delay_ms(self.delay_ms);
        self.max_per_hour = clamp_max_per_hour(self.max_per_hour);
        self.idle_window_ms = clamp_idle_window_ms(self.idle_window_ms);
        self.max_tries = clamp_max_tries(self.max_tries);
        self.error_pause_streak = clamp_error_pause_streak(self.error_pause_streak);
        self.layout_canary = clamp_layout_canary(self.layout_canary);
        self.incremental_interval_min =
            clamp_incremental_interval_min(self.incremental_interval_min);
        self.series_max_cards = clamp_series_max_cards(self.series_max_cards);
        self.series_max_buttons = clamp_series_max_buttons(self.series_max_buttons);
        for over in self.site_overrides.values_mut() {
            *over = over.sanitized();
        }
    }

    /// Retorna uma nova instância sanitizada.
    pub fn sanitized(mut self) -> Self {
        self.sanitize();
        self
    }

    /// Extrai os limites de séries.
    pub fn series_limits(&self) -> CrawlSeriesLimits {
        series_limits_of(self)
    }
}

pub type CrawlerEffectiveConfig = CrawlerLiveConfig;

/// Configuração efetiva calculada para a operação de um site específico.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlerSiteConfig {
    pub enabled: bool,
    #[serde(alias = "dry_run")]
    pub dry_run: bool,
    #[serde(alias = "delay_ms")]
    pub delay_ms: i64,
    #[serde(alias = "max_per_hour")]
    pub max_per_hour: i64,
    #[serde(alias = "idle_window_ms")]
    pub idle_window_ms: i64,
    #[serde(alias = "max_tries")]
    pub max_tries: i64,
    #[serde(alias = "error_pause_streak")]
    pub error_pause_streak: i64,
    #[serde(alias = "layout_canary")]
    pub layout_canary: i64,
    #[serde(alias = "incremental_interval_min")]
    pub incremental_interval_min: i64,
    #[serde(alias = "series_enabled")]
    pub series_enabled: bool,
    #[serde(alias = "series_max_cards")]
    pub series_max_cards: i64,
    #[serde(alias = "series_max_buttons")]
    pub series_max_buttons: i64,
    #[serde(alias = "require_probe")]
    pub require_probe: bool,
    /// Lista de chaves que vieram de override local ("enabled", "dryRun", "delayMs", "maxPerHour").
    #[serde(default)]
    pub overridden: Vec<String>,
}

impl Default for CrawlerSiteConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            dry_run: false,
            delay_ms: 1000,
            max_per_hour: 1500,
            idle_window_ms: 600_000,
            max_tries: 3,
            error_pause_streak: 5,
            layout_canary: 10,
            incremental_interval_min: 60,
            series_enabled: true,
            series_max_cards: 10,
            series_max_buttons: 40,
            require_probe: false,
            overridden: Vec::new(),
        }
    }
}

impl CrawlerSiteConfig {
    pub fn new(enabled: bool, max_per_hour: i64, incremental_interval_min: i64) -> Self {
        Self {
            enabled,
            max_per_hour,
            incremental_interval_min,
            ..Default::default()
        }
    }

    /// Extrai os limites de séries para este site.
    pub fn series_limits(&self) -> CrawlSeriesLimits {
        series_limits_of_site(self)
    }
}

/// Limites operacionais para processamento de séries (Fase 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlSeriesLimits {
    pub enabled: bool,
    #[serde(alias = "max_cards")]
    pub max_cards: i64,
    #[serde(alias = "max_buttons")]
    pub max_buttons: i64,
}

/// Extrai os limites de série a partir da configuração ao vivo global.
pub fn series_limits_of(live: &CrawlerLiveConfig) -> CrawlSeriesLimits {
    CrawlSeriesLimits {
        enabled: live.series_enabled,
        max_cards: clamp_series_max_cards(live.series_max_cards),
        max_buttons: clamp_series_max_buttons(live.series_max_buttons),
    }
}

/// Extrai os limites de série a partir da configuração efetiva de um site.
pub fn series_limits_of_site(site: &CrawlerSiteConfig) -> CrawlSeriesLimits {
    CrawlSeriesLimits {
        enabled: site.series_enabled,
        max_cards: clamp_series_max_cards(site.series_max_cards),
        max_buttons: clamp_series_max_buttons(site.series_max_buttons),
    }
}

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

    let base_delay = clamp_delay_ms(live.delay_ms);
    let delay_ms = if let Some(o) = over {
        if let Some(d) = o.delay_ms {
            overridden.push("delayMs".to_string());
            // Trava de segurança: delay só pode AUMENTAR (o piso global é sempre respeitado)
            base_delay.max(clamp_delay_ms(d))
        } else {
            base_delay
        }
    } else {
        base_delay
    };

    let base_max_per_hour = clamp_max_per_hour(live.max_per_hour);
    let max_per_hour = if let Some(o) = over {
        if let Some(m) = o.max_per_hour {
            overridden.push("maxPerHour".to_string());
            // Trava de segurança: teto só pode DIMINUIR (o teto global nunca é excedido)
            base_max_per_hour.min(clamp_max_per_hour(m))
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

// ---------------------------------------------------------------------------
// Testes Unitários
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clamps_delay_ms() {
        assert_eq!(clamp_delay_ms(-500), 0);
        assert_eq!(clamp_delay_ms(0), 0);
        assert_eq!(clamp_delay_ms(1500), 1500);
        assert_eq!(clamp_delay_ms(60_000), 60_000);
        assert_eq!(clamp_delay_ms(70_000), 60_000);
    }

    #[test]
    fn test_clamps_max_per_hour() {
        assert_eq!(clamp_max_per_hour(-100), 1);
        assert_eq!(clamp_max_per_hour(0), 1);
        assert_eq!(clamp_max_per_hour(1), 1);
        assert_eq!(clamp_max_per_hour(1500), 1500);
        assert_eq!(clamp_max_per_hour(10_000), 10_000);
        assert_eq!(clamp_max_per_hour(25_000), 10_000);
    }

    #[test]
    fn test_clamps_idle_window_ms() {
        assert_eq!(clamp_idle_window_ms(-1), 0);
        assert_eq!(clamp_idle_window_ms(600_000), 600_000);
        assert_eq!(clamp_idle_window_ms(4_000_000), 3_600_000);
    }

    #[test]
    fn test_clamps_max_tries() {
        assert_eq!(clamp_max_tries(0), 1);
        assert_eq!(clamp_max_tries(3), 3);
        assert_eq!(clamp_max_tries(15), 10);
    }

    #[test]
    fn test_clamps_error_pause_streak() {
        assert_eq!(clamp_error_pause_streak(0), 1);
        assert_eq!(clamp_error_pause_streak(5), 5);
        assert_eq!(clamp_error_pause_streak(200), 100);
    }

    #[test]
    fn test_clamps_layout_canary() {
        assert_eq!(clamp_layout_canary(0), 1);
        assert_eq!(clamp_layout_canary(10), 10);
        assert_eq!(clamp_layout_canary(500), 100);
    }

    #[test]
    fn test_clamps_incremental_interval_min() {
        assert_eq!(clamp_incremental_interval_min(0), 1);
        assert_eq!(clamp_incremental_interval_min(60), 60);
        assert_eq!(clamp_incremental_interval_min(2000), 1440);
    }

    #[test]
    fn test_clamps_series_limits() {
        assert_eq!(clamp_series_max_cards(0), 1);
        assert_eq!(clamp_series_max_cards(10), 10);
        assert_eq!(clamp_series_max_cards(150), 100);

        assert_eq!(clamp_series_max_buttons(0), 1);
        assert_eq!(clamp_series_max_buttons(40), 40);
        assert_eq!(clamp_series_max_buttons(300), 200);
    }

    #[test]
    fn test_trava_seguranca_delay_ms_only_increases() {
        let live = CrawlerLiveConfig {
            delay_ms: 1000,
            ..Default::default()
        };

        // 1. Override tenta relaxar (delay menor que o global): TRAVA MANTÉM O PISO GLOBAL
        let faster_override = CrawlerSiteOverride {
            delay_ms: Some(500),
            ..Default::default()
        };
        let cfg1 = site_config_of(&live, "vacatorrent", Some(&faster_override));
        assert_eq!(
            cfg1.delay_ms, 1000,
            "Delay do site nao pode ser menor que o piso global!"
        );
        assert!(cfg1.overridden.contains(&"delayMs".to_string()));

        // 2. Override pede delay maior (mais educado com o site): PERMITIDO
        let slower_override = CrawlerSiteOverride {
            delay_ms: Some(3000),
            ..Default::default()
        };
        let cfg2 = site_config_of(&live, "vacatorrent", Some(&slower_override));
        assert_eq!(
            cfg2.delay_ms, 3000,
            "Delay do site pode aumentar para ritmo mais lento"
        );

        // 3. Override tenta valor negativo: clampeia para 0 e trava mantém o global
        let negative_override = CrawlerSiteOverride {
            delay_ms: Some(-100),
            ..Default::default()
        };
        let cfg3 = site_config_of(&live, "vacatorrent", Some(&negative_override));
        assert_eq!(cfg3.delay_ms, 1000);

        // 4. Override tenta valor acima do teto de clamp: clampeia para 60_000
        let huge_override = CrawlerSiteOverride {
            delay_ms: Some(999_999),
            ..Default::default()
        };
        let cfg4 = site_config_of(&live, "vacatorrent", Some(&huge_override));
        assert_eq!(cfg4.delay_ms, 60_000);

        // 5. Sem override de delay_ms: herda o global
        let no_delay_override = CrawlerSiteOverride {
            enabled: Some(true),
            ..Default::default()
        };
        let cfg5 = site_config_of(&live, "vacatorrent", Some(&no_delay_override));
        assert_eq!(cfg5.delay_ms, 1000);
        assert!(!cfg5.overridden.contains(&"delayMs".to_string()));
    }

    #[test]
    fn test_trava_seguranca_max_per_hour_only_decreases() {
        let live = CrawlerLiveConfig {
            max_per_hour: 1500,
            ..Default::default()
        };

        // 1. Override tenta relaxar (teto maior que o global): TRAVA MANTÉM O TETO GLOBAL
        let greedy_override = CrawlerSiteOverride {
            max_per_hour: Some(5000),
            ..Default::default()
        };
        let cfg1 = site_config_of(&live, "vacatorrent", Some(&greedy_override));
        assert_eq!(
            cfg1.max_per_hour, 1500,
            "Teto de requisicoes por hora nao pode relaxar acima do global!"
        );
        assert!(cfg1.overridden.contains(&"maxPerHour".to_string()));

        // 2. Override pede teto menor (mais restritivo): PERMITIDO
        let polite_override = CrawlerSiteOverride {
            max_per_hour: Some(300),
            ..Default::default()
        };
        let cfg2 = site_config_of(&live, "vacatorrent", Some(&polite_override));
        assert_eq!(
            cfg2.max_per_hour, 300,
            "Teto de requisicoes por hora pode ser reduzido"
        );

        // 3. Override tenta valor zero/negativo: clampeia para 1 e min(1500, 1) = 1
        let zero_override = CrawlerSiteOverride {
            max_per_hour: Some(0),
            ..Default::default()
        };
        let cfg3 = site_config_of(&live, "vacatorrent", Some(&zero_override));
        assert_eq!(cfg3.max_per_hour, 1);

        // 4. Override tenta valor acima do clamp max: clampeia para 10_000 e min(1500, 10_000) = 1500
        let excessive_override = CrawlerSiteOverride {
            max_per_hour: Some(50_000),
            ..Default::default()
        };
        let cfg4 = site_config_of(&live, "vacatorrent", Some(&excessive_override));
        assert_eq!(cfg4.max_per_hour, 1500);

        // 5. Sem override de max_per_hour: herda o global
        let no_max_override = CrawlerSiteOverride {
            enabled: Some(true),
            ..Default::default()
        };
        let cfg5 = site_config_of(&live, "vacatorrent", Some(&no_max_override));
        assert_eq!(cfg5.max_per_hour, 1500);
        assert!(!cfg5.overridden.contains(&"maxPerHour".to_string()));
    }

    #[test]
    fn test_site_config_of_enabled_and_dry_run() {
        let mut live = CrawlerLiveConfig {
            enabled: true,
            dry_run: true,
            sites: vec!["vacatorrent".to_string(), "bludv".to_string()],
            ..Default::default()
        };

        // Site na lista global sem override: enabled = true, dry_run = true
        let cfg_vaca = site_config_of(&live, "vacatorrent", None);
        assert!(cfg_vaca.enabled);
        assert!(cfg_vaca.dry_run);
        assert!(cfg_vaca.overridden.is_empty());

        // Site NÃO na lista global sem override: enabled = false
        let cfg_nerd = site_config_of(&live, "nerdfilmes", None);
        assert!(!cfg_nerd.enabled);
        assert!(cfg_nerd.dry_run);

        // Site NÃO na lista global com override enabled=true: enabled = true
        let enable_override = CrawlerSiteOverride {
            enabled: Some(true),
            ..Default::default()
        };
        let cfg_nerd_on = site_config_of(&live, "nerdfilmes", Some(&enable_override));
        assert!(cfg_nerd_on.enabled);
        assert!(cfg_nerd_on.overridden.contains(&"enabled".to_string()));

        // Site na lista global com override enabled=false: enabled = false
        let disable_override = CrawlerSiteOverride {
            enabled: Some(false),
            ..Default::default()
        };
        let cfg_vaca_off = site_config_of(&live, "vacatorrent", Some(&disable_override));
        assert!(!cfg_vaca_off.enabled);

        // Override dry_run = false
        let wet_override = CrawlerSiteOverride {
            dry_run: Some(false),
            ..Default::default()
        };
        let cfg_wet = site_config_of(&live, "vacatorrent", Some(&wet_override));
        assert!(!cfg_wet.dry_run);
        assert!(cfg_wet.overridden.contains(&"dryRun".to_string()));

        // Override mapeado via site_overrides do live
        live.site_overrides.insert(
            "comandotorrents".to_string(),
            CrawlerSiteOverride {
                enabled: Some(true),
                dry_run: Some(false),
                delay_ms: Some(2500),
                max_per_hour: Some(500),
            },
        );
        let cfg_comando = site_config_of(&live, "comandotorrents", None);
        assert!(cfg_comando.enabled);
        assert!(!cfg_comando.dry_run);
        assert_eq!(cfg_comando.delay_ms, 2500);
        assert_eq!(cfg_comando.max_per_hour, 500);
        assert_eq!(
            cfg_comando.overridden,
            vec!["enabled", "dryRun", "delayMs", "maxPerHour"]
        );
    }

    #[test]
    fn test_series_limits_extraction() {
        let live = CrawlerLiveConfig {
            series_enabled: true,
            series_max_cards: 12,
            series_max_buttons: 45,
            ..Default::default()
        };
        let limits = series_limits_of(&live);
        assert!(limits.enabled);
        assert_eq!(limits.max_cards, 12);
        assert_eq!(limits.max_buttons, 45);

        let site_cfg = site_config_of(&live, "vacatorrent", None);
        let site_limits = site_cfg.series_limits();
        assert_eq!(site_limits, limits);
    }

    #[test]
    fn test_known_sites_and_cadence() {
        let mut live = CrawlerLiveConfig {
            sites: vec!["vacatorrent".to_string(), "bludv".to_string()],
            delay_ms: 1000,
            ..Default::default()
        };
        live.site_overrides.insert(
            "nerdfilmes".to_string(),
            CrawlerSiteOverride {
                enabled: Some(true),
                delay_ms: Some(2000),
                ..Default::default()
            },
        );
        live.site_overrides.insert(
            "vacatorrent".to_string(),
            CrawlerSiteOverride {
                enabled: Some(true),
                delay_ms: Some(5000), // aumentou para 5000
                ..Default::default()
            },
        );

        let sites = known_sites(&live);
        assert_eq!(sites, vec!["vacatorrent", "bludv", "nerdfilmes"]);

        // bludv enabled (sem override): delay 1000
        // nerdfilmes enabled (override): delay max(1000, 2000) = 2000
        // vacatorrent enabled (override): delay max(1000, 5000) = 5000
        // Cadencia minima entre habilitados: 1000 (do bludv)
        assert_eq!(cadence_delay_ms(&live), 1000);

        // Se bludv for desabilitado por override:
        live.site_overrides.insert(
            "bludv".to_string(),
            CrawlerSiteOverride {
                enabled: Some(false),
                ..Default::default()
            },
        );
        // Agora os habilitados sao nerdfilmes (2000) e vacatorrent (5000). Menor: 2000.
        assert_eq!(cadence_delay_ms(&live), 2000);

        let with_cad = with_cadence(&live);
        assert_eq!(with_cad.delay_ms, 2000);
    }

    #[test]
    fn test_serde_camel_and_snake_case() {
        let json_data = r#"{
            "enabled": true,
            "dryRun": false,
            "delayMs": 1500,
            "maxPerHour": 800,
            "idleWindowMs": 300000,
            "maxTries": 5,
            "errorPauseStreak": 10,
            "layoutCanary": 20,
            "incrementalIntervalMin": 120,
            "seriesEnabled": true,
            "seriesMaxCards": 15,
            "seriesMaxButtons": 50,
            "requireProbe": true,
            "sites": ["vacatorrent"],
            "siteOverrides": {
                "vacatorrent": {
                    "delayMs": 2500,
                    "maxPerHour": 600
                }
            }
        }"#;

        let parsed: CrawlerLiveConfig =
            serde_json::from_str(json_data).expect("deserialization ok");
        assert!(parsed.enabled);
        assert!(!parsed.dry_run);
        assert_eq!(parsed.delay_ms, 1500);
        assert_eq!(parsed.max_per_hour, 800);
        assert!(parsed.require_probe);
        let over = parsed.site_overrides.get("vacatorrent").unwrap();
        assert_eq!(over.delay_ms, Some(2500));
        assert_eq!(over.max_per_hour, Some(600));

        let reserialized = serde_json::to_string(&parsed).expect("serialization ok");
        assert!(reserialized.contains("\"delayMs\":1500"));
        assert!(reserialized.contains("\"maxPerHour\":800"));
    }
}
