//! Fim do lote do Chupim na AllDebrid: a sobra da checagem volta à limpeza.
//!
//! Nesta conta "checar cache" é um `/magnet/upload` real. A checagem do
//! Chupim (`check_inner`) é read-only de propósito — o lote segura todos os
//! candidatos (`adhold`) e apagaria o que vai enfileirar no instante seguinte.
//! Só que, solto o hold dos recusados, ninguém mais olhava para eles: cada lote
//! deixava ~20 magnets em "Downloading 0%" na conta (medido no Docker local em
//! 2026-11-08, Aranhaverso e Clube da Luta) e a limpeza da busca, rodando com o
//! hold do lote vivo, os poupava.
//!
//! Aqui a sobra passa pela MESMA checagem + limpeza da busca: fatos do feed
//! nativo (inventário `knownBefore`, holds de outros lotes, `adprot`), o mesmo
//! `CheckOpts` ([`crate::verdict::alldebrid_opts`]) e o plano com a retenção
//! RELIDA na hora de cada delete. Sem feed, sem `cache.db`, com a limpeza
//! desligada ou com o plano suprimido nada sai — o lado seguro.

use std::sync::Arc;

use super::{wanted_hashes, AutofetchPorts, Backend, DebridFuture, PortError};
use crate::alldebrid_cleanup::{CleanupMode, DurablePeek};
use crate::holds_feed::HoldsFacts;

/// Fatos da limpeza para `(chave, hashes)` — o `HoldsFeed` da busca, injetado
/// pela fábrica (este crate não conhece o seam da busca).
pub type CleanupFactsFn = Arc<dyn Fn(&str, &[String]) -> Result<HoldsFacts, String> + Send + Sync>;

impl AutofetchPorts {
    /// Liga a devolução da sobra da checagem (só a AllDebrid usa).
    pub fn with_cleanup_facts(mut self, facts: CleanupFactsFn) -> Self {
        self.cleanup_facts = Some(facts);
        self
    }

    /// Hashes que o lote checou e NÃO aceitou: checagem + limpeza da busca.
    /// Devolve quantos ids o plano mandou apagar.
    pub fn release_check<'a>(&'a self, hashes: &'a [String]) -> DebridFuture<'a, usize, PortError> {
        Box::pin(self.release_check_inner(hashes))
    }

    async fn release_check_inner(&self, hashes: &[String]) -> Result<usize, PortError> {
        let Backend::AllDebrid { service, facts } = &self.backend else {
            return Ok(0);
        };
        let (Some(feed), Some(path)) = (&self.cleanup_facts, &facts.db_path) else {
            return Ok(0);
        };
        let cleanup = CleanupMode::from_env();
        let wanted = wanted_hashes(hashes);
        if !cleanup.is_on() || wanted.is_empty() {
            return Ok(0);
        }
        let holds = match feed(&self.api_key, &wanted) {
            Ok(holds) => holds,
            Err(err) => {
                eprintln!("[autofetch] sobra da checagem fica na conta: fatos ilegíveis ({err})");
                return Ok(0);
            }
        };
        let durable = DurablePeek::new(path.clone());
        let opts =
            crate::verdict::alldebrid_opts(cleanup, None, Some(&holds), &wanted, &self.api_key, &durable);
        let report = service.check_cached(&self.api_key, &wanted, &opts).await?;
        let Some(plan) = report.cleanup.filter(|plan| plan.suppressed.is_none()) else {
            return Ok(0);
        };
        let targets = plan.target_count();
        plan.run(service, &self.api_key).await;
        Ok(targets)
    }
}
