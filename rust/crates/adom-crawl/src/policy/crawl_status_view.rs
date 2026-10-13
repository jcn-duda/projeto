//! Foto do motor por SITE (Fase 8 multi-site) e conversão de status legado.
//!
//! Structs serializáveis e com tipos limpos para expor a visão consolidada do motor e de cada site.
//! Migração fiel de `src/providers/crawl-status-view.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::policy::crawler_live::CrawlerSiteConfig;

/// Cursores incrementais por tipo de obra.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SiteCursors {
    #[serde(default)]
    pub movie: String,
    #[serde(default)]
    pub tv_show: String,
}

impl SiteCursors {
    pub fn new(movie: impl Into<String>, tv_show: impl Into<String>) -> Self {
        Self {
            movie: movie.into(),
            tv_show: tv_show.into(),
        }
    }
}

/// Pausa automática (motivo, instante e detalhe) de um site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteAutoPauseInfo {
    pub reason: String,
    pub at: i64,
    pub detail: String,
}

impl SiteAutoPauseInfo {
    pub fn new(reason: impl Into<String>, at: i64, detail: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
            at,
            detail: detail.into(),
        }
    }
}

/// Tabela de sites: o id é conhecido e HÁ adaptador nesta rodada?
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteTableInfo {
    pub id: String,
    pub label: String,
    pub known: bool,
    pub adapter: bool,
    pub note: Option<String>,
}

impl SiteTableInfo {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        known: bool,
        adapter: bool,
        note: Option<String>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            known,
            adapter,
            note,
        }
    }
}

/// Taxas observadas pela sonda (0..1, exceto magnets_per_page).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRates {
    pub magnets_per_page: f64,
    pub identified_fraction: f64,
    pub original_identified_fraction: f64,
    pub year_match_fraction: f64,
    pub season_match_fraction: f64,
    pub episode_match_fraction: f64,
    pub multi_work_pack_fraction: f64,
}

/// Contagens brutas do veredito da sonda.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeCounts {
    pub sample: i64,
    pub magnets: i64,
    pub identified: i64,
    pub original_identified: i64,
    pub year_match: i64,
    pub season_match: i64,
    pub episode_match: i64,
    pub multi_work_pack: i64,
    pub no_torrent: i64,
    pub errors: i64,
}

/// Gate da sonda: status de autorização e medição de amostra.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeGate {
    pub required: bool,
    pub verdict: Option<String>,
    pub ok: bool,
    pub at: Option<i64>,
    pub sample: Option<i64>,
    pub blocked_by: Option<String>,
    pub rates: Option<ProbeRates>,
    pub counts: Option<ProbeCounts>,
    #[serde(default)]
    pub reasons: Vec<String>,
}

/// Gate desligado (visão neutra: nunca barra e nunca afirma veredito falso).
pub fn neutral_probe() -> ProbeGate {
    ProbeGate {
        required: false,
        verdict: None,
        ok: true,
        at: None,
        sample: None,
        blocked_by: None,
        rates: None,
        counts: None,
        reasons: Vec::new(),
    }
}

/// Estado escalar do motor (um site só) — formato histórico do status.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlMotorState {
    pub active_site_id: String,
    pub active_label: Option<String>,
    pub paused: bool,
    pub auto_pause: Option<SiteAutoPauseInfo>,
    pub cursors: SiteCursors,
    pub next_discovery_at: i64,
    pub pages_this_hour: i64,
    pub open_run_id: Option<i64>,
    pub error_streak: i64,
    pub canary_streak: i64,
    #[serde(default)]
    pub cycle: HashMap<String, i64>,
    pub current_site_new_releases: i64,
    pub site_ready: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avg_request_cost: Option<f64>,
}

/// Foto do runtime de UM site (Fase 8 multi-site).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlSiteRuntimeView {
    pub id: String,
    pub label: Option<String>,
    pub ready: bool,
    pub paused: bool,
    pub auto_pause: Option<SiteAutoPauseInfo>,
    pub cursors: SiteCursors,
    pub next_discovery_at: i64,
    pub pages_this_hour: i64,
    pub open_run_id: Option<i64>,
    pub error_streak: i64,
    pub canary_streak: i64,
    #[serde(default)]
    pub cycle: HashMap<String, i64>,
    pub current_site_new_releases: i64,
    pub avg_request_cost: Option<f64>,
    pub idle_fraction: Option<f64>,
    pub enabled: bool,
    pub dry_run: bool,
    pub site_config: CrawlerSiteConfig,
    pub probe: ProbeGate,
    pub last_active_at: i64,
    pub skip_reason: Option<String>,
    pub site: SiteTableInfo,
}

