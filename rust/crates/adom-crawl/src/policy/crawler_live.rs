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
pub const MAX_MAX_PER_HOUR: i64 = 20_000;

pub const MIN_IDLE_WINDOW_MS: i64 = 0;
pub const MAX_IDLE_WINDOW_MS: i64 = 3_600_000;

pub const MIN_MAX_TRIES: i64 = 1;
pub const MAX_MAX_TRIES: i64 = 10;

pub const MIN_ERROR_PAUSE_STREAK: i64 = 1;
pub const MAX_ERROR_PAUSE_STREAK: i64 = 100;

pub const MIN_LAYOUT_CANARY: i64 = 1;
pub const MAX_LAYOUT_CANARY: i64 = 1000;

pub const MIN_INCREMENTAL_INTERVAL_MIN: i64 = 1;
pub const MAX_INCREMENTAL_INTERVAL_MIN: i64 = 1440;

pub const MIN_SERIES_MAX_CARDS: i64 = 1;
pub const MAX_SERIES_MAX_CARDS: i64 = 50;

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

mod site_config;

pub use site_config::*;

// ---------------------------------------------------------------------------
// Testes Unitários
// ---------------------------------------------------------------------------

#[cfg(test)]
#[path = "crawler_live_tests.rs"]
mod tests;
