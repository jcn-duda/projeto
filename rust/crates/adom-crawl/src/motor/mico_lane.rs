//! Lane de RITMO PRÓPRIO (`own_pace`) do Mico no motor Rust (Fase 6).
//!
//! O Mico não é um site HTML: a API tem throttle próprio (`min_gap_ms`) e o
//! contrato do card é "fora do teto horário, da janela de ociosidade e das
//! vagas do `CRAWL_MAX_PARALLEL`". Esta lane é o dono desse caminho:
//!
//! - **descoberta** a cada `discovery_interval_ms` (varredura completa só a
//!   cada `full_sweep_hours`; incremental entre elas, parando em páginas só
//!   com obras já na fila);
//! - **leitura** de UMA linha por passo, reivindicada por `take_next` (o lote
//!   paralelo continua excluindo `own_pace`, para não cobrar a página no teto
//!   agregado);
//! - entrega e `mark_result` pelo MESMO `run_one` dos outros sites.
//!
//! O `tick_once` dispara esta lane em task separada (uma série de 40
//! episódios não pode segurar o tick); `CrawlMotor::own_pace_once` é o gancho
//! determinístico dos testes.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::Arc;

use super::r#loop::{run_one, with_store, BatchCtx};
use super::MotorError;
use crate::mico::MicoKind;
use crate::mico_discovery::{
    discover_kind, full_sweep_key, is_full_sweep, kind_slug, MicoCrawlConfig,
};
use crate::mico_net::api::MicoApi;
use crate::motor::types::now_ms;

/// O que um passo da lane fez.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OwnPaceReport {
    /// URLs novas/atualizadas enfileiradas pela descoberta.
    pub discovered: u32,
    /// Linha reivindicada e trabalhada neste passo (0 ou 1).
    pub claimed: u32,
    /// O Node aceitou a entrega da linha.
    pub delivered: u32,
}

/// Lane do Mico: API + configuração + relógio da última descoberta.
pub struct MicoLane {
    api: Arc<dyn MicoApi>,
    cfg: MicoCrawlConfig,
    last_discovery: AtomicI64,
    busy: AtomicBool,
}

impl MicoLane {
    pub fn new(api: Arc<dyn MicoApi>, cfg: MicoCrawlConfig) -> Self {
        Self {
            api,
            cfg,
            // 0 = nunca descobriu: o primeiro passo sempre descobre.
            last_discovery: AtomicI64::new(0),
            busy: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> &MicoCrawlConfig {
        &self.cfg
    }

    /// Zera o relógio da descoberta (teste/painel: força a próxima rodada).
    pub fn force_discovery(&self) {
        self.last_discovery.store(0, Ordering::SeqCst);
    }

    /// Reserva a lane para UM passo. `false` = já há um passo em curso (uma
    /// série longa não pode ser atropelada pelo tick seguinte).
    pub fn try_enter(&self) -> bool {
        !self.busy.swap(true, Ordering::SeqCst)
    }

    /// Libera a lane ao fim do passo.
    pub fn leave(&self) {
        self.busy.store(false, Ordering::SeqCst);
    }

    /// UM passo da lane: descoberta (se vencida) + no máximo UMA página.
    /// Visível dentro de `motor`: quem chama é o `CrawlMotor` (`own_pace`).
    pub(in crate::motor) async fn step(&self, ctx: &BatchCtx) -> Result<OwnPaceReport, MotorError> {
        let mut report = OwnPaceReport::default();
        let now = now_ms();
        let ultima = self.last_discovery.load(Ordering::SeqCst);
        if now.saturating_sub(ultima) >= self.cfg.discovery_interval_ms {
            self.last_discovery.store(now, Ordering::SeqCst);
            report.discovered = self.discover(ctx, now).await?;
        }

        // Uma linha por passo: o throttle do Mico já serializa a rede e a
        // lane não ocupa vaga do lote paralelo (own_pace por definição).
        let site = self.cfg.site.clone();
        let row = with_store(ctx.store.clone(), move |db| db.take_next(&site)).await?;
        if let Some(row) = row {
            report.claimed = 1;
            let entrega = run_one(ctx.clone(), row).await;
            if entrega.delivered {
                report.delivered = 1;
            }
        }
        Ok(report)
    }

    /// Descoberta de filme e (se ligada) de série. Devolve quantas URLs
    /// entraram/foram atualizadas na fila.
    async fn discover(&self, ctx: &BatchCtx, now: i64) -> Result<u32, MotorError> {
        let kinds: Vec<MicoKind> = if self.cfg.series_enabled {
            vec![MicoKind::Movie, MicoKind::Series]
        } else {
            vec![MicoKind::Movie]
        };
        let mut total = 0u32;
        for kind in kinds {
            // 1. Marcador do tipo: decide completa × incremental.
            let site = self.cfg.site.clone();
            let key = full_sweep_key(kind);
            let last = with_store(ctx.store.clone(), move |db| db.get_state(&site, &key)).await?;
            let completa = is_full_sweep(last.as_deref(), now, self.cfg.full_sweep_hours);

            // 2. Conjunto de obras já na fila SÓ no incremental (a completa
            //    ignora o corte por conhecidas, senão nunca varreria o acervo).
            let known = if completa {
                None
            } else {
                let site = self.cfg.site.clone();
                Some(with_store(ctx.store.clone(), move |db| db.known_url_keys(&site)).await?)
            };

            let d = discover_kind(
                &*self.api,
                &self.cfg,
                kind,
                now,
                last.as_deref(),
                known.as_ref(),
                &|| false,
            )
            .await;
            if d.total_failure {
                eprintln!(
                    "[motor] mico: descoberta de {} falhou ({} requisições, {} falhas)",
                    kind_slug(kind),
                    d.request_cost,
                    d.failures.len()
                );
            }

            // 3. Enfileira (regra do `decideUpsert`: não reseta estado à toa).
            let site = self.cfg.site.clone();
            let urls = d.urls.clone();
            let enq = with_store(ctx.store.clone(), move |db| {
                db.enqueue_discovered(&site, &urls, now)
            })
            .await?;
            total = total.saturating_add(enq.added + enq.refreshed);

            // 4. Marcador de varredura COMPLETA: só com fim provado.
            if d.mark_full_sweep {
                let site = self.cfg.site.clone();
                let key = d.state_key.clone();
                let value = now.to_string();
                with_store(ctx.store.clone(), move |db| {
                    db.set_state(&site, &key, &value)
                })
                .await?;
            }
        }
        Ok(total)
    }
}
