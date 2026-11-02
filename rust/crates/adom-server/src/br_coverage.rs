//! Cobertura BR ⚡ da COORTE POPULAR, medida no gateway (porte de
//! `src/utils/br-coverage.ts`, Fase 3.1).
//!
//! Pergunta: quantas obras populares (`seed:v1:cohort`, top IMDb) já têm uma
//! release BR dublada com ⚡ confirmado. É observabilidade PURA: lê o índice,
//! o ledger `rdc:v2`, o `davail` e o `mag:v1` do próprio `cache.db`, não faz
//! rede e não escreve em debrid. A leitura do SQLite roda em `spawn_blocking`.
//!
//! ⚡ por release (não-lied): ledger RD hit, `davail` positivo da conta do
//! operador ou `mag:v1:alive` dela. Miss explícito: ledger miss/blocked ou
//! `davail` zero. `blocked` é miss terminal e vence tudo. A obra agrega: hit
//! se qualquer release hit; miss só se TODAS as candidatas são miss; senão
//! unknown. Sem conta do operador só o ledger decide.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use adom_core::peek_state;
use adom_index::IndexedRelease;
use serde::Serialize;
use serde_json::{json, Value};

/// Piso do intervalo (`F3_BR_SAMPLE_MS`), igual ao `Math.max(30_000, …)`.
pub const SAMPLE_MIN_MS: f64 = 30_000.0;
/// Default do intervalo (`F3_BR_SAMPLE_MS`).
pub const SAMPLE_DEFAULT_MS: f64 = 300_000.0;
/// Teto e default de obras por tipo na coorte (`F3_BR_TOP_PER_TYPE`).
pub const TOP_MAX: f64 = 100.0;

/// Estado do ledger `rdc:v2` para uma release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ledger {
    Hit,
    Miss,
    Blocked,
    Unknown,
}

/// Veredito de uma release.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseStatus {
    Hit,
    Miss,
    Unknown,
}

/// `s` gravado no ledger → estado. Qualquer outra coisa é `unknown`
/// (`peekLedgerState`): `lie`/`bad` não são estados do ledger.
pub fn ledger_of(stored_s: Option<&str>) -> Ledger {
    match peek_state(true, stored_s) {
        "hit" => Ledger::Hit,
        "miss" => Ledger::Miss,
        "blocked" => Ledger::Blocked,
        _ => Ledger::Unknown,
    }
}

/// Classificação pura de uma release. `davail` é `None` sem conta do
/// operador; `alive` só conta quando a conta está ativa (ver `Readers`).
pub fn release_status(ledger: Ledger, davail: Option<bool>, alive: bool) -> ReleaseStatus {
    // Recusa legal é terminal: nem davail nem alive antigos a ressuscitam.
    if ledger == Ledger::Blocked {
        return ReleaseStatus::Miss;
    }
    // Um positivo (qualquer fonte) vence um miss: falso negativo é o erro caro.
    let hit = ledger == Ledger::Hit || davail == Some(true) || alive;
    let miss = ledger == Ledger::Miss || davail == Some(false);
    if hit {
        ReleaseStatus::Hit
    } else if miss {
        ReleaseStatus::Miss
    } else {
        ReleaseStatus::Unknown
    }
}

/// Candidata BR dublada e não-lied, vinda de observação (não do Chupim).
pub fn is_br_release(rel: &IndexedRelease) -> bool {
    rel.source.as_deref() != Some("autofetch") && rel.is_br && rel.dubbed && !rel.lied
}

/// Coorte já sanitizada (`popularCohort` do TS).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cohort {
    pub at: i64,
    pub movies: Vec<String>,
    pub series: Vec<String>,
}

/// `tt\d+` com dígitos ASCII, como `/^tt\d+$/` do JS.
fn is_imdb_id(id: &str) -> bool {
    id.len() > 2 && id.starts_with("tt") && id[2..].bytes().all(|b| b.is_ascii_digit())
}

