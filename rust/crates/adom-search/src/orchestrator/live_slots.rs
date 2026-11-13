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
//!
//! Uma coleta por chave de busca (`claim`): a resposta pelo acervo devolve
//! antes da coleta de fundo, o coalescing solta a chave e cada pedido seguinte
//! da MESMA obra abria outra coleta inteira. Medido na VPS em 2026-11-13: um
//! título popular enfileirou 230 coletas em 2 min e travou as vagas de quem
//! pedia obra nova. Com a chave em voo, a busca responde do acervo e o passe
//! tardio da coleta que já roda grava a lista.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

/// Vagas de coleta ao vivo, compartilhadas por todos os clones do
/// orquestrador (a config vive atrás de `Arc`).
#[derive(Debug, Clone, Default)]
pub struct LiveSlots {
    sem: Option<Arc<Semaphore>>,
    max: usize,
    pending: Arc<Mutex<HashSet<String>>>,
}

/// Posse da coleta de UMA chave; solta a chave ao cair.
#[derive(Debug)]
pub struct PendingGuard {
    key: Option<(Arc<Mutex<HashSet<String>>>, String)>,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Some((set, key)) = self.key.take() {
            set.lock().unwrap_or_else(|err| err.into_inner()).remove(&key);
        }
    }
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
            pending: Arc::default(),
        }
    }

    /// Toma a coleta da chave. `None` = outra busca da mesma chave ainda coleta
    /// (inclusive em fundo). Sem teto não há registro: sempre `Some`.
    pub fn claim(&self, key: &str, id: &str) -> Option<PendingGuard> {
        if self.sem.is_none() {
            return Some(PendingGuard { key: None });
        }
        let mut set = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        if !set.insert(key.to_string()) {
            eprintln!("[search] coleta de {id} já em voo; responde do acervo sem duplicar");
            return None;
        }
        Some(PendingGuard {
            key: Some((self.pending.clone(), key.to_string())),
        })
    }

    /// A chave tem coleta em voo (o refresh SWR não deve abrir outra).
    pub fn is_pending(&self, key: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .contains(key)
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
