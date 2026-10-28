//! Varreduras destrutivas da AllDebrid no gateway: agendador, freio e portas.
//!
//! O núcleo (`adom_debrid::alldebrid_sweeps`) decide; aqui só se monta o que
//! ele precisa, se respeita o intervalo e se obedece ao kill-switch. Nada neste
//! módulo inventa fato: o que o processo não consegue PROVAR vira `None` e o
//! plano fecha em `inventory_missing` (o `may_delete` fail-closed do núcleo
//! aplicado à rodada inteira).
//!
//! # Kill-switches (default do CÓDIGO OFF; o compose liga)
//!
//! - `DEBRID_AL_CLEANUP` **ausente** ⇒ [`SweepMode::ReadOnly`]: monta o plano,
//!   loga os motivos, não apaga. `off` ⇒ [`SweepMode::Off`]: nem plano nem I/O.
//!   `on` ⇒ `Apply`, salvo `DEBRID_AL_CLEANUP_KILL` (aí volta a `ReadOnly`).
//! - `DEBRID_AL_HOLDS` ausente/off ⇒ o hold do autofetch não está montado e o
//!   inventário sozinho não prova que um download em voo está protegido:
//!   `known_before = None` em toda rodada e nenhum hash sai.
//! - `DEBRID_AL_SWEEP_MS` (default 6 h, `0` desliga) é o intervalo mínimo por
//!   tipo; cada tipo tem o próprio relógio (`last`), então a falha de um não
//!   antecipa nem atrasa os outros.
//!
//! # Concorrência
//!
//! UMA rodada em voo por processo (anti-reentrada): o segundo `tick` devolve
//! `reentered: true` sem tocar na conta. O `FlightGuard` solta o `running` no
//! `Drop`, inclusive se a tarefa for abortada no shutdown.
//!
//! # O que a porta nativa prova (e o que ainda falta)
//!
//! `AllDebrid::sweep_magnet_list` entrega `id`, `hash`, o texto do `status`, o
//! `ready`, o `filename` e o `uploadDate` (segundos → ms) numa chamada;
//! `sweep_magnet_files` entrega os caminhos de UM magnet pronto, sob demanda e
//! só para os candidatos do `sweepUndubbed`. A listagem por si só NÃO prova
//! posse (`adsub`), retenção (`adprot`) nem a fila `sup:` — fatos do `cache.db`
//! do Node. Enquanto esses fatos não estiverem ligados de ponta a ponta,
//! `DEBRID_AL_CLEANUP=on` fica em `ReadOnly` (freio
//! `native::ROW_PROOFS_COMPLETE`): o plano é montado e logado, nenhum `DELETE`
//! sai. Independente disso valem as travas por rodada: sem inventário
//! (`known_before`) ou com `DEBRID_AL_HOLDS` off o plano inteiro fecha em
//! `inventory_missing`.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use adom_debrid::alldebrid_sweeps::{
    apply_plan, MagnetRow, SweepHttp, SweepHttpError, SweepKind, SweepMode,
};

#[path = "al_sweeps_env.rs"]
mod env;
pub(crate) use env::spawn;

#[path = "al_sweeps_facts.rs"]
mod facts;
pub(crate) use facts::{config_of, gather, missing_outcome, plan_of, Facts, TickReport};

#[path = "al_sweeps_native.rs"]
mod native;

#[cfg(test)]
#[path = "al_sweeps_tests.rs"]
mod tests;

/// Ordem fixa das quatro varreduras (diagnóstico estável no log).
pub(crate) const KINDS: [SweepKind; 4] = [
    SweepKind::Dead,
    SweepKind::Undubbed,
    SweepKind::Reconcile,
    SweepKind::Revalidate,
];

// ---------------------------------------------------------------------------
// Portas injetáveis: a produção é `native`, os testes usam duplos.
// ---------------------------------------------------------------------------

/// Listagem e delete da conta. `None` na listagem = não deu para saber
/// (auth/quota/rede): nenhum hash é planejado nesta rodada.
pub(crate) type RowsFuture<'a> = Pin<Box<dyn Future<Output = Option<Vec<MagnetRow>>> + Send + 'a>>;
pub(crate) type FilesFuture<'a> = Pin<Box<dyn Future<Output = Option<Vec<String>>> + Send + 'a>>;
pub(crate) type DeleteFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), SweepHttpError>> + Send + 'a>>;

