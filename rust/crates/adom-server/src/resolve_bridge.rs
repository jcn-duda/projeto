//! Fatos do play nativo que dependem do estado da conta: hoje só `held`
//! (AllDebrid). O hold do autofetch e a retenção BR moram no KV nativo do
//! gateway, então a leitura é local: a rota `/internal/resolve/facts` do Node
//! saiu do caminho do play. Sem chave, sem KV ou leitura que falha, `held` é
//! `true` — o play NÃO apaga o frio de ninguém.
//!
//! Os EFEITOS do play (magnet, davail, prova, índice, ledger e listas) são
//! gravados pelo próprio gateway por `play_effects_native`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::al_cleanup_facts;

pub type BridgeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Fatos do play; trocável para o teste da rota injetar um `held` fixo.
pub trait PlayBridge: Send + Sync {
    /// `held` (AllDebrid): `true` = não apagar o magnet frio desta conta.
    fn held<'a>(&'a self, api_key: &'a str, hash: &'a str) -> BridgeFuture<'a, bool>;
}

/// Sem chave/KV: nada apaga o frio. Só os testes da rota a usam.
#[cfg(test)]
pub struct NoBridge;

#[cfg(test)]
impl PlayBridge for NoBridge {
    fn held<'a>(&'a self, _api_key: &'a str, _hash: &'a str) -> BridgeFuture<'a, bool> {
        Box::pin(async { true })
    }
}

/// Leitura nativa do KV do processo (`al_cleanup_facts::play_held`).
pub struct NativeBridge;

impl PlayBridge for NativeBridge {
    fn held<'a>(&'a self, api_key: &'a str, hash: &'a str) -> BridgeFuture<'a, bool> {
        Box::pin(async move { al_cleanup_facts::play_held(api_key, hash) })
    }
}

/// Ponte de produção do `/resolve`.
pub fn native() -> Arc<dyn PlayBridge> {
    Arc::new(NativeBridge)
}

#[cfg(test)]
#[path = "resolve_bridge_tests.rs"]
mod tests;