/// Entrada para consolidar status: multi-site (`sites`) ou formato legado.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlerStatusInput {
    pub sites: Option<Vec<CrawlSiteRuntimeView>>,
    pub global_paused: Option<bool>,
    pub active: Option<String>,
    pub pages_this_hour_total: Option<i64>,
    pub max_per_hour_total: Option<i64>,
    // Formato legado
    pub active_site_id: Option<String>,
    pub active_label: Option<String>,
    pub paused: Option<bool>,
    pub auto_pause: Option<SiteAutoPauseInfo>,
    pub cursors: Option<SiteCursors>,
    pub next_discovery_at: Option<i64>,
    pub pages_this_hour: Option<i64>,
    pub open_run_id: Option<i64>,
    pub error_streak: Option<i64>,
    pub canary_streak: Option<i64>,
    pub cycle: Option<HashMap<String, i64>>,
    pub current_site_new_releases: Option<i64>,
    pub site_ready: Option<bool>,
    pub avg_request_cost: Option<f64>,
    pub idle_fraction: Option<f64>,
}

/// Converte a entrada de status legada para a visão por site multi-site.
pub fn legacy_view(
    input: &CrawlerStatusInput,
    site_config: CrawlerSiteConfig,
    site_id: &str,
) -> CrawlSiteRuntimeView {
    let label = input.active_label.clone();
    CrawlSiteRuntimeView {
        id: site_id.to_string(),
        label: label.clone(),
        ready: input.site_ready.unwrap_or(false),
        paused: input.paused.unwrap_or(false),
        auto_pause: input.auto_pause.clone(),
        cursors: input.cursors.clone().unwrap_or_default(),
        next_discovery_at: input.next_discovery_at.unwrap_or(0),
        pages_this_hour: input.pages_this_hour.unwrap_or(0),
        open_run_id: input.open_run_id,
        error_streak: input.error_streak.unwrap_or(0),
        canary_streak: input.canary_streak.unwrap_or(0),
        cycle: input.cycle.clone().unwrap_or_default(),
        current_site_new_releases: input.current_site_new_releases.unwrap_or(0),
        avg_request_cost: input.avg_request_cost,
        idle_fraction: input.idle_fraction.or(Some(1.0)),
        enabled: site_config.enabled,
        dry_run: site_config.dry_run,
        site_config,
        probe: neutral_probe(),
        last_active_at: 0,
        skip_reason: None,
        site: SiteTableInfo {
            id: site_id.to_string(),
            label: label.unwrap_or_else(|| site_id.to_string()),
            known: false,
            adapter: true,
            note: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_neutral_probe_is_open_and_unmeasured() {
        let p = neutral_probe();
        assert!(!p.required);
        assert!(p.ok);
        assert_eq!(p.verdict, None);
        assert_eq!(p.blocked_by, None);
        assert_eq!(p.rates, None);
        assert_eq!(p.counts, None);
        assert!(p.reasons.is_empty());
    }

    #[test]
    fn test_legacy_view_conversion() {
        let input = CrawlerStatusInput {
            active_site_id: Some("vacatorrent".to_string()),
            active_label: Some("Vaca Torrent".to_string()),
            site_ready: Some(true),
            paused: Some(false),
            pages_this_hour: Some(42),
            current_site_new_releases: Some(5),
            avg_request_cost: Some(1.25),
            idle_fraction: Some(0.85),
            ..Default::default()
        };

        let cfg = CrawlerSiteConfig::default();
        let view = legacy_view(&input, cfg.clone(), "vacatorrent");

        assert_eq!(view.id, "vacatorrent");
        assert_eq!(view.label, Some("Vaca Torrent".to_string()));
        assert!(view.ready);
        assert!(!view.paused);
        assert_eq!(view.pages_this_hour, 42);
        assert_eq!(view.current_site_new_releases, 5);
        assert_eq!(view.avg_request_cost, Some(1.25));
        assert_eq!(view.idle_fraction, Some(0.85));
        assert_eq!(view.site.label, "Vaca Torrent");
        assert_eq!(view.site.known, false);
        assert!(view.site.adapter);
        assert!(view.probe.ok);
    }

    #[test]
    fn test_legacy_view_defaults_when_empty() {
        let input = CrawlerStatusInput::default();
        let cfg = CrawlerSiteConfig::default();
        let view = legacy_view(&input, cfg, "nerdfilmes");

        assert_eq!(view.id, "nerdfilmes");
        assert_eq!(view.label, None);
        assert!(!view.ready);
        assert!(!view.paused);
        assert_eq!(view.cursors.movie, "");
        assert_eq!(view.cursors.tv_show, "");
        assert_eq!(view.pages_this_hour, 0);
        assert_eq!(view.idle_fraction, Some(1.0));
        assert_eq!(view.site.label, "nerdfilmes");
    }

    #[test]
    fn test_status_view_serialization_roundtrip() {
        let info = SiteTableInfo::new("bludv", "BLUDV", true, true, Some("ok".to_string()));
        let json = serde_json::to_string(&info).expect("serialize");
        let parsed: SiteTableInfo = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(info, parsed);

        let pause = SiteAutoPauseInfo::new("error-streak", 1700000000, "5 errors");
        let json_pause = serde_json::to_string(&pause).expect("serialize");
        let parsed_pause: SiteAutoPauseInfo =
            serde_json::from_str(&json_pause).expect("deserialize");
        assert_eq!(pause, parsed_pause);
    }
}
