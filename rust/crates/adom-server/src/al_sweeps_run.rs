//! Estado, relógio e EXECUÇÃO das varreduras da AllDebrid.
//!
//! Duas portas de entrada, UM guard: o tick agendado (`tick`) e a execução
//! manual de um tipo (`run_kind`, rota admin) passam pelo mesmo `running`
//! antes de qualquer I/O. Duas chamadas simultâneas (HTTP × HTTP ou manual ×
//! agendado) nunca listam a conta duas vezes: uma executa, a outra volta com
//! `reentered`.
//!
//! O `due` do tick é calculado DEPOIS de o guard ser adquirido: um manual que
//! termina entre o cálculo e o `begin` não faz mais o agendado repetir o mesmo
//! tipo (a corrida do plano §3.3). `mark_run` continua antes de executar cada
//! tipo — um tipo que falha não vira laço quente.
//!
//! Separado do núcleo (`al_sweeps.rs`) para o arquivo caber no teto de 400
//! linhas: aqui só se executa o que as portas devolvem; contadores e snapshot
//! moram em `al_sweeps_stats`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use adom_debrid::alldebrid_sweeps::{apply_plan, MagnetRow, SweepKind, SweepMode};

use super::facts::{config_of, gather, missing_outcome, plan_of, Facts, TickReport};
use super::stats::{next_due_at, SweepCounters, SweepSnapshot, TickSummary};
use super::{effects, FactSource, InventoryEnsure, SourceHttp, SweepSource, KINDS};

/// Estado do processo: um vôo por vez, o relógio por tipo e o que se conta.
struct State {
    running: bool,
    /// `SweepKind` não é `Ord` nem `Hash`: relógio por tipo numa lista curta.
    last: Vec<(SweepKind, i64)>,
    counters: SweepCounters,
    last_tick: Option<TickSummary>,
    started_at_ms: i64,
}

impl State {
    fn new(started_at_ms: i64) -> Self {
        Self {
            running: false,
            last: Vec::new(),
            counters: SweepCounters::new(),
            last_tick: None,
            started_at_ms,
        }
    }
}

fn last_of(last: &[(SweepKind, i64)], kind: SweepKind) -> Option<i64> {
    last.iter()
        .find(|(known, _)| *known == kind)
        .map(|(_, at)| *at)
}

pub(crate) struct Sweeper {
    mode: SweepMode,
    interval_ms: i64,
    source: Arc<dyn SweepSource>,
    facts: Arc<dyn FactSource>,
    /// Efeitos de estado (`adrm`/poda/cura) — materializados SÓ no `Apply`.
    effects: Arc<dyn effects::SweepEffects>,
    /// Carregador do inventário frio (`None` = sem carga: rodada fria fecha).
    inventory: Option<Arc<dyn InventoryEnsure>>,
    state: Arc<Mutex<State>>,
}

impl Sweeper {
    /// Nascimento padrão (`adom_sources::now_ms()`); a produção e os testes usam
    /// [`Self::new_at`] para fixar o `startedAt` do painel.
    #[allow(dead_code)]
    pub(crate) fn new(
        mode: SweepMode,
        interval_ms: i64,
        source: Arc<dyn SweepSource>,
        facts: Arc<dyn FactSource>,
        effects: Arc<dyn effects::SweepEffects>,
        inventory: Option<Arc<dyn InventoryEnsure>>,
    ) -> Arc<Self> {
        Self::new_at(
            mode,
            interval_ms,
            source,
            facts,
            effects,
            inventory,
            adom_sources::now_ms(),
        )
    }

