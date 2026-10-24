//! Golden `crawl-policy` — política pura do motor de raspagem (fase C2).
//!
//! Consome `rust/golden/crawl-policy.jsonl` (expected SEMPRE medido do `dist`
//! vivo pelo oráculo `scripts/golden/crawl-policy-oracle.mjs`; nunca escrito à
//! mão) e reproduz cada `op` pela API exportada de `adom-crawl`. Cobre os 7
//! módulos: `crawl_cycle`, `crawl_rate`, `crawl_pauses`, `crawl_status_view`,
//! `crawler_live` (schema+site) e `crawl_site_select`/`crawl_dispatch`.
//!
//! Comparação é byte a byte da string canônica (JSON de chaves ordenadas ou
//! escalar). Divergências são REPORTADAS em bloco único (não escondidas por
//! normalização).
mod golden_common;

use adom_crawl::*;
use golden_common::select_render::render_select;
use golden_common::*;
use serde_json::{json, Value};

const JSONL_BYTES: &[u8] = include_bytes!("../../../golden/crawl-policy.jsonl");
const MANIFEST_TEXT: &str = include_str!("../../../golden/crawl-policy.manifest.json");
const CORPUS_TEXT: &str = include_str!("../../../../scripts/golden/corpus-crawl-policy.json");
const REGISTRY: &str = "crawl-policy/crawlPolicy";
const FORMAT: &str = "adom-golden-manifest/1";

fn config_json(c: &CrawlerSiteConfig) -> Value {
    json!({
        "enabled": c.enabled, "dryRun": c.dry_run, "delayMs": c.delay_ms, "maxPerHour": c.max_per_hour,
        "idleWindowMs": c.idle_window_ms, "maxTries": c.max_tries, "errorPauseStreak": c.error_pause_streak,
        "layoutCanary": c.layout_canary, "incrementalIntervalMin": c.incremental_interval_min,
        "seriesEnabled": c.series_enabled, "seriesMaxCards": c.series_max_cards,
        "seriesMaxButtons": c.series_max_buttons, "requireProbe": c.require_probe,
        "overridden": c.overridden,
    })
}

fn probe_json(p: &ProbeGate) -> Value {
    json!({
        "required": p.required, "verdict": p.verdict, "ok": p.ok, "at": p.at, "sample": p.sample,
        "blockedBy": p.blocked_by, "rates": serde_json::to_value(&p.rates).unwrap(),
        "counts": serde_json::to_value(&p.counts).unwrap(), "reasons": p.reasons,
    })
}

fn opt_f64(v: Option<f64>) -> Value {
    match v {
        Some(x) => Value::String(f64_str(x)),
        None => Value::String("null".to_string()),
    }
}

fn clamp_of(key: &str, v: i64) -> i64 {
    match key {
        "delayMs" => clamp_delay_ms(v),
        "maxPerHour" => clamp_max_per_hour(v),
        "idleWindowMs" => clamp_idle_window_ms(v),
        "maxTries" => clamp_max_tries(v),
        "errorPauseStreak" => clamp_error_pause_streak(v),
        "layoutCanary" => clamp_layout_canary(v),
        "incrementalIntervalMin" => clamp_incremental_interval_min(v),
        "seriesMaxCards" => clamp_series_max_cards(v),
        "seriesMaxButtons" => clamp_series_max_buttons(v),
        other => panic!("clamp desconhecido: {other}"),
    }
}

fn outcome_kind(s: &str) -> PageOutcomeKind {
    match s {
        "done" => PageOutcomeKind::Done,
        "no-torrent" => PageOutcomeKind::NoTorrent,
        "no-work" => PageOutcomeKind::NoWork,
        "error" => PageOutcomeKind::Error,
        "simulated" => PageOutcomeKind::Simulated,
        "partial" => PageOutcomeKind::Partial,
        other => panic!("kind desconhecido: {other}"),
    }
}

fn live_from(v: &Value) -> CrawlerLiveConfig {
    serde_json::from_value(v.clone()).expect("CrawlerLiveConfig do corpus")
}

