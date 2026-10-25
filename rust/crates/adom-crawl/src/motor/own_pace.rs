//! Lane de RITMO PRÓPRIO dentro do [`CrawlMotor`] (Fase 6 — Mico).
//!
//! O Mico não é um site HTML: o adaptador tem throttle próprio
//! (`MICO_CRAWL_MIN_GAP_MS`) e o contrato do card é rodar **fora** do teto
//! horário, da janela de ociosidade e das vagas do `CRAWL_MAX_PARALLEL`. Por
//! isso esta lane não passa por nenhum desses freios: o tick a dispara em task
//! separada e o único ritmo que a segura é o do adaptador.
//!
//! O lote paralelo continua excluindo `own_pace` no `take_next_batch` — assim o
//! Mico não consome vaga nem entra na conta agregada de páginas por hora.
//!
//! Pausa global e auto-pausa (Node mudo) valem para tudo: sem entrega não há
//! razão para gastar a API.

use std::sync::Arc;

use super::mico_lane::{MicoLane, OwnPaceReport};
use super::r#loop::{BatchCtx, CrawlMotor, MotorError};

impl CrawlMotor {
    /// Liga a lane de ritmo próprio. Sem isto o motor nunca trabalha own_pace.
    pub fn with_mico(mut self, lane: Arc<MicoLane>) -> Self {
        self.mico = Some(lane);
        self
    }

    /// A lane de ritmo próprio está ligada? (diagnóstico do painel)
    pub fn own_pace_ready(&self) -> bool {
        self.mico.is_some()
    }

    /// UM passo da lane, sem agendar — o gancho determinístico dos testes.
    ///
    /// Devolve `None` quando não há lane ligada (ou sem ingestão: sem quem
    /// grave, o passo só queimaria `tries` da página).
    pub async fn own_pace_once(&self) -> Result<Option<OwnPaceReport>, MotorError> {
        let Some(lane) = self.mico.clone() else {
            return Ok(None);
        };
        if !self.ingest_ready() {
            return Ok(None);
        }
        self.ensure_store()?;
        Ok(Some(lane.step(&self.batch_ctx()).await?))
    }

    /// Dispara a lane em task separada: uma série de 40 episódios não pode
    /// segurar o tick dos sites HTML.
    pub(super) fn spawn_own_pace(&self) {
        let Some(lane) = self.mico.clone() else {
            return;
        };
        // A página do Mico passa pelo MESMO `run_one`, que agora ingere: sem
        // ingestão o passo não pode reivindicar (queimaria `tries`).
        if !self.ingest_ready() {
            return;
        }
        if !lane.try_enter() {
            return; // passo anterior ainda em curso
        }
        if let Err(e) = self.ensure_store() {
            lane.leave();
            eprintln!("[motor] mico: store indisponível ({e})");
            return;
        }
        let ctx = self.batch_ctx();
        tokio::spawn(async move {
            if let Err(e) = lane.step(&ctx).await {
                eprintln!("[motor] mico: {e}");
            }
            lane.leave();
        });
    }

    /// Contexto de execução de UMA linha (engine + ingestão + store + config).
    pub(super) fn batch_ctx(&self) -> BatchCtx {
        BatchCtx {
            engine: self.engine.clone(),
            ingest: self.ingest.clone(),
            store: self.store.clone(),
            cfg: self.config.clone(),
        }
    }
}

#[cfg(test)]
#[path = "own_pace_tests.rs"]
mod tests;
