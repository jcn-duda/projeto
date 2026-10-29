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
//!   `on` ⇒ `Apply`, salvo o freio `DEBRID_AL_SWEEP_APPLY` (default **OFF**) ou
//!   `DEBRID_AL_CLEANUP_KILL` — qualquer um dos dois volta a `ReadOnly`.
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
//! # O que a porta nativa prova
//!
//! `AllDebrid::sweep_magnet_list` entrega `id`, `hash`, o texto do `status`, o
//! `ready`, o `filename` e o `uploadDate` (segundos → ms) numa chamada;
//! `sweep_magnet_files` entrega os caminhos de UM magnet pronto, sob demanda e
//! só para os candidatos do `sweepUndubbed`. Posse (`adsub`), retenção
//! (`adprot`), anti-reenchimento (`adrm`) e a fila `sup:` vêm do `cache.db`
//! (fatos de [`facts`] + [`effects`]).
//!
//! # Inventário frio e guarda viva
//!
//! Rodada fria: o [`InventoryEnsure`] de produção tenta provar o snapshot
//! (UMA `/magnet/status` aguardada, régua do Node: conta − posse durável −
//! `submitted`; falhou ⇒ `inventory_missing` relatado, nada é inventado;
//! `DEBRID_AL_HOLDS` off deixa o peek `None` de qualquer jeito). A fonte
//! durável (`adprot`/`adhold`) ilegível fecha a rodada no PLANEJAMENTO (sem
//! plano e sem poda) e no INSTANTE do delete (`live_delete_ok` → veto): o que
//! não se consegue ler não pode virar "sem proteção". E o delete
//! de cada id relê os fatos protetivos NA HORA (`live_delete_ok` via
//! `guard_live` no núcleo): o que chegou depois do plano veta, e guarda
//! ilegível veta junto.

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

#[path = "al_sweeps_effects.rs"]
mod effects;

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

/// `SweepHttp` do núcleo sobre as portas da conta. A guarda viva
/// (`guard_live`) relê os FATOS no instante do delete; `None` = ilegível e o
/// executor vetará (fail-closed).
struct SourceHttp<'a> {
    source: &'a dyn SweepSource,
    facts: &'a dyn FactSource,
}

impl SweepHttp for SourceHttp<'_> {
    fn delete(&self, id: &str) -> impl Future<Output = Result<(), SweepHttpError>> + Send {
        self.source.delete(id.to_string())
    }

    fn guard_live(&self, hash: &str) -> impl Future<Output = Option<bool>> + Send {
        let verdict = self.facts.live_delete_ok(hash);
        async move { verdict }
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
    /// Fila de represados (`sup:`) da conta — lida da represa nativa. Vazio =
    /// fila ilegível ou sem represados (o revalidate não condena por omissão).
    fn suppressed(&self) -> HashSet<String>;
    /// A fonte durável (`adprot`/`adhold` no `cache.db`) está LEGÍVEL? `false`
    /// = leitura que falha não prova "sem proteção": o planejamento inteiro
    /// fecha (mesma postura da listagem indisponível).
    fn durable_readable(&self) -> bool {
        true
    }
    /// Hold do hash COM prova de leitura: `None` = não deu para ler AGORA, e
    /// quem poda não pode tratá-lo como "sem hold" (fail-closed).
    fn held_checked(&self, hash: &str) -> Option<bool> {
        Some(self.held(hash))
    }
    /// Guarda VIVA no INSTANTE do delete: relê AGORA preexistente, hold e
    /// retenção do hash. `None` = não deu para saber (fail-closed: veto).
    /// Em produção os portos acima são leitura VIVA (peek do snapshot, hold
    /// volátil + `adhold`, `adprot`) — relê-los aqui é o que pega o que
    /// chegou DEPOIS de o plano fechar. Duplos de teste derivam igual. A
    /// fonte durável ilegível no instante do delete VETA junto: "não
    /// protegido" sem leitura não é veredito, é palpite.
    fn live_delete_ok(&self, hash: &str) -> Option<bool> {
        if !self.durable_readable() {
            return None;
        }
        let known = self.known_before()?;
        Some(!known.contains(hash) && !self.held(hash) && !self.retained(hash))
    }
}

/// Carregador do inventário frio: uma tentativa AGUARDADA de provar a
/// referência `knownBefore` quando a rodada acorda sem ela. Produção:
/// `native::NativeInventory` (UMA `/magnet/status` pela mesma régua do Node).
/// Falha NÃO é completada com suposição: o peek segue `None` e a rodada
/// inteira fecha em `inventory_missing`.
pub(crate) trait InventoryEnsure: Send + Sync {
    fn ensure(&self) -> EnsureFuture<'_>;
}

pub(crate) type EnsureFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

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
    /// Efeitos de estado (`adrm`/poda/cura) — materializados SÓ no `Apply`.
    effects: Arc<dyn effects::SweepEffects>,
    /// Carregador do inventário frio (`None` = sem carga: rodada fria fecha).
    inventory: Option<Arc<dyn InventoryEnsure>>,
    state: Arc<Mutex<State>>,
}

impl Sweeper {
    pub(crate) fn new(
        mode: SweepMode,
        interval_ms: i64,
        source: Arc<dyn SweepSource>,
        facts: Arc<dyn FactSource>,
        effects: Arc<dyn effects::SweepEffects>,
        inventory: Option<Arc<dyn InventoryEnsure>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            mode,
            interval_ms,
            source,
            facts,
            effects,
            inventory,
            state: Arc::new(Mutex::new(State::default())),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Tipos cujo intervalo mínimo já venceu (na primeira rodada, todos).
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
        // Fatos duráveis (`adprot`/`adhold`) ilegíveis: leitura que falha não
        // prova "sem proteção" — o plano condenaria acervo retido. A rodada
        // inteira fecha sem plano (a poda nem é chamada), como na listagem
        // indisponível.
        if !self.facts.durable_readable() {
            eprintln!("[al_sweeps] fatos duráveis ilegíveis (adprot/adhold): rodada sem plano");
            for kind in due {
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
        if due.contains(&SweepKind::Undubbed) {
            if let (Some(rows), Some(facts)) = (rows.as_mut(), facts.as_ref()) {
                self.load_audio_proofs(rows, facts, now_ms).await;
            }
        }
        // Poda do acervo durável (o `pruneMissing` do `sweepDead` do Node): um
        // efeito de estado como outro qualquer — SÓ no Apply. Com o freio OFF a
        // rodada é diagnóstico e nenhum registro muda de mão.
        if self.mode.deletes() && due.contains(&SweepKind::Dead) {
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
