//! Despacho PARALELO entre sites do motor de raspagem.
//!
//! Até `max_parallel` sites trabalham ao mesmo tempo, mantendo:
//! 1. Faixa única do FlareSolverr: no máximo UM site que depende do FlareSolverr por vez.
//! 2. Isolamento de ritmo próprio (`is_own_pace`, ex: Mico Leão Dublado): roda por fora
//!    das vagas do processo e nunca divide Jackett nem FlareSolverr.
//! 3. Respeito ao ritmo individual por site (`delay_ms` vs `last_active_at`).
//! 4. Sites em voo (`inflight`) ficam fora da disputa.
//!
//! Migração fiel de `src/providers/crawl-dispatch.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::policy::crawl_site_select::{
    assess_sites, is_own_pace, select_next, SelectDeps, SiteCandidate, SiteRuntime,
};
use crate::policy::crawler_live::CrawlerSiteConfig;

/// Entrada do despacho de sites.
pub struct DispatchInput<'a, D, FRun, FConf>
where
    D: SelectDeps,
    FRun: Fn(&str) -> SiteRuntime,
    FConf: Fn(&str) -> CrawlerSiteConfig,
{
    pub ids: Vec<String>,
    pub inflight: HashSet<String>,
    pub max_parallel: usize,
    pub flare_sites: HashSet<String>,
    pub runtime_of: FRun,
    pub config_of: FConf,
    pub deps: &'a D,
    pub now: i64,
}

impl<'a, D, FRun, FConf> DispatchInput<'a, D, FRun, FConf>
where
    D: SelectDeps,
    FRun: Fn(&str) -> SiteRuntime,
    FConf: Fn(&str) -> CrawlerSiteConfig,
{
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ids: impl IntoIterator<Item = impl Into<String>>,
        inflight: impl IntoIterator<Item = impl Into<String>>,
        max_parallel: usize,
        flare_sites: impl IntoIterator<Item = impl Into<String>>,
        runtime_of: FRun,
        config_of: FConf,
        deps: &'a D,
        now: i64,
    ) -> Self {
        Self {
            ids: ids.into_iter().map(Into::into).collect(),
            inflight: inflight.into_iter().map(Into::into).collect(),
            max_parallel,
            flare_sites: flare_sites.into_iter().map(Into::into).collect(),
            runtime_of,
            config_of,
            deps,
            now,
        }
    }
}

/// Resultado do lote despachado.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DispatchResult {
    /// Sites a iniciar agora, na ordem de escolha.
    pub chosen: Vec<SiteCandidate>,
    /// Avaliação de todos os sites fora de voo (para diagnóstico no painel).
    pub all: Vec<SiteCandidate>,
    /// Sites com trabalho barrados SÓ pelo próprio ritmo (`delay_ms`).
    pub paced: HashSet<String>,
}

/// O site já pode fazer a próxima requisição pelo PRÓPRIO intervalo?
///
/// Sites com ritmo próprio (ex: Mico) retornam sempre `false` pois o espaçamento
/// é garantido pelo próprio adaptador.
pub fn paced_out(rt: &SiteRuntime, cfg: &CrawlerSiteConfig, now: i64) -> bool {
    if is_own_pace(&rt.id) {
        return false;
    }
    rt.last_active_at > 0 && now - rt.last_active_at < cfg.delay_ms
}

