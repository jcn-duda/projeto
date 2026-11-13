//! Teto de coletas ao vivo simultâneas (`SEARCH_LIVE_MAX_CONCURRENT`).
//!
//! Cada busca a frio dispara dezenas de consultas ao Jackett (e ao
//! FlareSolverr, que atende uma por vez). Medido na VPS em 2026-11-13: uma
//! busca sozinha responde em ~13 s; cinco em paralelo estouram o prazo, os
//! timeouts abrem o breaker de todos os indexers globais por 5 min e, com mais
//! carga, o Jackett fica sem descritores e derruba o container. A fila troca
//! esse desabamento por espera: quem passa do teto aguarda a vaga (FIFO), o
//! usuário recebe o aviso de "buscando" no prazo e a lista entra no cache
//! quando a coleta roda.
//!
//! A vaga vale a coleta INTEIRA, não só a janela da resposta: ela é solta
//! quando o `completion` assenta (as tarefas que seguem em fundo também batem
//! no Jackett). `0` = sem teto (default do crate e dos testes).

use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Vagas de coleta ao vivo, compartilhadas por todos os clones do
/// orquestrador (a config vive atrás de `Arc`).
#[derive(Debug, Clone, Default)]
pub struct LiveSlots {
    sem: Option<Arc<Semaphore>>,
    max: usize,
}

impl LiveSlots {
    /// `max == 0` desliga o teto.
    pub fn new(max: usize) -> Self {
        if max == 0 {
            return Self::default();
        }
        LiveSlots {
            sem: Some(Arc::new(Semaphore::new(max))),
            max,
        }
    }

    /// Produção: `SEARCH_LIVE_MAX_CONCURRENT`, default 3 (medido em
    /// 2026-11-13: 1 busca a frio ~13 s, 5 juntas desabavam). `0` desliga;
    /// valor ilegível ou negativo cai no default.
    pub fn from_env() -> Self {
        let max = std::env::var("SEARCH_LIVE_MAX_CONCURRENT")
            .ok()
            .and_then(|raw| raw.trim().parse::<usize>().ok())
            .unwrap_or(3);
        Self::new(max)
    }

    /// Teto configurado (`0` = sem teto).
    pub fn max(&self) -> usize {
        self.max
    }

    /// Vagas ocupadas agora.
    pub fn in_use(&self) -> usize {
        self.sem
            .as_ref()
            .map_or(0, |sem| self.max.saturating_sub(sem.available_permits()))
    }

    /// Espera a vez (FIFO). `None` = sem teto: a coleta corre livre.
    pub async fn acquire(&self, id: &str) -> Option<OwnedSemaphorePermit> {
        let sem = self.sem.clone()?;
        if sem.available_permits() == 0 {
            eprintln!(
                "[search] fila de coleta: {} de {} vaga(s) em uso; {id} aguarda",
                self.max, self.max
            );
        }
        // `acquire_owned` só falha com o semáforo fechado, o que nunca ocorre
        // aqui; nesse caso a coleta segue sem vaga em vez de travar a busca.
        sem.acquire_owned().await.ok()
    }
}

#[cfg(test)]
#[path = "live_slots_tests.rs"]
mod tests;