/// `sanitizeIds`: só `tt…`, sem duplicata, até `top` ids na ordem da coorte.
fn sanitize(list: Option<&Value>, top: usize) -> Vec<String> {
    let Some(items) = list.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in items {
        let id = value.as_str().unwrap_or("");
        if !is_imdb_id(id) || !seen.insert(id) {
            continue;
        }
        out.push(id.to_string());
        if out.len() >= top {
            break;
        }
    }
    out
}

/// `popularCohort`: `at` numérico finito; ids sanitizados; ambas vazias → None.
pub fn parse_cohort(raw: &Value, top: usize) -> Option<Cohort> {
    let at = raw.get("at")?.as_f64().filter(|v| v.is_finite())? as i64;
    let movies = sanitize(raw.get("movies"), top);
    let series = sanitize(raw.get("series"), top);
    if movies.is_empty() && series.is_empty() {
        return None;
    }
    Some(Cohort { at, movies, series })
}

/// Contadores de um tipo (filme ou série).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub target: u64,
    pub indexed: u64,
    pub with_br: u64,
    pub cached: u64,
    pub known_miss: u64,
    pub unknown: u64,
}

/// Uma varredura da coorte (`BrCoverageSample` do TS).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: i64,
    pub cohort_at: Option<i64>,
    pub target_works: u64,
    pub indexed_works: u64,
    pub works_with_br: u64,
    pub works_cached: u64,
    pub works_known_miss: u64,
    pub works_unknown: u64,
    pub releases_with_br: u64,
    pub releases_cached: u64,
    pub movie: Counts,
    pub series: Counts,
}

/// `buildSample`: agrega a coorte sobre o índice. `status` classifica cada
/// candidata BR (em produção, `Readers::status_of`). Obra sem índice ou sem
/// candidata BR não entra em `withBr`. Um id nas duas listas conta como série.
pub fn build_sample(
    cohort: &Cohort,
    snap: &HashMap<String, Vec<IndexedRelease>>,
    now: i64,
    status: impl Fn(&IndexedRelease) -> ReleaseStatus,
) -> Sample {
    let mut s = Sample {
        at: now,
        cohort_at: Some(cohort.at),
        target_works: (cohort.movies.len() + cohort.series.len()) as u64,
        ..Sample::default()
    };
    s.movie.target = cohort.movies.len() as u64;
    s.series.target = cohort.series.len() as u64;
    let mut is_series: HashMap<&str, bool> = HashMap::new();
    for id in &cohort.movies {
        is_series.insert(id.as_str(), false);
    }
    for id in &cohort.series {
        is_series.insert(id.as_str(), true);
    }
    for id in cohort.movies.iter().chain(cohort.series.iter()) {
        let Some(list) = snap.get(id).filter(|list| !list.is_empty()) else {
            continue; // obra ainda não indexada
        };
        let series_bucket = is_series.get(id.as_str()).copied().unwrap_or(false);
        let bucket = if series_bucket {
            &mut s.series
        } else {
            &mut s.movie
        };
        bucket.indexed += 1;
        s.indexed_works += 1;
        let br: Vec<&IndexedRelease> = list.iter().filter(|r| is_br_release(r)).collect();
        if br.is_empty() {
            continue; // sem conteúdo BR para medir
        }
        let bucket = if series_bucket {
            &mut s.series
        } else {
            &mut s.movie
        };
        bucket.with_br += 1;
        s.works_with_br += 1;
        s.releases_with_br += br.len() as u64;
        let mut any_hit = false;
        let mut all_miss = true;
        for rel in &br {
            match status(rel) {
                ReleaseStatus::Miss => {}
                ReleaseStatus::Hit => {
                    any_hit = true;
                    s.releases_cached += 1;
                }
                ReleaseStatus::Unknown => all_miss = false,
            }
        }
        let bucket = if series_bucket {
            &mut s.series
        } else {
            &mut s.movie
        };
        if any_hit {
            bucket.cached += 1;
            s.works_cached += 1;
        } else if all_miss {
            bucket.known_miss += 1;
            s.works_known_miss += 1;
        } else {
            bucket.unknown += 1;
            s.works_unknown += 1;
        }
    }
    s
}