    /// Nascimento injetado: o snapshot do painel fica determinístico no teste.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_at(
        mode: SweepMode,
        interval_ms: i64,
        source: Arc<dyn SweepSource>,
        facts: Arc<dyn FactSource>,
        effects: Arc<dyn effects::SweepEffects>,
        inventory: Option<Arc<dyn InventoryEnsure>>,
        started_at_ms: i64,
    ) -> Arc<Self> {
        Arc::new(Self {
            mode,
            interval_ms,
            source,
            facts,
            effects,
            inventory,
            state: Arc::new(Mutex::new(State::new(started_at_ms))),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tipos cujo intervalo mínimo já venceu (na primeira rodada, todos).
    /// Chamado SEMPRE com o guard adquirido (§3.3).
    fn due(&self, now_ms: i64) -> Vec<SweepKind> {
        let state = self.lock();
        KINDS
            .iter()
            .copied()
            .filter(|kind| match last_of(&state.last, *kind) {
                Some(last) => now_ms.saturating_sub(last) >= self.interval_ms,
                None => true,
            })
            .collect()
    }

    /// Anti-reentrada: `false` = outra rodada está em voo.
    fn begin(&self) -> bool {
        let mut state = self.lock();
        if state.running {
            return false;
        }
        state.running = true;
        true
    }

    fn mark_run(&self, kind: SweepKind, now_ms: i64) {
        let mut state = self.lock();
        let position = state.last.iter().position(|(known, _)| *known == kind);
        match position {
            Some(index) => state.last[index].1 = now_ms,
            None => state.last.push((kind, now_ms)),
        }
    }

    /// Contadores da rodada, sob lock curto e FORA do vôo (`running` já solto).
    fn record(&self, report: &TickReport, now_ms: i64, manual: bool) {
        let mut state = self.lock();
        let State {
            counters,
            last_tick,
            ..
        } = &mut *state;
        counters.record(report, now_ms, manual, last_tick);
    }

    /// Rodada AGENDADA: só os tipos que venceram o intervalo mínimo.
    pub(crate) async fn tick(&self, now_ms: i64) -> TickReport {
        self.run_once(now_ms, None, false).await
    }

    /// Rodada MANUAL (rota admin): UM tipo, fora do relógio (`due` ignorado).
    /// O guard é o MESMO do tick — manual × agendado nunca roda em paralelo.
    pub(crate) async fn run_kind(&self, kind: SweepKind, now_ms: i64) -> TickReport {
        self.run_once(now_ms, Some(vec![kind]), true).await
    }

    /// Passagem única pelo guard. `kinds: None` = agendado (o `due` sai
    /// DEPOIS do `begin`); `Some` = manual (o relógio não manda).
    async fn run_once(
        &self,
        now_ms: i64,
        kinds: Option<Vec<SweepKind>>,
        manual: bool,
    ) -> TickReport {
        // `Off` não faz I/O: nem guard, nem rodada contada.
        if !self.mode.plans() {
            return TickReport::default();
        }
        let report = if self.begin() {
            let flight = FlightGuard {
                state: self.state.clone(),
            };
            let report = self.dispatch(now_ms, kinds, manual).await;
            drop(flight);
            report
        } else {
            TickReport {
                reentered: true,
                ..TickReport::default()
            }
        };
        self.record(&report, now_ms, manual);
        report
    }

    /// O que rodar nesta passagem. O guard já está adquirido.
    async fn dispatch(
        &self,
        now_ms: i64,
        kinds: Option<Vec<SweepKind>>,
        manual: bool,
    ) -> TickReport {
        let kinds = match kinds {
            Some(kinds) => kinds,
            None => {
                let due = self.due(now_ms);
                if due.is_empty() {
                    return TickReport {
                        not_due: true,
                        ..TickReport::default()
                    };
                }
                due
            }
        };
        self.run_guarded(now_ms, kinds, manual).await
    }

    /// UMA rodada dos `kinds` pedidos. `Off` não faz I/O; `ReadOnly` monta o
    /// plano e não chama `DELETE` (o próprio `apply_plan` respeita o modo).
    /// EXIGE o guard de [`Self::begin`] já adquirido.
    async fn run_guarded(&self, now_ms: i64, kinds: Vec<SweepKind>, manual: bool) -> TickReport {
        let mut report = TickReport::default();
        // Fatos duráveis (`adprot`/`adhold`) ilegíveis: leitura que falha não
        // prova "sem proteção" — o plano condenaria acervo retido. A rodada
        // inteira fecha sem plano (a poda nem é chamada), como na listagem
        // indisponível.
        if !self.facts.durable_readable() {
            eprintln!(
                "[al_sweeps] fatos duráveis ilegíveis (adprot/adhold): rodada {} sem plano",
                origem(manual)
            );
            for kind in kinds {
                self.mark_run(kind, now_ms);
                report.missing.push(kind);
                report.outcomes.push(missing_outcome(kind));
            }
            return report;
        }
        // UMA listagem por rodada (os quatro tipos leem a mesma foto da conta).
        let mut rows = self.source.rows().await;
        if rows.is_none() {
            eprintln!("[al_sweeps] sem listagem da conta: nenhum hash entra em plano");
        }
        // Inventário frio: uma tentativa AGUARDADA de provar a referência
        // (caminho de fundo — a busca quente nunca espera isto). Falhou ⇒ o
        // peek segue `None` e TODA a rodada fecha em `inventory_missing`.
        if rows.is_some() && self.facts.known_before().is_none() {
            if let Some(ensure) = self.inventory.as_ref() {
                ensure.ensure().await;
            }
        }
        // Os fatos também são da rodada: mudam entre rodadas, não entre tipos.
        let facts = rows
            .as_deref()
            .map(|rows| gather(self.facts.as_ref(), rows));
        if kinds.contains(&SweepKind::Undubbed) {
            if let (Some(rows), Some(facts)) = (rows.as_mut(), facts.as_ref()) {
                self.load_audio_proofs(rows, facts, now_ms).await;
            }
        }
        // Poda do acervo durável (o `pruneMissing` do `sweepDead` do Node): um
        // efeito de estado como outro qualquer — SÓ no Apply. Com o freio OFF a
        // rodada é diagnóstico e nenhum registro muda de mão.
        if self.mode.deletes() && kinds.contains(&SweepKind::Dead) {
            if let Some(rows) = rows.as_deref() {
                let present: HashSet<String> = rows
                    .iter()
                    .map(|row| row.normalized_hash())
                    .filter(|hash| !hash.is_empty())
                    .collect();
                let grace = config_of(SweepKind::Dead).min_age_ms.max(0);
                self.effects
                    .prune_retention(self.facts.as_ref(), &present, grace, now_ms);
            }
        }
        let view = facts.as_ref().map(|facts| facts.view(now_ms));
        for kind in kinds {
            // Marca ANTES de executar: um tipo que falha não vira laço quente.
            self.mark_run(kind, now_ms);
            let (Some(rows), Some(view)) = (rows.as_deref(), view.as_ref()) else {
                eprintln!(
                    "[al_sweeps] {} pulado: listagem da conta indisponível (read-only)",
                    kind.as_str()
                );
                report.missing.push(kind);
                report.outcomes.push(missing_outcome(kind));
                continue;
            };
            let config = config_of(kind);
            let plan = plan_of(kind, rows, view, &config);
            if !plan.delete.is_empty() && !self.mode.deletes() {
                eprintln!(
                    "[al_sweeps] {}: {} hash(es) no plano, modo {} — nada sai",
                    kind.as_str(),
                    plan.delete.len(),
                    self.mode.as_str()
                );
            }
            let http = SourceHttp {
                source: self.source.as_ref(),
                facts: self.facts.as_ref(),
            };
            let outcome = apply_plan(&plan, rows, view, &config, self.mode, &http).await;
            // A prova do que SAIU vira estado (adrm/cura) — nunca no ReadOnly.
            if self.mode.deletes() {
                effects::apply_effects(self.effects.as_ref(), &outcome, rows, now_ms);
            }
            report.outcomes.push(outcome);
        }
        report
    }

    /// Consulta arquivos só de magnets prontos, antigos e não protegidos.
    /// O teto evita uma chamada por todo o inventário a cada tick.
    async fn load_audio_proofs(&self, rows: &mut [MagnetRow], facts: &Facts, now_ms: i64) {
        const MAX_FILE_LOOKUPS: usize = 100;
        let Some(known_before) = facts.known_before.as_ref() else {
            return;
        };
        let minimum_age = config_of(SweepKind::Undubbed).min_age_ms.max(0);
        let cutoff = now_ms.saturating_sub(minimum_age);
        let mut candidates: Vec<usize> = rows
            .iter()
            .enumerate()
            .filter_map(|(index, row)| {
                let hash = row.normalized_hash();
                if hash.is_empty()
                    || row.id.trim().is_empty()
                    || !row.is_ready()
                    || row.is_active()
                    || !row.files.is_empty()
                    || row.uploaded_at_ms <= 0
                    || row.uploaded_at_ms > cutoff
                    || known_before.contains(&hash)
                    || facts.held.contains(&hash)
                    || facts.retained.contains(&hash)
                {
                    return None;
                }
                Some(index)
            })
            .collect();
        // Os mais antigos primeiro: o lote limitado é o que a varredura pode
        // apagar nesta rodada (mesmo `max_per_round` da decisão).
        candidates.sort_by_key(|index| rows[*index].uploaded_at_ms);
        candidates.truncate(MAX_FILE_LOOKUPS);
        for index in candidates {
            let id = rows[index].id.clone();
            if let Some(paths) = self.source.files(id).await {
                rows[index].files = paths;
            }
        }
    }

    /// Foto para `GET /sweeps`: só memória, nunca I/O na conta.
    pub(crate) fn snapshot(&self) -> SweepSnapshot {
        let state = self.lock();
        let last_by_kind: Vec<(SweepKind, i64)> = KINDS
            .iter()
            .filter_map(|kind| last_of(&state.last, *kind).map(|at| (*kind, at)))
            .collect();
        SweepSnapshot {
            started_at_ms: state.started_at_ms,
            running: state.running,
            last_tick: state.last_tick.clone(),
            counters: state.counters.clone(),
            next_due_at_ms: next_due_at(&last_by_kind, self.interval_ms),
            last_by_kind,
        }
    }
}

/// Origem da rodada no log (nunca o conteúdo do plano).
fn origem(manual: bool) -> &'static str {
    if manual {
        "manual"
    } else {
        "agendada"
    }
}

/// Solta o `running` mesmo em panic ou cancelamento da tarefa.
struct FlightGuard {
    state: Arc<Mutex<State>>,
}

impl Drop for FlightGuard {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.running = false;
    }
}