/// Renderiza a saída canônica de um caso (mesma forma do oráculo JS).
fn render(r: &Value) -> String {
    let op = r["op"].as_str().expect("campo op");
    match op {
        "freshCycle" => {
            let c = fresh_cycle();
            canon(&json!({
                "pages": c.pages, "done": c.done, "noTorrent": c.no_torrent, "noWork": c.no_work,
                "errors": c.errors, "simulated": c.simulated, "partial": c.partial, "releases": c.releases,
                "newReleases": c.new_releases, "discoveryAdded": c.discovery_added,
                "discoveryRefreshed": c.discovery_refreshed, "discoveryFailures": c.discovery_failures,
            }))
        }
        "clamp" => num_str(clamp_of(
            r["key"].as_str().unwrap(),
            r["v"].as_i64().unwrap(),
        )),
        "siteConfigOf" => {
            let live = live_from(&r["live"]);
            let site_id = r["siteId"].as_str().unwrap();
            let over: Option<CrawlerSiteOverride> = r
                .get("override")
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()).expect("CrawlerSiteOverride do corpus"));
            canon(&config_json(&site_config_of(&live, site_id, over.as_ref())))
        }
        "knownSites" => {
            let live = live_from(&r["live"]);
            canon(&json!(known_sites(&live)))
        }
        "cadenceDelayMs" => num_str(cadence_delay_ms(&live_from(&r["live"]))),
        "withCadenceDelay" => num_str(with_cadence(&live_from(&r["live"])).delay_ms),
        "seriesLimits" => {
            let l = series_limits_of(&live_from(&r["live"]));
            canon(
                &json!({ "enabled": l.enabled, "maxCards": l.max_cards, "maxButtons": l.max_buttons }),
            )
        }
        "neutralProbe" => canon(&probe_json(&neutral_probe())),
        "legacyView" => {
            let input: CrawlerStatusInput =
                serde_json::from_value(r["input"].clone()).expect("input legado");
            let live = live_from(&r["live"]);
            let site_id = r["siteId"].as_str().unwrap();
            let cfg = site_config_of(&live, site_id, None);
            let v = legacy_view(&input, cfg, site_id);
            canon(&json!({
                "id": v.id, "label": v.label, "ready": v.ready, "paused": v.paused,
                "autoPause": serde_json::to_value(&v.auto_pause).unwrap(), "cursors": v.cursors,
                "nextDiscoveryAt": v.next_discovery_at, "pagesThisHour": v.pages_this_hour,
                "openRunId": v.open_run_id, "errorStreak": v.error_streak, "canaryStreak": v.canary_streak,
                "cycle": v.cycle, "currentSiteNewReleases": v.current_site_new_releases,
                "avgRequestCost": opt_f64(v.avg_request_cost), "idleFraction": opt_f64(v.idle_fraction),
                "enabled": v.enabled, "dryRun": v.dry_run, "siteConfig": config_json(&v.site_config),
                "lastActiveAt": v.last_active_at, "skipReason": v.skip_reason,
                "site": serde_json::to_value(&v.site).unwrap(), "probe": probe_json(&v.probe),
            }))
        }
        "isSiteLevelError" => bit(is_site_level_error(r["text"].as_str().unwrap())),
        "maxLastmod" => {
            let urls: Vec<String> = r["urls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_str().unwrap().to_string())
                .collect();
            max_lastmod(&urls)
        }
        "observePages" => {
            let lim = &r["limits"];
            let limits = PauseLimits::new(
                lim["errorPauseStreak"].as_u64().unwrap() as usize,
                lim["layoutCanary"].as_u64().unwrap() as usize,
            );
            let mut policy = CrawlPausePolicy::new();
            let mut reasons: Vec<Value> = Vec::new();
            for s in r["steps"].as_array().unwrap() {
                let signal = PageOutcomeSignal::new(
                    outcome_kind(s["kind"].as_str().unwrap()),
                    s["siteLevelError"].as_bool().unwrap_or(false),
                    s["releases"].as_u64().map(|x| x as usize),
                );
                let reason = policy.observe_page(s["url"].as_str().unwrap_or(""), &signal, &limits);
                reasons.push(reason.map(|x| json!(x.as_str())).unwrap_or(Value::Null));
            }
            canon(
                &json!({ "reasons": reasons, "errorStreak": policy.error_streak_count(), "canaryStreak": policy.canary_streak_count() }),
            )
        }
        "observeSite" => {
            let lim = &r["limits"];
            let limits = PauseLimits::new(
                lim["errorPauseStreak"].as_u64().unwrap() as usize,
                lim["layoutCanary"].as_u64().unwrap() as usize,
            );
            let mut policy = CrawlPausePolicy::new();
            let mut reasons: Vec<Value> = Vec::new();
            for s in r["steps"].as_array().unwrap() {
                if s["kind"].as_str().unwrap() == "success" {
                    policy.observe_site_success();
                    reasons.push(Value::Null);
                } else {
                    let reason =
                        policy.observe_site_failure(s["text"].as_str().unwrap_or(""), &limits);
                    reasons.push(reason.map(|x| json!(x.as_str())).unwrap_or(Value::Null));
                }
            }
            canon(&json!({ "reasons": reasons, "errorStreak": policy.error_streak_count() }))
        }
        "hourCounter" => {
            let mut hc = create_hour_counter();
            let mut seen: Vec<i64> = Vec::new();
            for s in r["steps"].as_array().unwrap() {
                let now = s["now"].as_i64().unwrap_or(0);
                match s["kind"].as_str().unwrap() {
                    "note" => hc.note(s["amount"].as_i64().unwrap_or(1), now),
                    "clear" => hc.clear(),
                    _ => seen.push(hc.current(now)),
                }
            }
            canon(&json!(seen))
        }
        "costMeter" => {
            let mut m = create_cost_meter();
            let mut seen: Vec<Value> = Vec::new();
            for s in r["steps"].as_array().unwrap() {
                match s["kind"].as_str().unwrap() {
                    "note" => m.note(s["cost"].as_i64().unwrap_or(1)),
                    "reset" => m.reset(),
                    _ => seen.push(match m.avg() {
                        Some(x) => Value::String(f64_str(x)),
                        None => Value::String("null".to_string()),
                    }),
                }
            }
            canon(&json!(seen))
        }
        "dueClass" => {
            let rt = runtime_from(&r["runtime"]);
            let counters = counters_from(&r["counters"]);
            let deps = deps_from(r.get("deps").unwrap_or(&Value::Null));
            match due_class(&rt, &deps, &counters, r["now"].as_i64().unwrap()) {
                Some(DueClass::Item) => "item".to_string(),
                Some(DueClass::Discovery) => "discovery".to_string(),
                None => "null".to_string(),
            }
        }
        "hasDuePage" => {
            let counters = counters_from(&r["counters"]);
            let deps = deps_from(r.get("deps").unwrap_or(&Value::Null));
            bit(has_due_page(
                &deps,
                r["siteId"].as_str().unwrap(),
                &counters,
                r["now"].as_i64().unwrap(),
            ))
        }
        "assessSites" | "selectNext" | "pickBatch" | "byFairness" => render_select(op, r),
        "skipReasonFor" => {
            let rt = runtime_from(&r["runtime"]);
            let cfg = site_config_from(&r["config"]);
            match skip_reason_for(&rt, &cfg, r["globalEnabled"].as_bool().unwrap_or(false)) {
                Some(s) => s,
                None => "null".to_string(),
            }
        }
        "applySkipReasons" => {
            let mut cands: Vec<SiteCandidate> = r["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| SiteCandidate {
                    id: c["id"].as_str().unwrap().to_string(),
                    config: CrawlerSiteConfig::default(),
                    runtime: runtime_from(c),
                    due: None,
                    skip_reason: c["skipReason"].as_str().map(|s| s.to_string()),
                })
                .collect();
            apply_skip_reasons(&mut cands);
            canon(&json!(cands
                .iter()
                .map(|c| json!({"id": c.id, "skipReason": c.runtime.skip_reason}))
                .collect::<Vec<_>>()))
        }
        "isOwnPace" => bit(is_own_pace(r["id"].as_str().unwrap())),
        other => panic!("op desconhecida no golden: {other}"),
    }
}

