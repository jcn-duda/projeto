//! Coletor composto: combina collectors nativos (Rust) com o `NodeCollector`.
//!
//! Permite que fontes migradas para Rust (ex.: Jackett, Torrentio) rodem nativamente
//! enquanto fontes não migradas e o inventário da conta continuam sendo colhidos
//! via `NodeCollector` (`POST /internal/search/collect`).
//!
//! Os lotes são somados em paralelo, preservando os itens por indexer. O
//! estado vivo é fundido por união; falha de subcoletor sem contrato por
//! indexer entra como agregado `error` (conservador), nunca como sucesso.
//!
//! PONTE ATÉ F2: os coletores nativos que ainda NÃO emitem estado
//! (Torrentio/BLUDV/Mico) devolvem `CollectBatch { live: None }`. Enquanto eles
//! não emitirem, a simples PRESENÇA de um lote sem contrato no composto também
//! sintetiza `unknown_failure` (agregado `error`, sem nomes). Sem isso, o estado
//! `ok` do `NodeCollector` faria os indexers nativos não citados parecerem
//! respondedores e apagaria 📦/selos que o Node preservaria. Jackett (por
//! indexer) e Prowlarr (por fonte) já entregam `live` e não passam por aqui.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use super::collect::{CollectBatch, CollectJob, Collector};
use super::live_state::LiveBatchState;
use crate::raw_item::RawItem;

/// Coletor que executa múltiplos collectors em paralelo e funde os lotes.
pub struct CompositeCollector {
    collectors: Vec<Arc<dyn Collector>>,
}

impl CompositeCollector {
    pub fn new(collectors: Vec<Arc<dyn Collector>>) -> Self {
        Self { collectors }
    }

    pub fn is_empty(&self) -> bool {
        self.collectors.is_empty()
    }

    pub fn len(&self) -> usize {
        self.collectors.len()
    }
}

/// Fusão conservadora do estado vivo: união dos conjuntos (falha de um lote
/// não é apagada pelo sucesso de outro) e `None` só quando NINGUÉM trouxe
/// contrato — coletor sem estado não prova sucesso nem falha.
fn merge_live(acc: &mut Option<LiveBatchState>, next: Option<&LiveBatchState>) {
    let Some(state) = next else { return };
    match acc {
        Some(merged) => merged.merge(state),
        None => *acc = Some(state.clone()),
    }
}

/// Lote bem-sucedido SEM contrato vivo (coletor nativo que ainda não emite
/// `live`: Torrentio/BLUDV/Mico). Não inventa nomes, mas impede que a ausência
/// de estado vire "respondeu".
fn sem_contrato(acc: &mut Option<LiveBatchState>) {
    merge_live(acc, Some(&LiveBatchState::unknown_failure()));
}

impl Collector for CompositeCollector {
    fn collect<'a>(
        &'a self,
        job: CollectJob,
    ) -> Pin<Box<dyn Future<Output = Result<CollectBatch, String>> + Send + 'a>> {
        Box::pin(async move {
            if self.collectors.is_empty() {
                return Ok(CollectBatch::default());
            }

            let mut handles = Vec::with_capacity(self.collectors.len());
            for collector in &self.collectors {
                let c = collector.clone();
                let j = job.clone();
                handles.push(tokio::spawn(async move { c.collect(j).await }));
            }

            let mut all_items: Vec<RawItem> = Vec::new();
            let mut partial = false;
            let mut live: Option<LiveBatchState> = None;
            let mut errors = Vec::new();

            for handle in handles {
                match handle.await {
                    Ok(Ok(batch)) => {
                        if batch.partial {
                            partial = true;
                        }
                        match batch.live.as_ref() {
                            Some(state) => merge_live(&mut live, Some(state)),
                            // Coletor nativo (ainda sem `live`): a ausência não
                            // pode apagar a reserva de indexers que ninguém citou.
                            None => sem_contrato(&mut live),
                        }
                        all_items.extend(batch.items);
                    }
                    Ok(Err(err)) => {
                        // Coletor individual falhou: a coleta combinada fica
                        // parcial e o estado agregado fica conservador. Sem
                        // nomes (não sabemos quais indexers dele), mas `error`
                        // impede que o lote composto vire "respondeu" — a
                        // falha preserva 📦/selos e não é apagada por sucesso.
                        partial = true;
                        merge_live(&mut live, Some(&LiveBatchState::unknown_failure()));
                        errors.push(err);
                    }
                    Err(join_err) => {
                        partial = true;
                        merge_live(&mut live, Some(&LiveBatchState::unknown_failure()));
                        errors.push(format!("tarefa de coleta cancelada: {join_err}"));
                    }
                }
            }

            // Se todos falharam, devolve erro
            if !errors.is_empty() && all_items.is_empty() && errors.len() == self.collectors.len() {
                return Err(format!(
                    "todos os coletores falharam: {}",
                    errors.join("; ")
                ));
            }

            Ok(CollectBatch {
                items: all_items,
                partial,
                live,
            })
        })
    }
}

#[cfg(test)]
#[path = "composite_collector_tests.rs"]
mod tests;
