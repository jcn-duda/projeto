//! Despacho dos jobs do canal e dreno da represa — metade de [`super::serve`],
//! separada só pela catraca de linhas.
//!
//! Nada de novo nasce aqui: cada passo é a porta que já existia
//! (`probe_step`/`probe_job`, `season_step`, `enqueue`, `suppressed_step`). O
//! módulo é filho de `serve` porque é ele quem enxerga os campos privados do
//! [`Engine`](super::Engine).

use std::collections::BTreeMap;
use std::sync::Arc;

use super::super::enqueue::{self, Job};
use super::super::{probe_step, recheck, season_fill, season_step, suppressed_step};
use super::{evict_job, Engine, Pass};
use crate::tail_effects::{AUTOFETCH_BATCH, BR_PROBE, SEASON_KEY};

/// O que o laço entrega ao passo de evicção: o lote (snapshot PRÉ-step), o que
/// ficou pronto e o orçamento da RODADA — o teto é da passagem, não da obra.
pub(super) struct EvictCall<'a> {
    pub(super) lot: &'a recheck::Lot,
    pub(super) ready: &'a [season_fill::SeasonHint],
    pub(super) paused: bool,
    pub(super) left: &'a mut usize,
}

impl<'a> Engine<'a> {
    /// Represa (`autofetch:v3:sup:`): drena o que a remoção automática deixou
    /// de apagar. Só roda com a fábrica registrada no boot (o mesmo gate da rota
    /// `suppressed-drain`) e com entrada viva — represa vazia não abre conexão.
    pub(super) async fn drain_suppressed(&self, now_ms: i64, pass: &mut Pass) {
        if suppressed_step::factory().is_none() {
            return;
        }
        match suppressed_step::count(self.kv, now_ms) {
            Ok(0) => return,
            Ok(_) => {}
            Err(err) => {
                pass.errors.push(format!("represa: {err}"));
                return;
            }
        }
        let factory = Arc::clone(self.debrid);
        match suppressed_step::drain(self.kv, factory, suppressed_step::drain_max(), now_ms).await {
            Ok(report) => {
                pass.drained += report.counters.dropped;
                for _ in 0..report.counters.failed {
                    pass.skip("suppressed-failed", 1);
                }
            }
            Err(err) => pass.errors.push(format!("represa: {err}")),
        }
    }

    /// Um job do canal: o KIND decide o passo. Sem este despacho, sonda e
    /// season cairiam em `enqueue::run` e seriam recusados como `empty-batch`
    /// (o trabalho sumia sem chegar ao Node).
    pub(super) async fn batch(&self, job: &Job, paused: bool, now_ms: i64, pass: &mut Pass) {
        pass.jobs += 1;
        match job.kind.as_str() {
            BR_PROBE => self.probe(job, paused, now_ms, pass).await,
            SEASON_KEY => self.season(job, paused, now_ms, pass),
            AUTOFETCH_BATCH => self.enqueue_batch(job, paused, now_ms, pass).await,
            _ => pass.skip("unknown-kind", 1),
        }
    }

    /// Sonda dirigida: pede a obra ao colhedor nativo e grava o lease.
    async fn probe(&self, job: &Job, paused: bool, now_ms: i64, pass: &mut Pass) {
        let Some(handle) = self.harvest else {
            pass.skip("no-harvester", 1);
            return;
        };
        let status = handle.status();
        let config = self.probe_config(paused, status.depth, handle.config().queue_max);
        let run = probe_step::run(self.kv, handle, &job.payload, &config, now_ms).await;
        if let Some(reason) = run.skip {
            pass.skip(reason, 1);
        }
        if let Some(err) = run.error {
            pass.errors.push(format!("sonda: {err}"));
        }
        if run.pending {
            pass.probed += 1;
        }
    }

    /// Índice de temporada: grava a busca da temporada no KV (LRU + teto).
    fn season(&self, job: &Job, paused: bool, now_ms: i64, pass: &mut Pass) {
        let config = self.season_config(paused);
        let register = match season_step::plan(&job.payload, &config) {
            season_step::SeasonStep::Register(register) => register,
            season_step::SeasonStep::Skip(reason) => {
                pass.skip(reason.as_str(), 1);
                return;
            }
        };
        match season_step::execute(self.kv, &register, &config, now_ms) {
            Ok(report) if report.registered => pass.seasons += 1,
            Ok(_) => pass.skip("season-not-registered", 1),
            Err(err) => pass.errors.push(format!("season: {err}")),
        }
    }

    /// Régua da SONDA neste instante: `paused` e a fila são da passagem, o resto
    /// do processo — e o toggle vem do overlay (`live > `.env` > default`).
    ///
    /// Relido a cada job, nunca herdado do boot: o `Engine` carrega o boletim da
    /// passagem em `self.live` (ver `serve::engine_for_pass`).
    pub(super) fn probe_config(
        &self,
        paused: bool,
        queue_len: usize,
        queue_max: usize,
    ) -> probe_step::ProbeStepConfig {
        probe_step::ProbeStepConfig::from_env(
            paused,
            queue_len,
            queue_max,
            self.live.auto_fetch_br_probe(),
        )
    }

