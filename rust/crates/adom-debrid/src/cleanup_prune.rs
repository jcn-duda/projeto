//! Poda do acervo durável (`adprot:v1`) — porte da decisão PURA do
//! `pruneMissing` (`src/debrid/protected.ts`), que o `sweepDead` do Node roda
//! após cada listagem da conta.
//!
//! O registro de um BR retido que saiu da conta por OUTRA via é resíduo: não
//! protege nada e esconde a verdade do banco. Mas podar cedo reabre um BR
//! recém-enfileirado à limpeza, então três guardas do Node valem juntas —
//! nenhuma delas é inventada aqui, todas entram como fato:
//!
//! 1. **Ausente da conta** (`present`): a listagem da rodada não o tem;
//! 2. **Sem hold** (`held`): o download aceito agora pode ainda não constar no
//!    `/magnet/status` da varredura;
//! 3. **Velho o bastante** (`grace_ms` contado do `acceptedAt`): registro
//!    jovem demais fica — e registro SEM carimbo legível não prova idade, então
//!    sobe direto (o "corrompido" do Node).
//!
//! Zero I/O: os pares `(hash, acceptedAt)` são lidos pelo chamador; aqui só se
//! decide o que pode ser esquecido.

use std::collections::HashSet;

/// Uma linha viva do acervo durável, já recortada da chave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionEntry {
    /// Hash normalizado (minúsculo) — o sufixo da chave `adprot:v1:...`.
    pub hash: String,
    /// `acceptedAt` do registro (ms). `None` = registro sem carimbo legível:
    /// a idade não está provada e a graça NÃO o protege (lado do Node, que
    /// trata `Number(rec.acceptedAt)` falso como "sobe direto").
    pub accepted_at_ms: Option<i64>,
}

/// Hashes cujo registro durável pode sair. Ordem de entrada preservada: o
/// chamador esquece na mesma ordem em que decidiu (diagnóstico estável).
#[must_use]
pub fn prune_missing_plan(
    entries: &[RetentionEntry],
    present: &HashSet<String>,
    held: &HashSet<String>,
    grace_ms: i64,
    now_ms: i64,
) -> Vec<String> {
    entries
        .iter()
        .filter(|entry| {
            let hash = entry.hash.as_str();
            if hash.is_empty() || present.contains(hash) || held.contains(hash) {
                return false;
            }
            // A graça só protege com carimbo PROVADO e idade DENTRO da janela.
            match entry.accepted_at_ms {
                Some(accepted) if grace_ms > 0 => now_ms.saturating_sub(accepted) > grace_ms,
                _ => true,
            }
        })
        .map(|entry| entry.hash.clone())
        .collect()
}

#[cfg(test)]
#[path = "cleanup_prune_tests.rs"]
mod prune_tests;
