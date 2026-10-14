use super::*;

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
    // Recuperação one-shot pendente (religou o motor, dry-run desligou): é
    // TRABALHO sem rede; sem esta classe o site ficaria "sem-trabalho" e a
    // `simulated` presa — fiel ao `dueClass` do TS.
    if rt.need_simulated_recovery || rt.need_inflight_recovery {
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