    /// Régua do Season Pack Fill deste instante (registro E preenchimento), com o
    /// toggle do painel na frente do `.env`.
    pub(super) fn season_config(&self, paused: bool) -> season_step::SeasonStepConfig {
        season_step::SeasonStepConfig::from_env(
            paused,
            self.policy.lot_ttl_seconds,
            self.live.auto_fetch_season_fill(),
        )
    }

    /// Lote do canal: enfileirar e, com aceite, armar o recheck.
    async fn enqueue_batch(&self, job: &Job, paused: bool, now_ms: i64, pass: &mut Pass) {
        let Some(debrid) = (self.debrid)(&job.scope) else {
            pass.skip("no-credential", 1);
            return;
        };
        let report = match enqueue::run(
            self.kv,
            self.policy,
            &self.holds,
            paused,
            &*debrid,
            job,
            now_ms,
        )
        .await
        {
            Ok(report) => report,
            Err(err) => {
                pass.errors.push(err);
                return;
            }
        };
        for (label, count) in &report.skips {
            pass.skip(label, *count);
        }
        if let Some(label) = report.refused {
            pass.skip(label, 1);
        }
        pass.enqueued += report.enqueued.len();
        if report.enqueued.is_empty() {
            return;
        }
        let Some((adapter, account)) = job.scope.split_once(':') else {
            return;
        };
        match recheck::schedule(
            self.kv,
            self.policy,
            &report.search_key,
            (adapter, account),
            &report.enqueued,
            &report.season_hints,
            now_ms,
        ) {
            Ok(_) => pass.scheduled += 1,
            Err(err) => pass.errors.push(err),
        }
    }

    /// Pack pronto (`RecheckAction::Ready`) → invalida as buscas da temporada
    /// registradas pelo efeito `season_key` (`autofetch-recheck.ts:277-284`).
    ///
    /// Roda DEPOIS do poll: `ready` só existe com resposta do serviço, então o
    /// passo herda a mesma credencial do lote. Daqui para frente não há rede —
    /// só o KV do worker e o cache de streams.
    pub(super) fn fill_ready(
        &self,
        lot: &recheck::Lot,
        paused: bool,
        ready: &[season_fill::SeasonHint],
        now_ms: i64,
    ) -> season_fill::FillReport {
        if ready.is_empty() {
            return season_fill::FillReport::default();
        }
        let config = self.season_config(paused);
        let sink = season_fill::sink();
        season_fill::fill(
            self.kv,
            &config,
            sink.as_ref(),
            &lot.adapter_id,
            &lot.account,
            ready,
            now_ms,
        )
    }

    /// Evicção F6: o fallback da MESMA obra cai depois do ready BR.
    ///
    /// O hash ready NÃO viaja no `StepReport` (`recheck.rs` só devolve o
    /// `SeasonHint`), então ele é recuperado casando o hint com o snapshot
    /// PRÉ-step do lote — o que `recheck::due` entregou ao `timers`. Dois hashes
    /// do mesmo pack casam o mesmo hint e apontam para a MESMA obra (mesmo
    /// pedido): o efeito é idempotente.
    ///
    /// Destruição NÃO roda com o worker pausado, nem fora da AllDebrid (a porta
    /// só prova delete por hash lá).
    pub(super) async fn evict_ready(
        &self,
        call: &mut EvictCall<'_>,
        debrid: &super::super::ports::DebridIo,
        config: &evict_job::EvictConfig,
        now_ms: i64,
    ) -> evict_job::PassReport {
        let mut report = evict_job::PassReport::default();
        if call.paused {
            report.skip("evict-paused");
            return report;
        }
        if call.lot.adapter_id != "alldebrid" || call.lot.account.is_empty() {
            report.skip("evict-adapter");
            return report;
        }
        if !config.gates.armed() {
            report.skip("evict-off");
            return report;
        }
        if *call.left == 0 {
            report.skip("evict-budget");
            return report;
        }
        let ready_hashes = hashes_of_ready(&call.lot.season_hints, call.ready);
        if ready_hashes.is_empty() {
            report.skip("evict-no-hash");
            return report;
        }
        let work = evict_job::ReadyWork {
            adapter_id: &call.lot.adapter_id,
            account: &call.lot.account,
            ready_hashes: &ready_hashes,
            br_ready_ttl_seconds: self.policy.lot_ttl_seconds,
        };
        let mut scoped = *config;
        scoped.gates.max_per_run = config.gates.max_per_run.min(*call.left);
        let report = evict_job::run(self.kv, &**debrid, &work, &scoped, now_ms).await;
        *call.left = call.left.saturating_sub(report.requested);
        report
    }
}

/// Hashes do snapshot PRÉ-step cujo hint ficou `ready` nesta passagem.
fn hashes_of_ready(
    hints: &BTreeMap<String, season_fill::SeasonHint>,
    ready: &[season_fill::SeasonHint],
) -> Vec<String> {
    if ready.is_empty() {
        return Vec::new();
    }
    hints
        .iter()
        .filter(|(_, hint)| ready.contains(hint))
        .map(|(hash, _)| hash.clone())
        .collect()
}
