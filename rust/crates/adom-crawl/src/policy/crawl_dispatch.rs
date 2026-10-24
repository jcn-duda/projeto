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
#[path = "crawl_dispatch_tests.rs"]
mod tests;