/// Seleciona o lote de sites que devem rodar na rodada corrente.
pub fn pick_batch<D, FRun, FConf>(input: DispatchInput<'_, D, FRun, FConf>) -> DispatchResult
where
    D: SelectDeps,
    FRun: Fn(&str) -> SiteRuntime,
    FConf: Fn(&str) -> CrawlerSiteConfig,
{
    let DispatchInput {
        ids,
        inflight,
        max_parallel,
        flare_sites,
        runtime_of,
        config_of,
        deps,
        now,
    } = input;

    // 1. Sites livres = ids que não estão em voo (inflight)
    let free: Vec<String> = ids
        .into_iter()
        .filter(|id| !inflight.contains(id))
        .collect();

    // 2. Avalia todos os livres para compor `all`
    let all = assess_sites(&free, &runtime_of, &config_of, deps, now);

    // 3. Identifica sites barrados pelo próprio delay_ms
    let mut paced = HashSet::new();
    for id in &free {
        let rt = runtime_of(id);
        let cfg = config_of(id);
        if paced_out(&rt, &cfg, now) {
            paced.insert(id.clone());
        }
    }

    let mut chosen: Vec<SiteCandidate> = Vec::new();
    let mut taken: HashSet<String> = HashSet::new();

    // 4. Ritmo próprio (Mico) roda POR FORA das vagas: não divide Jackett nem
    // FlareSolverr e não consome slots normais.
    for id in free.iter().filter(|id| deps.is_own_pace(id)) {
        let res = select_next(&[id.as_str()], &runtime_of, &config_of, deps, now);
        if let Some(own) = res.chosen {
            chosen.push(own);
            taken.insert(id.clone());
        }
    }

    // 5. Faixa do FlareSolverr: no máximo 1 site simultâneo
    let mut flare_taken = inflight.iter().any(|id| flare_sites.contains(id));

    // 6. Slots disponíveis para sites comuns
    let non_own_inflight = inflight.iter().filter(|id| !deps.is_own_pace(id)).count();
    let mut slots = max_parallel.saturating_sub(non_own_inflight);

    // 7. Preenche até `slots` vagas com sites não-paced e respeitando Flare
    while slots > 0 {
        let pool: Vec<&str> = free
            .iter()
            .filter(
                #[allow(clippy::nonminimal_bool)]
                |id| {
                    !taken.contains(*id)
                        && !deps.is_own_pace(id)
                        && !paced.contains(*id)
                        && !(flare_taken && flare_sites.contains(*id))
                },
            )
            .map(|s| s.as_str())
            .collect();

        if pool.is_empty() {
            break;
        }

        let res = select_next(&pool, &runtime_of, &config_of, deps, now);
        let Some(next) = res.chosen else {
            break;
        };

        if flare_sites.contains(&next.id) {
            flare_taken = true;
        }
        taken.insert(next.id.clone());
        chosen.push(next);
        slots -= 1;
    }

    DispatchResult { chosen, all, paced }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::crawl_site_select::{MockSelectDeps, SiteCounters};
    use std::collections::HashMap;

    fn make_test_cfg(delay_ms: i64) -> CrawlerSiteConfig {
        CrawlerSiteConfig {
            enabled: true,
            dry_run: true,
            delay_ms,
            max_per_hour: 1000,
            idle_window_ms: 0,
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

    fn setup_runtimes(ids: &[&str]) -> HashMap<String, SiteRuntime> {
        ids.iter()
            .map(|id| {
                let mut rt = SiteRuntime::new(*id);
                rt.open_run_id = Some(1);
                (id.to_string(), rt)
            })
            .collect()
    }

    fn make_deps() -> MockSelectDeps {
        MockSelectDeps::new()
            .with_counters(|_| SiteCounters::new(5, 5, 0, 0, 0))
            .with_probe_open(|_| true)
            .with_global_cap_hit(|| false)
    }

    #[test]
    fn test_parallel_max_parallel_and_inflight_exclusion() {
        let ids = vec!["a", "b", "c", "d"];
        let rts = setup_runtimes(&ids);
        let cfg = make_test_cfg(500);
        let deps = make_deps();
        let now = 1_000_000;

        // Sem inflight, max_parallel = 3 -> escolhe a, b, c
        let input = DispatchInput::new(
            ids.clone(),
            Vec::<&str>::new(),
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["a", "b", "c"]);

        // inflight = [a, b], max_parallel = 3 -> só resta c
        let input = DispatchInput::new(
            ids.clone(),
            vec!["a", "b"],
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["c"]);

        // inflight = [a, b, c], max_parallel = 3 -> zero vagas
        let input = DispatchInput::new(
            ids.clone(),
            vec!["a", "b", "c"],
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        assert_eq!(out.chosen.len(), 0);

        // max_parallel = 1 (modo serial) -> escolhe só a
        let input = DispatchInput::new(
            ids.clone(),
            Vec::<&str>::new(),
            1,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["a"]);
    }

    #[test]
    fn test_flaresolverr_contention_single_slot() {
        let ids = vec!["rede", "bludv", "vaca"];
        let rts = setup_runtimes(&ids);
        let cfg = make_test_cfg(500);
        let deps = make_deps();
        let flare_sites = vec!["rede", "bludv"];
        let now = 1_000_000;

        // Com ambos livres, max_parallel = 3 -> escolhe "rede" (primeiro Flare) e "vaca" (não flare).
        // "bludv" fica de fora devido à trava de Flare único simultâneo!
        let input = DispatchInput::new(
            ids.clone(),
            Vec::<&str>::new(),
            3,
            flare_sites.clone(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["rede", "vaca"]);

        // Se "rede" já está em inflight, nenhum outro Flare pode ser escolhido -> só "vaca"
        let input = DispatchInput::new(
            ids.clone(),
            vec!["rede"],
            3,
            flare_sites.clone(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["vaca"]);
    }

    #[test]
    fn test_pacing_by_site_delay_ms() {
        let ids = vec!["a", "b"];
        let mut rts = setup_runtimes(&ids);
        let cfg = make_test_cfg(500);
        let deps = make_deps();
        let now = 1_000_000;

        // "a" requisitou há 100ms (< 500ms) -> barrado por ritmo
        // "b" requisitou há 900ms (>= 500ms) -> liberado
        rts.get_mut("a").unwrap().last_active_at = now - 100;
        rts.get_mut("b").unwrap().last_active_at = now - 900;

        let input = DispatchInput::new(
            ids.clone(),
            Vec::<&str>::new(),
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["b"]);
        assert!(out.paced.contains("a"));
        assert!(!out.paced.contains("b"));
    }

    #[test]
    fn test_own_pace_mico_isolation() {
        let ids = vec!["a", "b", "c", "d", "mico"];
        let rts = setup_runtimes(&ids);
        let cfg = make_test_cfg(500);
        let deps = make_deps();
        let now = 1_000_000;

        // 1. Mico nunca é barrado por paced_out mesmo com last_active_at recente
        let mut rt_mico = SiteRuntime::new("mico");
        rt_mico.last_active_at = now - 50;
        assert!(!paced_out(&rt_mico, &cfg, now));

        // 2. Vagas cheias de sites comuns (a, b, c): Mico roda mesmo assim!
        let input = DispatchInput::new(
            ids.clone(),
            vec!["a", "b", "c"],
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["mico"]);

        // 3. Mico em voo não consome vaga comum: os 3 normais ainda rodam
        let input = DispatchInput::new(
            ids.clone(),
            vec!["mico"],
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["a", "b", "c"]);

        // 4. Tudo livre: Mico (por fora) + 3 normais
        let input = DispatchInput::new(
            ids.clone(),
            Vec::<&str>::new(),
            3,
            Vec::<&str>::new(),
            |id| rts.get(id).cloned().unwrap_or_else(|| SiteRuntime::new(id)),
            |_| cfg.clone(),
            &deps,
            now,
        );
        let out = pick_batch(input);
        let chosen_ids: Vec<&str> = out.chosen.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(chosen_ids, vec!["mico", "a", "b", "c"]);
    }
}