/// Razão `num/den`, ou `null` quando o denominador é zero (nada inventado).
fn ratio(num: u64, den: u64) -> Value {
    if den == 0 {
        Value::Null
    } else {
        json!(num as f64 / den as f64)
    }
}

/// Estado em memória do gateway (zera no restart, como o TS).
#[derive(Default)]
pub struct State {
    pub latest: Option<Sample>,
    pub baseline_at: i64,
    pub samples: u64,
    pub counter_sample: u64,
}

/// `State` vazio em `const`, para o `static` abaixo.
const EMPTY: State = State {
    latest: None,
    baseline_at: 0,
    samples: 0,
    counter_sample: 0,
};

pub(crate) static STATE: Mutex<State> = Mutex::new(EMPTY);

/// Aplica uma varredura. Sem coorte (`None`) zera latest, baseline e samples,
/// mas o contador de varreduras é histórico e não volta (igual ao TS).
pub fn apply(state: &mut State, sample: Option<Sample>) {
    match sample {
        None => {
            state.latest = None;
            state.baseline_at = 0;
            state.samples = 0;
        }
        Some(s) => {
            if state.baseline_at == 0 {
                state.baseline_at = s.at;
            }
            state.samples += 1;
            state.counter_sample += 1;
            state.latest = Some(s);
        }
    }
}

/// Corpo de `GET /br-coverage` (`status()` do TS, camelCase). Sem `latest`,
/// as três razões são `null` e `_origem` diz que não foram medidas.
pub fn status_json(state: &State, enabled: bool) -> Value {
    let latest = state.latest.as_ref();
    let target = latest.map_or(0, |s| s.target_works);
    let with_br = latest.map_or(0, |s| s.works_with_br);
    let cached = latest.map_or(0, |s| s.works_cached);
    let mut out = json!({
        "enabled": enabled,
        "baselineAt": state.baseline_at,
        "samples": state.samples,
        "latest": latest,
        "popularCoverage": if latest.is_some() { ratio(cached, target) } else { Value::Null },
        "brWarmRate": if latest.is_some() { ratio(cached, with_br) } else { Value::Null },
        "discoveryRate": if latest.is_some() { ratio(with_br, target) } else { Value::Null },
        "counters": { "sample": state.counter_sample },
    });
    if latest.is_none() {
        out["_origem"] = json!({
            "popularCoverage": "naomedido",
            "brWarmRate": "naomedido",
            "discoveryRate": "naomedido",
        });
    }
    out
}

/// `F3_ENABLED`/`F3_BR_ENABLED`: ausente ou vazio vale ligado; senão `== "true"`.
fn env_on(name: &str) -> bool {
    match std::env::var(name) {
        Ok(raw) if !raw.is_empty() => raw == "true",
        _ => true,
    }
}

/// Liga a medida: `F3_ENABLED` e `F3_BR_ENABLED` (ambos default true).
pub fn enabled_now() -> bool {
    env_on("F3_ENABLED") && env_on("F3_BR_ENABLED")
}

/// Texto numérico no jeito do `num()` do TS: vazio vira 0, inválido o fallback.
fn num(raw: Option<&str>, fallback: f64) -> f64 {
    let Some(raw) = raw else {
        return fallback;
    };
    let trimmed = raw.trim();
    let value = if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse::<f64>().unwrap_or(f64::NAN)
    };
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

/// `F3_BR_TOP_PER_TYPE`: trunc, clamp 1..100, default 100.
pub fn top_per_type(raw: Option<&str>) -> usize {
    num(raw, TOP_MAX).trunc().clamp(1.0, TOP_MAX) as usize
}

/// Intervalo da varredura em ms: piso 30 000, default 300 000.
pub fn sample_ms(raw: Option<&str>) -> u64 {
    num(raw, SAMPLE_DEFAULT_MS).max(SAMPLE_MIN_MS) as u64
}

#[cfg(test)]
#[path = "br_coverage_tests.rs"]
mod tests;
