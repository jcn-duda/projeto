//! Escolha do PRÓXIMO SITE da rotação serial (Fase 8 multi-site).
//!
//! A política é PURA sobre a foto do motor: o que decide, em que ordem, e POR QUE
//! um site ficou de fora (o motivo é o que o painel mostra; sem ele, "não rasga nada"
//! é indistinguível de "travado pelo teto").
//!
//! Migração fiel de `src/providers/crawl-site-select.ts`.

use serde::{Deserialize, Serialize};

/// Janela de espera para nova tentativa de adaptador com falha (60s).
pub const ADAPTER_RETRY_MS: i64 = 60_000;

/// Classe de trabalho devido (a ordem é a prioridade).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DueClass {
    Item,
    Discovery,
}

/// Contadores de estado das páginas de um site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteCounters {
    pub total: i64,
    pub pending: i64,
    pub error: i64,
    pub inflight: i64,
    pub partial: i64,
}

impl SiteCounters {
    pub fn new(total: i64, pending: i64, error: i64, inflight: i64, partial: i64) -> Self {
        Self {
            total,
            pending,
            error,
            inflight,
            partial,
        }
    }
}

/// Estado de execução do site relevante para a seleção.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteRuntime {
    pub id: String,
    pub paused: bool,
    pub auto_pause: bool,
    pub hour_pages: i64,
    pub last_active_at: i64,
    pub next_discover_at: i64,
    pub open_run_id: Option<i64>,
    pub adapter_failed_at: i64,
    pub skip_reason: Option<String>,
}

impl SiteRuntime {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Default::default()
        }
    }
}

pub use crate::policy::crawler_live::CrawlerSiteConfig;

/// Resumo do site para a decisão de seleção.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SiteCandidate {
    pub id: String,
    pub config: CrawlerSiteConfig,
    pub runtime: SiteRuntime,
    pub due: Option<DueClass>,
    pub skip_reason: Option<String>,
}

/// Resultado da seleção do próximo site.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectResult {
    pub chosen: Option<SiteCandidate>,
    pub all: Vec<SiteCandidate>,
}

/// Consultas externas injetadas para a seleção (sem acesso direto ao banco).
pub trait SelectDeps {
    fn counters(&self, site_id: &str) -> SiteCounters;
    fn probe_open(&self, site_id: &str) -> bool;
    fn global_cap_hit(&self) -> bool;
    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        let _ = (site_id, now);
        None
    }
    fn is_own_pace(&self, site_id: &str) -> bool {
        is_own_pace(site_id)
    }
}

impl<D: SelectDeps + ?Sized> SelectDeps for &D {
    fn counters(&self, site_id: &str) -> SiteCounters {
        (**self).counters(site_id)
    }

    fn probe_open(&self, site_id: &str) -> bool {
        (**self).probe_open(site_id)
    }

    fn global_cap_hit(&self) -> bool {
        (**self).global_cap_hit()
    }

    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        (**self).has_due(site_id, now)
    }

    fn is_own_pace(&self, site_id: &str) -> bool {
        (**self).is_own_pace(site_id)
    }
}

/// Mock / builder ergonômico de `SelectDeps` para testes e injeção simples.
pub type HasDueFn = Box<dyn Fn(&str, i64) -> bool + Send + Sync>;
pub type IsOwnPaceFn = Box<dyn Fn(&str) -> bool + Send + Sync>;

pub struct MockSelectDeps {
    counters_fn: Box<dyn Fn(&str) -> SiteCounters + Send + Sync>,
    probe_open_fn: Box<dyn Fn(&str) -> bool + Send + Sync>,
    global_cap_hit_fn: Box<dyn Fn() -> bool + Send + Sync>,
    has_due_fn: Option<HasDueFn>,
    is_own_pace_fn: Option<IsOwnPaceFn>,
}

impl MockSelectDeps {
    pub fn new() -> Self {
        Self {
            counters_fn: Box::new(|_| SiteCounters::default()),
            probe_open_fn: Box::new(|_| true),
            global_cap_hit_fn: Box::new(|| false),
            has_due_fn: None,
            is_own_pace_fn: None,
        }
    }