pub(crate) trait SweepSource: Send + Sync {
    fn rows(&self) -> RowsFuture<'_>;
    /// Prova de áudio por id; fontes de teste podem omitir (fica sem prova).
    fn files(&self, _id: String) -> FilesFuture<'_> {
        Box::pin(async { None })
    }
    /// `id` vem por valor: a futura do delete só empresta `&self`.
    fn delete(&self, id: String) -> DeleteFuture<'_>;
}

/// `SweepHttp` do núcleo sobre a porta da conta (o executor não conhece HTTP).
struct SourceHttp<'a> {
    source: &'a dyn SweepSource,
}

impl SweepHttp for SourceHttp<'_> {
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), SweepHttpError>> + Send {
        self.source.delete(id.to_string())
    }
}

/// Fatos que o PROCESSO consegue provar. Produção: `native::NativeFacts`.
pub(crate) trait FactSource: Send + Sync {
    /// Snapshot `knownBefore` vigente. `None` = sem referência autorizada.
    fn known_before(&self) -> Option<HashSet<String>>;
    fn held(&self, hash: &str) -> bool;
    fn retained(&self, hash: &str) -> bool;
    fn owned_at(&self, hash: &str) -> Option<i64>;
    fn marked(&self) -> HashSet<String>;
}

// ---------------------------------------------------------------------------
// Agendador
// ---------------------------------------------------------------------------

#[derive(Default)]
pub(crate) struct State {
    running: bool,
    /// `SweepKind` não é `Ord` nem `Hash`: relógio por tipo numa lista curta.
    last: Vec<(SweepKind, i64)>,
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
    state: Arc<Mutex<State>>,
}

impl Sweeper {
    pub(crate) fn new(
        mode: SweepMode,
        interval_ms: i64,
        source: Arc<dyn SweepSource>,
        facts: Arc<dyn FactSource>,
    ) -> Arc<Self> {
        Arc::new(Self {
            mode,
            interval_ms,
            source,
            facts,
            state: Arc::new(Mutex::new(State::default())),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tipos cujo intervalo mínimo já venceu (primeira rodada do processo:
    /// todos).
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

    /// UMA rodada. `Off` não faz I/O; `ReadOnly` monta o plano e não chama
    /// `DELETE` (o próprio `apply_plan` respeita o modo).
    pub(crate) async fn tick(&self, now_ms: i64) -> TickReport {
        let mut report = TickReport::default();
        if !self.mode.plans() {
            return report;
        }
        let due = self.due(now_ms);
        if due.is_empty() {
            report.not_due = true;
            return report;
        }
        if !self.begin() {
            report.reentered = true;
            return report;
        }
        let _flight = FlightGuard {
            state: self.state.clone(),
        };
        // UMA listagem por rodada (os quatro tipos leem a mesma foto da conta).
        let mut rows = self.source.rows().await;
        if rows.is_none() {
            eprintln!("[al_sweeps] sem listagem da conta: nenhum hash entra em plano");
        }
        // Os fatos também são da rodada: mudam entre rodadas, não entre tipos.
        let facts = rows
            .as_deref()
            .map(|rows| gather(self.facts.as_ref(), rows));
        if due.contains(&SweepKind::Undubbed) {
            if let (Some(rows), Some(facts)) = (rows.as_mut(), facts.as_ref()) {
                self.load_audio_proofs(rows, facts, now_ms).await;
            }
        }
        let view = facts.as_ref().map(|facts| facts.view(now_ms));
        for kind in due {
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
            };
            report
                .outcomes
                .push(apply_plan(&plan, rows, view, &config, self.mode, &http).await);
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

/// Handle do agendador. O `main` guarda a variável e o task vive com o
/// processo (dropar um `JoinHandle` do tokio NÃO aborta o task).
pub(crate) struct SweepHandle {
    // Só existe para o task seguir vivo enquanto o handle existir.
    #[allow(dead_code)]
    task: tokio::task::JoinHandle<()>,
}

impl SweepHandle {
    pub(crate) fn new(task: tokio::task::JoinHandle<()>) -> Self {
        Self { task }
    }
}