#[test]
fn manifest_identidade_e_contagem() {
    let m = manifest(MANIFEST_TEXT);
    assert_eq!(m.format, FORMAT);
    assert_eq!(m.registry, vec![REGISTRY.to_string()]);
    assert_eq!(m.output.lines, jsonl_lines(JSONL_BYTES).len());
    assert_eq!(m.output.lines, m.corpus.cases);
    assert_eq!(m.output.path, "rust/golden/crawl-policy.jsonl");
    assert_eq!(m.corpus.path, "scripts/golden/corpus-crawl-policy.json");
}

#[test]
fn ids_unicos_e_corpus_concorda() {
    let cases = parse_cases(JSONL_BYTES);
    let mut ids = std::collections::HashSet::new();
    for c in &cases {
        assert!(ids.insert(c.id.as_str()), "id duplicado: {}", c.id);
    }
    assert_corpus_matches(CORPUS_TEXT, &cases);
}

#[test]
fn saidas_batem_com_o_golden() {
    let cases = parse_cases(JSONL_BYTES);
    assert_eq!(cases.len(), 146, "contagem de casos do corpus mudou");
    let mut diffs: Vec<String> = Vec::new();
    for case in &cases {
        let input: Value = serde_json::from_str(&case.input).expect("input JSON");
        let op = input["op"].as_str().unwrap_or("?");
        // `catch_unwind`: um pânico do Rust entra como DIVERGÊNCIA do caso, sem
        // derrubar a lista toda (mesmo contrato do golden de parsers).
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render(&input))) {
            Ok(got) if got == case.expected => {}
            Ok(got) => diffs.push(format!(
                "[{0}] op={op}\n  ts={1}\n  rs={got}",
                case.id, case.expected
            )),
            Err(_) => diffs.push(format!(
                "[{}] op={op} PÂNICO do Rust (esperado={})",
                case.id, case.expected
            )),
        }
    }
    assert!(
        diffs.is_empty(),
        "{} divergência(s) TS×Rust:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