    pub fn with_counters<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> SiteCounters + Send + Sync + 'static,
    {
        self.counters_fn = Box::new(f);
        self
    }

    pub fn with_probe_open<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.probe_open_fn = Box::new(f);
        self
    }

    pub fn with_global_cap_hit<F>(mut self, f: F) -> Self
    where
        F: Fn() -> bool + Send + Sync + 'static,
    {
        self.global_cap_hit_fn = Box::new(f);
        self
    }

    pub fn with_has_due<F>(mut self, f: F) -> Self
    where
        F: Fn(&str, i64) -> bool + Send + Sync + 'static,
    {
        self.has_due_fn = Some(Box::new(f));
        self
    }

    pub fn with_is_own_pace<F>(mut self, f: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.is_own_pace_fn = Some(Box::new(f));
        self
    }
}

impl Default for MockSelectDeps {
    fn default() -> Self {
        Self::new()
    }
}

impl SelectDeps for MockSelectDeps {
    fn counters(&self, site_id: &str) -> SiteCounters {
        (self.counters_fn)(site_id)
    }

    fn probe_open(&self, site_id: &str) -> bool {
        (self.probe_open_fn)(site_id)
    }

    fn global_cap_hit(&self) -> bool {
        (self.global_cap_hit_fn)()
    }

    fn has_due(&self, site_id: &str, now: i64) -> Option<bool> {
        self.has_due_fn.as_ref().map(|f| (f)(site_id, now))
    }

    fn is_own_pace(&self, site_id: &str) -> bool {
        if let Some(ref f) = self.is_own_pace_fn {
            (f)(site_id)
        } else {
            is_own_pace(site_id)
        }
    }
}

/// Verifica se o site possui ritmo próprio (Mico Leão Dublado).
pub fn is_own_pace(site_id: &str) -> bool {
    site_id == "mico"
}

/// Página vencida, pelo caminho exato quando existe e pela aproximação sem ele.
pub fn has_due_page<D: SelectDeps>(
    deps: &D,
    site_id: &str,
    counters: &SiteCounters,
    now: i64,
) -> bool {
    if let Some(due) = deps.has_due(site_id, now) {
        return due;
    }
    (counters.pending + counters.error + counters.inflight + counters.partial) > 0
}

/// Trabalho devido de UM site, com a precedência do `step`:
///  - rodada ABERTA ⇒ o que o passo faz é servir a fila (ou fechar a rodada): é trabalho de item;
///  - sem rodada ⇒ item vencido da fila (retry de `error`/`partial`), senão a descoberta vencida.
pub fn due_class<D: SelectDeps>(
    rt: &SiteRuntime,
    deps: &D,
    counters: &SiteCounters,
    now: i64,
) -> Option<DueClass> {
    if rt.open_run_id.is_some() {
        return Some(DueClass::Item);
    }
    if has_due_page(deps, &rt.id, counters, now) {
        return Some(DueClass::Item);
    }
    if counters.total == 0 || now >= rt.next_discover_at {
        return Some(DueClass::Discovery);
    }
    None
}

