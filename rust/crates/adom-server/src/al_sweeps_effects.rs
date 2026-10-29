//! Efeitos de ESTADO das varreduras: o que a rodada PROVOU e o gateway GRAVA.
//!
//! O núcleo decide (`alldebrid_sweeps`); aqui só se materializa a prova — e
//! SOMENTE no modo `Apply`: com o freio `DEBRID_AL_SWEEP_APPLY` OFF a rodada é
//! diagnóstico e nenhum registro muda de mão. Três efeitos, cada um com o
//! mesmo contrato do lado Node:
//!
//! - **`adrm` do `sweepUndubbed`** (`markReuploadBlocked`,
//!   `alldebrid-reupload.ts`): marca "apagado de propósito, não re-subir" SÓ o
//!   id que saiu DE VERDADE (`SweepOutcome::removed`) — falha de delete não
//!   marca (o magnet continua lá e a marca o esconderia da checagem à toa). A
//!   blindagem BR (`brOriginMark`) vive ANTES da escrita: nome que denuncia
//!   origem BR NUNCA marca, porque o pior caso é o lixo voltar e a varredura
//!   pegá-lo de novo — nunca condenar acervo. Só o `sweepUndubbed` marca na
//!   Fase 1: é a única remoção intencional de conteúdo desta fatia.
//! - **Poda do `adprot`** (`pruneMissing`, `protected.ts`): o registro de um BR
//!   retido que saiu da conta por outra via é resíduo. A decisão é do núcleo
//!   (`prune_missing_plan`); aqui só se lê o KV e se esquece o plano — com
//!   leitura FAIL-CLOSED: registro cujo corpo não pôde ser lido fica, e hold
//!   que não pôde ser relido (`held_checked` → `None`) adia a poda junto.
//! - **Cura da fila `sup:`** (`alldebrid-suppressed-revalidate.ts`): o
//!   represado que a rodada liquidou (ou que provou ser re-add do usuário /
//!   ter sumido) perdeu o objeto do registro. Removido de verdade leva junto a
//!   etiqueta `adsub` (`forgetSubmitted`), para um re-add futuro do usuário não
//!   herdar a posse do addon.
//!
//! O `adrm` reusa as MESMAS envs do Node (`DEBRID_REUPLOAD_BLOCK` +
//! `ALLDEBRID_REUPLOAD_BLOCK_TTL_MS`): um rollback de uma linha no `.env`
//! desliga a marca nos dois lados.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{json, Value};

use adom_autofetch::v3::SuppressedV3;
use adom_core::br_origin_mark;
use adom_debrid::alldebrid_cleanup::{
    adprot_key, adprot_prefix, adrm_key, adsub_key, reupload_block_enabled, reupload_ttl_seconds,
    RetentionEntry,
};
use adom_debrid::alldebrid_sweeps::{MagnetRow, Reason, SweepKind, SweepOutcome};
use adom_index::NativeKv;

use super::FactSource;

/// Adapter único da fila `sup:` e das marcas (`alldebrid-api.ts`).
const ADAPTER: &str = "alldebrid";

/// Portas de escrita da rodada. Produção: [`NativeEffects`]; testes gravam em
/// memória. Nenhum método decide — todo chamador já provou o que pede.
pub(crate) trait SweepEffects: Send + Sync {
    /// `adrm:v1` do hash que o `sweepUndubbed` removeu de verdade.
    fn mark_removed(&self, hash: &str, name: &str, now_ms: i64);
    /// Poda `adprot` de hash ausente da conta (guardas de hold e idade dentro).
    /// Devolve quantos registros saíram.
    fn prune_retention(
        &self,
        facts: &dyn FactSource,
        present: &HashSet<String>,
        grace_ms: i64,
        now_ms: i64,
    ) -> usize;
    /// Esquece o represado `sup:` que a rodada liquidou ou provou perdido.
    fn heal_suppressed(&self, hash: &str);
    /// Etiqueta de posse (`adsub`) do hash que saiu da conta.
    fn forget_ownership(&self, hash: &str);
}

/// Efeitos de produção sobre o `cache.db` (o MESMO do Node, via `NativeKv`).
/// `kv: None` = banco indisponível: nenhum efeito é inventado.
pub(crate) struct NativeEffects {
    account: String,
    kv: Option<Arc<NativeKv>>,
    /// `DEBRID_REUPLOAD_BLOCK` + TTL > 0, lidos UMA vez na montagem.
    mark_enabled: bool,
    mark_ttl_seconds: i64,
}

impl NativeEffects {
    pub(crate) fn new(account: &str, kv: Option<Arc<NativeKv>>) -> Self {
        Self {
            account: account.to_string(),
            kv,
            mark_enabled: reupload_block_enabled(),
            mark_ttl_seconds: reupload_ttl_seconds(),
        }
    }
}

impl SweepEffects for NativeEffects {
    fn mark_removed(&self, hash: &str, name: &str, now_ms: i64) {
        if !self.mark_enabled || self.mark_ttl_seconds <= 0 {
            return;
        }
        let hash = hash.trim().to_lowercase();
        if hash.is_empty() {
            return;
        }
        // Blindagem 8.4 no caminho de escrita: o erro certo aqui é ABSOLVER.
        if br_origin_mark(name) {
            eprintln!(
                "[al_sweeps] blindagem BR: adrm não gravado ({})",
                short_name(name)
            );
            return;
        }
        let Some(kv) = self.kv.as_ref() else {
            return;
        };
        let mut record = json!({ "at": now_ms });
        let nome = name.trim();
        if !nome.is_empty() {
            // O nome é só diagnóstico do operador (o Node corta em 160).
            record["name"] = Value::String(short_name(nome));
        }
        if let Err(err) = kv.put_json(
            &adrm_key(&self.account, &hash),
            &record,
            self.mark_ttl_seconds,
            now_ms,
        ) {
            eprintln!("[al_sweeps] adrm de {}: {err}", short_name(&hash));
        }
    }

