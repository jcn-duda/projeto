//! Guarda, plano e destino de remoção da limpeza da AllDebrid.

use std::collections::HashSet;

use adom_core::{may_delete, DeleteFacts};

use crate::alldebrid::AllDebrid;

use super::durable::DurablePeek;
use super::holds::holds;

/// Fatos que decidem se um hash do lote pode sair. O `held` é a lista do
/// chamador; o registro volátil e o `adprot` entram por cima.
pub struct CleanupGate {
    pub drop_ready: bool,
    pub drop_uncached: bool,
    pub holds_complete: bool,
    held: HashSet<String>,
    durable: Option<std::sync::Arc<DurablePeek>>,
    account: String,
}

impl CleanupGate {
    pub fn new(
        drop_ready: bool,
        drop_uncached: bool,
        holds_complete: bool,
        held: HashSet<String>,
        durable: Option<std::sync::Arc<DurablePeek>>,
        account: &str,
    ) -> Self {
        Self {
            drop_ready,
            drop_uncached,
            holds_complete,
            held: held.into_iter().map(|hash| hash.to_lowercase()).collect(),
            durable,
            account: account.to_string(),
        }
    }

    /// O hash está a salvo? Hold do chamador OU hold volátil OU `adprot`.
    pub fn protects(&self, hash: &str, now: i64) -> bool {
        let hash = hash.to_lowercase();
        if self.held.contains(&hash) || holds().is_held(&self.account, &hash) {
            return true;
        }
        self.durable
            .as_ref()
            .is_some_and(|peek| peek.is_protected(&self.account, &hash, now))
    }
}

/// Destino de uma remoção: `id` é o que a API apaga; `hash`/`name` são o que o
/// Node precisa para gravar o `adrm` (`name` também alimenta a blindagem BR do
/// 8.4 e o diagnóstico do operador).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CleanTarget {
    pub id: String,
    pub hash: String,
    /// Nome da release no `/magnet/upload`; `None` quando a API não mandou.
    pub name: Option<String>,
}

/// Por que a limpeza não vai rodar nesta checagem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CleanupSuppressed {
    /// Flag OFF (default): a nativa é read-only.
    FlagOff,
    /// `DEBRID_AL_CLEANUP_KILL` ligado.
    KillSwitch,
    /// O chamador não provou que `held` cobre todos os holds vivos.
    HoldsIncomplete,
    /// Nem `dropReady` nem `dropUncached` pedidos.
    NoDropFlags,
    /// Sem snapshot `knownBefore` nesta rodada (fail-safe fechado).
    InventoryMissing,
}

impl CleanupSuppressed {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FlagOff => "flag_off",
            Self::KillSwitch => "kill_switch",
            Self::HoldsIncomplete => "holds_incomplete",
            Self::NoDropFlags => "no_drop_flags",
            Self::InventoryMissing => "inventory_missing",
        }
    }
}

/// Plano da checagem. `suppressed` conta o motivo; as listas só nascem quando
/// a limpeza está autorizada E o inventário existe.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CleanupPlan {
    pub ready: Vec<CleanTarget>,
    pub uncached: Vec<CleanTarget>,
    /// Hashes poupados por já serem do usuário (no snapshot).
    pub known_before: usize,
    /// Hashes poupados por hold/`adprot` (autofetch em voo ou acervo retido).
    pub protected: usize,
    pub suppressed: Option<CleanupSuppressed>,
}

impl CleanupPlan {
    pub fn suppressed(reason: CleanupSuppressed) -> Self {
        Self {
            suppressed: Some(reason),
            ..Self::default()
        }
    }

    pub fn is_empty(&self) -> bool {
        self.ready.is_empty() && self.uncached.is_empty()
    }

    pub fn target_count(&self) -> usize {
        self.ready.len() + self.uncached.len()
    }

    pub fn ids(&self) -> Vec<String> {
        self.ready
            .iter()
            .chain(self.uncached.iter())
            .map(|target| target.id.clone())
            .collect()
    }

    /// Executa o plano na fila com backoff (fire-and-forget no chamador).
    pub async fn run(
        &self,
        ad: &AllDebrid,
        api_key: &str,
    ) -> Option<crate::alldebrid_delete::DeleteReport> {
        self.run_with(
            ad,
            api_key,
            crate::alldebrid_delete::DeleteConfig::from_env(),
        )
        .await
    }

    /// Igual a [`Self::run`], com config explícita (testes sem env global).
    pub async fn run_with(
        &self,
        ad: &AllDebrid,
        api_key: &str,
        config: crate::alldebrid_delete::DeleteConfig,
    ) -> Option<crate::alldebrid_delete::DeleteReport> {
        if self.is_empty() {
            return None;
        }
        let report =
            crate::alldebrid_delete::delete_with_backoff(ad, api_key, &self.ids(), config).await;
        eprintln!(
            "[alldebrid] limpeza nativa: {} removido(s), {} falhou(ram){}",
            report.removed.len(),
            report.failed.len(),
            match report.stopped {
                Some(stop) => format!(" — parada: {}", stop.as_str()),
                None => String::new(),
            }
        );
        // NÃO devolve `removed` ao Node: este plano é só a HIGIENE da checagem
        // (`ready` + `uncached` que o próprio `/magnet/upload` criou), e o
        // `adrm` é para decisão sobre o CONTEÚDO (sweepUndubbed, evict,
        // reconcile, catálogo — que o Node grava direto). O TS da checagem
        // nunca marcava aqui (`alldebrid-check.ts::scheduleDrop`: só purga a
        // posse). Marcar transformava todo candidato fora do cache em
        // "apagado de propósito" por 3 dias e o Chupim não baixava mais nada
        // (medido em 2026-10-24: o dublado do Lanternas S01E08 bloqueado).
        // A posse (`adsub`) do que saiu fica até o TTL dela: o hash continua
        // sendo "nosso" se voltar, que é o lado seguro.
        Some(report)
    }
}

/// Decide o destino de um hash do lote. Só `CleanTarget` autoriza o delete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropVerdict {
    Delete(CleanTarget),
    Protected,
    KnownBefore,
    NoInventory,
}

/// Mesma regra do núcleo (`may_delete`): inventário carregado, hash novo e
/// sem proteção. As razões separadas alimentam o diagnóstico.
pub fn classify_drop(
    gate: &CleanupGate,
    inventory: Option<&HashSet<String>>,
    hash: &str,
    id: &str,
    now: i64,
) -> DropVerdict {
    let protected = gate.protects(hash, now);
    let known = inventory.is_some_and(|snapshot| snapshot.contains(&hash.to_lowercase()));
    let allowed = may_delete(DeleteFacts {
        inventory_loaded: inventory.is_some(),
        known_before: known,
        protected,
    });
    if allowed {
        return DropVerdict::Delete(CleanTarget {
            id: id.to_string(),
            hash: hash.to_lowercase(),
            // O nome só existe na resposta do upload; quem tiver o dado
            // (o lote) preenche depois.
            name: None,
        });
    }
    if protected {
        DropVerdict::Protected
    } else if inventory.is_none() {
        DropVerdict::NoInventory
    } else {
        DropVerdict::KnownBefore
    }
}