/// Aplica as regras de exclusão 1–7 numa lista de candidatos:
///  1. desabilitado pelo site (`!config.enabled`)
///  2. pausa manual do site (`rt.paused`)
///  3. pausa automática do site (`rt.auto_pause`)
///  4. teto horário próprio do site ou global (exceto ritmo próprio)
///  5. gate da sonda (`!probe_open`)
///  6. adaptador que acabou de falhar (`adapter_failed_at > 0 && now - adapter_failed_at < 60_000`)
///  7. `due_class` avaliado quando nada barrou; se `due == None` => "sem-trabalho"
pub fn assess_sites<D, FRun, FConf, S>(
    ids: &[S],
    runtime_of: FRun,
    config_of: FConf,
    deps: &D,
    now: i64,
) -> Vec<SiteCandidate>
where
    D: SelectDeps,
    FRun: Fn(&str) -> SiteRuntime,
    FConf: Fn(&str) -> CrawlerSiteConfig,
    S: AsRef<str>,
{
    let global_hit = deps.global_cap_hit();
    let mut out = Vec::with_capacity(ids.len());

    for item in ids {
        let id_str = item.as_ref();
        let rt = runtime_of(id_str);
        let config = config_of(id_str);
        let mut skip_reason = None;

        if !config.enabled {
            skip_reason = Some("desabilitado".to_string());
        } else if rt.paused {
            skip_reason = Some("pausado".to_string());
        } else if rt.auto_pause {
            skip_reason = Some("auto-pausa".to_string());
        } else if !deps.is_own_pace(id_str) && (global_hit || rt.hour_pages >= config.max_per_hour)
        {
            skip_reason = Some("teto-horario".to_string());
        } else if !deps.probe_open(id_str) {
            skip_reason = Some("probe".to_string());
        } else if rt.adapter_failed_at > 0 && now - rt.adapter_failed_at < ADAPTER_RETRY_MS {
            skip_reason = Some("sem-adaptador".to_string());
        }

        let due = if skip_reason.is_none() {
            due_class(&rt, deps, &deps.counters(id_str), now)
        } else {
            None
        };

        if skip_reason.is_none() && due.is_none() {
            skip_reason = Some("sem-trabalho".to_string());
        }

        out.push(SiteCandidate {
            id: id_str.to_string(),
            config,
            runtime: rt,
            due,
            skip_reason,
        });
    }

    out
}

/// Ordena por justiça (mais antigo primeiro por `last_active_at`) com a ordem de config como desempate.
pub fn by_fairness(candidates: &[SiteCandidate]) -> Vec<SiteCandidate> {
    let mut indexed: Vec<(usize, &SiteCandidate)> = candidates.iter().enumerate().collect();
    indexed.sort_by(|(idx_a, cand_a), (idx_b, cand_b)| {
        cand_a
            .runtime
            .last_active_at
            .cmp(&cand_b.runtime.last_active_at)
            .then_with(|| idx_a.cmp(idx_b))
    });
    indexed.into_iter().map(|(_, cand)| cand.clone()).collect()
}

/// Espera máxima de uma descoberta atrás de itens: o intervalo incremental do site em ms.
pub fn starve_ms(config: &CrawlerSiteConfig) -> i64 {
    let min = config.incremental_interval_min;
    let effective = if min > 0 { min } else { 60 };
    effective * 60_000
}

/// Site que deve servir a próxima requisição, ou `None` se nenhum deve.
///
/// 1. Limite de fome da descoberta: candidato com `due == Discovery` e
///    `(last_active_at == 0 || now - last_active_at >= starve_ms)` fura a fila!
/// 2. Senão, prioriza `Item` sobre `Discovery`.
/// 3. Empate por justiça: menor `last_active_at` primeiro; ordem na lista de config como desempate.
pub fn select_next<D, FRun, FConf, S>(
    ids: &[S],
    runtime_of: FRun,
    config_of: FConf,
    deps: &D,
    now: i64,
) -> SelectResult
where
    D: SelectDeps,
    FRun: Fn(&str) -> SiteRuntime,
    FConf: Fn(&str) -> CrawlerSiteConfig,
    S: AsRef<str>,
{
    let all = assess_sites(ids, runtime_of, config_of, deps, now);
    let fair = by_fairness(&all);

    // Limite de fome da descoberta
    let starved = fair.iter().find(|cand| {
        cand.due == Some(DueClass::Discovery)
            && (cand.runtime.last_active_at == 0
                || now - cand.runtime.last_active_at >= starve_ms(&cand.config))
    });

    if let Some(candidate) = starved {
        return SelectResult {
            chosen: Some(candidate.clone()),
            all,
        };
    }

    // Prioriza Item sobre Discovery
    for wanted in [DueClass::Item, DueClass::Discovery] {
        if let Some(candidate) = fair.iter().find(|cand| cand.due == Some(wanted)) {
            return SelectResult {
                chosen: Some(candidate.clone()),
                all,
            };
        }
    }

    SelectResult { chosen: None, all }
}

/// Grava o motivo no runtime de cada candidato (o status lê dali).
pub fn apply_skip_reasons(candidates: &mut [SiteCandidate]) {
    for candidate in candidates.iter_mut() {
        candidate.runtime.skip_reason = candidate.skip_reason.clone();
    }
}