    fn prune_retention(
        &self,
        facts: &dyn FactSource,
        present: &HashSet<String>,
        grace_ms: i64,
        now_ms: i64,
    ) -> usize {
        use adom_debrid::alldebrid_cleanup::prune_missing_plan;
        let Some(kv) = self.kv.as_ref() else {
            return 0;
        };
        let prefix = adprot_prefix(&self.account);
        let Ok(keys) = kv.keys_matching(&prefix, now_ms) else {
            return 0;
        };
        let mut entries = Vec::with_capacity(keys.len());
        for key in keys {
            let Some(hash) = key.strip_prefix(&prefix).map(str::to_lowercase) else {
                continue;
            };
            if hash.is_empty() {
                continue;
            }
            // Falha de LEITURA não é "sem carimbo": registro ilegível FICA —
            // podá-lo seria condenar o que não se conseguiu ler (fail-closed).
            let accepted_at_ms = match kv.get_json(&key, now_ms) {
                Ok(record) => record
                    .and_then(|record| record.get("acceptedAt").and_then(Value::as_i64))
                    .filter(|at| *at > 0),
                Err(err) => {
                    eprintln!(
                        "[al_sweeps] adprot ilegível ({err}): registro de {} fica",
                        short_name(&hash)
                    );
                    continue;
                }
            };
            entries.push(RetentionEntry {
                hash,
                accepted_at_ms,
            });
        }
        // O hold dos podsados é consultado VIVO e COM prova de leitura: hash
        // fora da conta não passou pelo `gather` das linhas, e hold ilegível
        // não vira "sem hold" — a entrada sai da análise e o registro fica.
        let mut held: HashSet<String> = HashSet::new();
        entries.retain(|entry| match facts.held_checked(&entry.hash) {
            Some(is_held) => {
                if is_held {
                    held.insert(entry.hash.clone());
                }
                true
            }
            None => false,
        });
        let plan = prune_missing_plan(&entries, present, &held, grace_ms, now_ms);
        let mut pruned = 0;
        for hash in &plan {
            match kv.forget(&adprot_key(&self.account, hash)) {
                Ok(true) => pruned += 1,
                Ok(false) => {}
                Err(err) => eprintln!("[al_sweeps] poda adprot de {}: {err}", short_name(hash)),
            }
        }
        if pruned > 0 {
            eprintln!(
                "[al_sweeps] poda adprot: {} registro(s) de hash fora da conta",
                pruned
            );
        }
        pruned
    }

    fn heal_suppressed(&self, hash: &str) {
        let Some(kv) = self.kv.as_ref() else {
            return;
        };
        if let Err(err) = SuppressedV3::new(kv).forget(ADAPTER, &self.account, hash) {
            eprintln!("[al_sweeps] cura do represado {}: {err}", short_name(hash));
        }
    }

    fn forget_ownership(&self, hash: &str) {
        let Some(kv) = self.kv.as_ref() else {
            return;
        };
        if let Err(err) = kv.forget(&adsub_key(&self.account, hash)) {
            eprintln!("[al_sweeps] baixa da posse {}: {err}", short_name(hash));
        }
    }
}

/// Nome truncado para log/registro — nunca um filename inteiro no eprintln.
fn short_name(name: &str) -> String {
    name.chars().take(160).collect()
}

/// Materializa a prova de UMA rodada no estado durável. Chamado SÓ com o modo
/// `Apply` — o agendador é quem obedece o freio, aqui não há segunda checagem
/// de env de propósito (um kill esquecido aqui silenciaria o efeito no Apply).
pub(crate) fn apply_effects(
    effects: &dyn SweepEffects,
    outcome: &SweepOutcome,
    rows: &[MagnetRow],
    now_ms: i64,
) {
    let by_id: HashMap<&str, &MagnetRow> = rows
        .iter()
        .filter(|row| !row.id.trim().is_empty())
        .map(|row| (row.id.trim(), row))
        .collect();
    // Fase 1: o `adrm` é SÓ do `sweepUndubbed` (higiene da checagem e morto
    // nunca marcaram no Node; o reconcile fica para uma fatia própria).
    if outcome.kind == SweepKind::Undubbed {
        for id in &outcome.removed {
            let Some(row) = by_id.get(id.as_str()) else {
                continue;
            };
            let hash = row.normalized_hash();
            if hash.is_empty() {
                continue;
            }
            effects.mark_removed(&hash, &row.name, now_ms);
        }
        return;
    }
    if outcome.kind != SweepKind::Revalidate {
        return;
    }
    // Cura da fila: o plano provou `gone` (o represado não está mais na conta)
    // e `readded` (o upload é mais novo que a etiqueta — deixou de ser nosso).
    for (hash, reason) in &outcome.skip {
        if hash.starts_with('#') {
            continue; // linha sem hash: nunca foi represado identificável
        }
        if matches!(reason, Reason::Gone | Reason::Readded) {
            effects.heal_suppressed(hash);
        }
    }
    // O que saiu DE VERDADE: registro esquecido + etiqueta `adsub` baixada.
    for id in &outcome.removed {
        let Some(row) = by_id.get(id.as_str()) else {
            continue;
        };
        let hash = row.normalized_hash();
        if hash.is_empty() {
            continue;
        }
        effects.heal_suppressed(&hash);
        effects.forget_ownership(&hash);
    }
}

#[cfg(test)]
#[path = "al_sweeps_effects_tests.rs"]
mod tests;