/// Motivo de exclusão para o PAINEL, inclusive SEM tick.
/// Motivo já medido tem precedência sobre o cálculo estático.
pub fn skip_reason_for(
    rt: &SiteRuntime,
    config: &CrawlerSiteConfig,
    global_enabled: bool,
) -> Option<String> {
    if let Some(ref reason) = rt.skip_reason {
        return Some(reason.clone());
    }
    if global_enabled && config.enabled {
        None
    } else {
        Some("desabilitado".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_starvation_discovery_never_ran_fura_fila() {
        let now = 1_000_000;
        let mut a = SiteRuntime::new("a");
        a.open_run_id = Some(1);
        a.last_active_at = now;

        let mut b = SiteRuntime::new("b");
        b.last_active_at = 0; // nunca rodou

        let deps = MockSelectDeps::new().with_counters(|id| {
            if id == "a" {
                SiteCounters::new(5, 5, 0, 0, 0)
            } else {
                SiteCounters::default()
            }
        });

        let config = CrawlerSiteConfig::new(true, 100, 60);

        let result = select_next(
            &["a", "b"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            now,
        );

        assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));
        assert_eq!(
            result.chosen.as_ref().and_then(|c| c.due),
            Some(DueClass::Discovery)
        );
    }

    #[test]
    fn test_starvation_discovery_intervalo_expirado_fura_fila() {
        let now = 10_000_000;
        let mut a = SiteRuntime::new("a");
        a.open_run_id = Some(1);
        a.last_active_at = now;

        let mut b = SiteRuntime::new("b");
        // Intervalo de 60 min = 3_600_000 ms. 61 min atrás = expirado!
        b.last_active_at = now - (61 * 60_000);

        let deps = MockSelectDeps::new().with_counters(|id| {
            if id == "a" {
                SiteCounters::new(5, 5, 0, 0, 0)
            } else {
                SiteCounters::default()
            }
        });

        let config = CrawlerSiteConfig::new(true, 100, 60);

        let result = select_next(
            &["a", "b"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            now,
        );

        assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));
    }

    #[test]
    fn test_starvation_discovery_dentro_do_intervalo_nao_fura_fila() {
        let now = 10_000_000;
        let mut a = SiteRuntime::new("a");
        a.open_run_id = Some(1);
        a.last_active_at = now;

        let mut b = SiteRuntime::new("b");
        // Intervalo de 60 min. 30 min atrás = dentro do intervalo.
        b.last_active_at = now - (30 * 60_000);

        let deps = MockSelectDeps::new().with_counters(|id| {
            if id == "a" {
                SiteCounters::new(5, 5, 0, 0, 0)
            } else {
                SiteCounters::default()
            }
        });

        let config = CrawlerSiteConfig::new(true, 100, 60);

        let result = select_next(
            &["a", "b"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            now,
        );

        // a (Item) deve vencer porque b (Discovery) não está com fome
        assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("a"));
        assert_eq!(
            result.chosen.as_ref().and_then(|c| c.due),
            Some(DueClass::Item)
        );
    }

    #[test]
    fn test_starvation_multiplas_descobertas_vence_mais_antiga() {
        let now = 10_000_000;
        let mut a = SiteRuntime::new("a");
        a.last_active_at = now - (70 * 60_000); // 70 min atrás

        let mut b = SiteRuntime::new("b");
        b.last_active_at = now - (120 * 60_000); // 120 min atrás (mais faminto)

        let mut c = SiteRuntime::new("c");
        c.last_active_at = 0; // nunca rodou (last_active_at 0 é o menor!)

        let deps = MockSelectDeps::new();
        let config = CrawlerSiteConfig::new(true, 100, 60);

        let result = select_next(
            &["a", "b", "c"],
            |id| match id {
                "a" => a.clone(),
                "b" => b.clone(),
                _ => c.clone(),
            },
            |_| config.clone(),
            &deps,
            now,
        );

        // c tem last_active_at = 0, menor de todos
        assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("c"));
    }

    #[test]
    fn test_fairness_ordem_mesma_classe_e_desempate() {
        let mut a = SiteRuntime::new("a");
        a.open_run_id = Some(1);
        a.last_active_at = 900;

        let mut b = SiteRuntime::new("b");
        b.open_run_id = Some(2);
        b.last_active_at = 100; // mais antigo

        let deps = MockSelectDeps::new().with_counters(|_| SiteCounters::new(5, 5, 0, 0, 0));
        let config = CrawlerSiteConfig::default();

        let result = select_next(
            &["a", "b"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            1000,
        );

        assert_eq!(result.chosen.as_ref().map(|c| c.id.as_str()), Some("b"));

        // Desempate por ordem na lista de config quando last_active_at é igual
        a.last_active_at = 100;
        b.last_active_at = 100;

        let result_tie = select_next(
            &["a", "b"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            1000,
        );

        assert_eq!(result_tie.chosen.as_ref().map(|c| c.id.as_str()), Some("a"));

        let result_tie_rev = select_next(
            &["b", "a"],
            |id| if id == "b" { b.clone() } else { a.clone() },
            |_| config.clone(),
            &deps,
            1000,
        );

        assert_eq!(
            result_tie_rev.chosen.as_ref().map(|c| c.id.as_str()),
            Some("b")
        );
    }

    #[test]
    fn test_by_fairness_funcao_pura() {
        let make_cand = |id: &str, last_active: i64| SiteCandidate {
            id: id.to_string(),
            config: CrawlerSiteConfig::default(),
            runtime: SiteRuntime {
                id: id.to_string(),
                last_active_at: last_active,
                ..Default::default()
            },
            due: Some(DueClass::Item),
            skip_reason: None,
        };

        let list = vec![
            make_cand("x", 500),
            make_cand("y", 100),
            make_cand("z", 500),
            make_cand("w", 50),
        ];

        let fair = by_fairness(&list);
        let ids: Vec<&str> = fair.iter().map(|c| c.id.as_str()).collect();
        // 50 (w) -> 100 (y) -> 500 (x, pos 0) -> 500 (z, pos 2)
        assert_eq!(ids, vec!["w", "y", "x", "z"]);
    }

    #[test]
    fn test_exclusao_1_desabilitado() {
        let rt = SiteRuntime::new("s1");
        let config = CrawlerSiteConfig::new(false, 60, 60); // enabled = false
        let deps = MockSelectDeps::new();

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("desabilitado"));
        assert_eq!(candidates[0].due, None);
    }

    #[test]
    fn test_exclusao_2_pausado() {
        let mut rt = SiteRuntime::new("s1");
        rt.paused = true;
        let config = CrawlerSiteConfig::default();
        let deps = MockSelectDeps::new();

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("pausado"));
        assert_eq!(candidates[0].due, None);
    }

    #[test]
    fn test_exclusao_3_auto_pausa() {
        let mut rt = SiteRuntime::new("s1");
        rt.auto_pause = true;
        let config = CrawlerSiteConfig::default();
        let deps = MockSelectDeps::new();

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("auto-pausa"));
        assert_eq!(candidates[0].due, None);
    }

    #[test]
    fn test_exclusao_4_teto_horario_site_e_global() {
        let mut rt = SiteRuntime::new("s1");
        rt.hour_pages = 100;
        let config = CrawlerSiteConfig::new(true, 50, 60); // max_per_hour = 50, estourado
        let deps = MockSelectDeps::new();

        // Teto próprio do site
        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("teto-horario"));

        // Teto global atingido
        rt.hour_pages = 10;
        let deps_global = MockSelectDeps::new().with_global_cap_hit(|| true);
        let candidates_global = assess_sites(
            &["s1"],
            |_| rt.clone(),
            |_| config.clone(),
            &deps_global,
            1000,
        );
        assert_eq!(
            candidates_global[0].skip_reason.as_deref(),
            Some("teto-horario")
        );
    }

    #[test]
    fn test_exclusao_4_mico_ritmo_proprio_ignora_teto() {
        let mut rt = SiteRuntime::new("mico");
        rt.hour_pages = 5000;
        let config = CrawlerSiteConfig::new(true, 50, 60);

        // Global hit e hour_pages estourados
        let deps = MockSelectDeps::new().with_global_cap_hit(|| true);

        let candidates = assess_sites(&["mico"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        // mico tem is_own_pace == true, não deve ter teto-horario
        assert_ne!(candidates[0].skip_reason.as_deref(), Some("teto-horario"));
    }

    #[test]
    fn test_exclusao_5_probe() {
        let rt = SiteRuntime::new("s1");
        let config = CrawlerSiteConfig::default();
        let deps = MockSelectDeps::new().with_probe_open(|_| false);

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, 1000);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("probe"));
        assert_eq!(candidates[0].due, None);
    }

    #[test]
    fn test_exclusao_6_sem_adaptador() {
        let now = 100_000;
        let mut rt = SiteRuntime::new("s1");
        rt.adapter_failed_at = now - 30_000; // falhou há 30s (< 60s)
        let config = CrawlerSiteConfig::default();
        let deps = MockSelectDeps::new();

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("sem-adaptador"));

        // Falhou há 61s (>= 60s) => não barra mais com sem-adaptador
        rt.adapter_failed_at = now - 61_000;
        let candidates_ok = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_ne!(
            candidates_ok[0].skip_reason.as_deref(),
            Some("sem-adaptador")
        );
    }

    #[test]
    fn test_exclusao_7_sem_trabalho() {
        let now = 100_000;
        let mut rt = SiteRuntime::new("s1");
        rt.next_discover_at = now + 50_000; // no futuro
        let config = CrawlerSiteConfig::default();
        // total > 0, mas sem páginas pendentes
        let deps = MockSelectDeps::new().with_counters(|_| SiteCounters::new(10, 0, 0, 0, 0));

        let candidates = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(candidates[0].skip_reason.as_deref(), Some("sem-trabalho"));
        assert_eq!(candidates[0].due, None);
    }

    #[test]
    fn test_precedencia_estrita_das_regras_de_exclusao() {
        let now = 100_000;
        let mut rt = SiteRuntime::new("s1");
        rt.paused = true;
        rt.auto_pause = true;
        rt.hour_pages = 999;
        rt.adapter_failed_at = now - 1000;

        let mut config = CrawlerSiteConfig::new(false, 10, 60);
        let deps = MockSelectDeps::new()
            .with_global_cap_hit(|| true)
            .with_probe_open(|_| false);

        // 1. !config.enabled vence paused
        let c1 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(c1[0].skip_reason.as_deref(), Some("desabilitado"));

        // 2. paused vence auto_pause
        config.enabled = true;
        let c2 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(c2[0].skip_reason.as_deref(), Some("pausado"));

        // 3. auto_pause vence teto-horario
        rt.paused = false;
        let c3 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(c3[0].skip_reason.as_deref(), Some("auto-pausa"));

        // 4. teto-horario vence probe
        rt.auto_pause = false;
        let c4 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps, now);
        assert_eq!(c4[0].skip_reason.as_deref(), Some("teto-horario"));

        // 5. probe vence sem-adaptador
        let deps_no_cap = MockSelectDeps::new()
            .with_global_cap_hit(|| false)
            .with_probe_open(|_| false);
        config.max_per_hour = 1000; // teto não estoura
        let c5 = assess_sites(
            &["s1"],
            |_| rt.clone(),
            |_| config.clone(),
            &deps_no_cap,
            now,
        );
        assert_eq!(c5[0].skip_reason.as_deref(), Some("probe"));

        // 6. sem-adaptador vence sem-trabalho
        let deps_open = MockSelectDeps::new().with_counters(|_| SiteCounters::new(10, 0, 0, 0, 0));
        let c6 = assess_sites(&["s1"], |_| rt.clone(), |_| config.clone(), &deps_open, now);
        assert_eq!(c6[0].skip_reason.as_deref(), Some("sem-adaptador"));
    }

    #[test]
    fn test_due_class_variants() {
        let now = 100_000;
        let deps = MockSelectDeps::new();

        // 1. open_run_id => Item
        let mut rt = SiteRuntime::new("s1");
        rt.open_run_id = Some(42);
        let c = SiteCounters::default();
        assert_eq!(due_class(&rt, &deps, &c, now), Some(DueClass::Item));

        // 2. has_due_page via pending/error/inflight/partial
        rt.open_run_id = None;
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 1, 0, 0, 0), now),
            Some(DueClass::Item)
        );
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 0, 1, 0, 0), now),
            Some(DueClass::Item)
        );
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 1, 0), now),
            Some(DueClass::Item)
        );
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 1), now),
            Some(DueClass::Item)
        );

        // 3. total == 0 => Discovery
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(0, 0, 0, 0, 0), now),
            Some(DueClass::Discovery)
        );

        // 4. total > 0 e now >= next_discover_at => Discovery
        rt.next_discover_at = now - 1;
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 0), now),
            Some(DueClass::Discovery)
        );

        // 5. total > 0 e now < next_discover_at => None
        rt.next_discover_at = now + 10_000;
        assert_eq!(
            due_class(&rt, &deps, &SiteCounters::new(5, 0, 0, 0, 0), now),
            None
        );
    }

    #[test]
    fn test_has_due_injecao_exata() {
        let now = 1000;
        let rt = SiteRuntime::new("s1");
        let counters = SiteCounters::new(10, 0, 0, 0, 0);

        // Injeção devolve true
        let deps_true = MockSelectDeps::new().with_has_due(|_, _| true);
        assert_eq!(has_due_page(&deps_true, "s1", &counters, now), true);
        assert_eq!(
            due_class(&rt, &deps_true, &counters, now),
            Some(DueClass::Item)
        );

        // Injeção devolve false mesmo com contadores tendo pending
        let counters_pending = SiteCounters::new(10, 5, 0, 0, 0);
        let deps_false = MockSelectDeps::new().with_has_due(|_, _| false);
        assert_eq!(
            has_due_page(&deps_false, "s1", &counters_pending, now),
            false
        );
    }

    #[test]
    fn test_apply_skip_reasons() {
        let mut candidates = vec![
            SiteCandidate {
                id: "s1".to_string(),
                config: CrawlerSiteConfig::default(),
                runtime: SiteRuntime::new("s1"),
                due: None,
                skip_reason: Some("pausado".to_string()),
            },
            SiteCandidate {
                id: "s2".to_string(),
                config: CrawlerSiteConfig::default(),
                runtime: SiteRuntime::new("s2"),
                due: Some(DueClass::Item),
                skip_reason: None,
            },
        ];

        apply_skip_reasons(&mut candidates);
        assert_eq!(
            candidates[0].runtime.skip_reason.as_deref(),
            Some("pausado")
        );
        assert_eq!(candidates[1].runtime.skip_reason, None);
    }

    #[test]
    fn test_skip_reason_for() {
        let mut rt = SiteRuntime::new("s1");
        let config = CrawlerSiteConfig::default();

        // rt já tem skip_reason: precedência absoluta
        rt.skip_reason = Some("teto-horario".to_string());
        assert_eq!(
            skip_reason_for(&rt, &config, true).as_deref(),
            Some("teto-horario")
        );
        assert_eq!(
            skip_reason_for(&rt, &config, false).as_deref(),
            Some("teto-horario")
        );

        // sem skip_reason medido
        rt.skip_reason = None;
        assert_eq!(skip_reason_for(&rt, &config, true), None);
        assert_eq!(
            skip_reason_for(&rt, &config, false).as_deref(),
            Some("desabilitado")
        );

        let disabled_config = CrawlerSiteConfig::new(false, 60, 60);
        assert_eq!(
            skip_reason_for(&rt, &disabled_config, true).as_deref(),
            Some("desabilitado")
        );
    }

    #[test]
    fn test_starve_ms() {
        let c1 = CrawlerSiteConfig::new(true, 60, 30);
        assert_eq!(starve_ms(&c1), 30 * 60_000);

        let c2 = CrawlerSiteConfig::new(true, 60, 0);
        assert_eq!(starve_ms(&c2), 60 * 60_000);

        let c3 = CrawlerSiteConfig::new(true, 60, -10);
        assert_eq!(starve_ms(&c3), 60 * 60_000);
    }
}
