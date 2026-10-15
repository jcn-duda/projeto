//! Porte puro de `src/providers/autofetch-progress.ts` — derivação CONSERVADORA
//! de parada por progresso (Fase 3 do Chupim 2.0).
//!
//! Serviços com `progress` medido (hoje só o AllDebrid) não têm sinal NATIVO de
//! parada. Este módulo guarda, POR `adapter:account:hash`, os últimos bytes
//! vistos, o id da transferência e o streak de observações CONSECUTIVAS paradas.
//! Um hash vira `stalled` derivado SÓ quando bytes E velocidade ficam parados
//! por N rechecks seguidos; qualquer evidência contrária zera. Falso positivo
//! condena um download que ainda esquentava, então a regra erra para o lado de
//! NÃO condenar:
//!
//! - bytes crescendo: movimento real, zera o streak;
//! - `speed > 0` é movimento e zera o streak, mesmo com `seeders: 0` (seeders
//!   zero nunca sobrepõe velocidade positiva);
//! - regressão de bytes ou troca da transferência (id diferente): SEM sinal,
//!   memória reiniciada;
//! - `total <= 0`, `bytes >= total`, campos ausentes/não numéricos, sem
//!   progresso ou `state != "downloading"`: SEM sinal (mantém o legado);
//! - `threshold <= 0` desliga a derivação por inteiro.
//!
//! DIVERGÊNCIA do TS: lá a memória é um `Map` global de PROCESSO; aqui ela é
//! INJETADA pelo chamador (`&mut ProgressMemory`), o que torna `derive_stall`
//! puro e testável. O contrato de limpeza (fim de lote não herda streak) segue
//! valendo via `forget_progress`/`forget_lot_progress`.

use std::collections::{HashMap, HashSet};

/// Janela de progresso de UMA chave `adapter:account:hash`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProgressEntry {
    /// Últimos bytes vistos na transferência.
    pub last_bytes: f64,
    /// Id da transferência da última leitura (`""` quando o serviço não dá id).
    pub last_id: String,
    /// Observações CONSECUTIVAS paradas (bytes iguais + speed <= 0).
    pub streak: i64,
}

/// Memória de progresso injetada. No TS é um `Map` global de processo; aqui o
/// chamador é dono do estado, o que mantém `derive_stall` puro.
#[derive(Debug, Clone, Default)]
pub struct ProgressMemory {
    entries: HashMap<String, ProgressEntry>,
}

impl ProgressMemory {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tamanho da memória — observabilidade de vazamento em teste/painel.
    pub fn size(&self) -> usize {
        self.entries.len()
    }
}

/// Progresso medido de uma transferência (campos do `/magnet/status`).
/// Campo ausente/não numérico vira `NAN` — o guarda `is_finite` o descarta.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TorrentProgress {
    pub bytes: f64,
    pub total: f64,
    pub speed: f64,
    pub seeders: f64,
}

/// Status de UM hash numa passagem. Só o que `derive_stall` lê.
#[derive(Debug, Clone, PartialEq)]
pub struct TorrentStatus {
    /// `downloading`/`queued`/`processing`/`unknown`/`ready`/`dead`.
    pub state: String,
    /// Id da transferência (`None` quando o serviço não dá — vira `""`).
    pub id: Option<String>,
    /// Progresso medido; `None` = serviço sem sinal (ou item pronto/morto).
    pub progress: Option<TorrentProgress>,
}

/// Lote de hashes de UM adapter+conta com o limiar de streak.
#[derive(Debug, Clone)]
pub struct ProgressLot<'a> {
    pub adapter_id: &'a str,
    pub account: &'a str,
    pub hashes: &'a [String],
    /// `autoFetchStallStreak`; `<= 0` desliga a derivação.
    pub threshold: i64,
}

/// Resultado de uma passagem: hashes que cruzaram o limiar + sinais válidos.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProgressDerivation {
    /// Hashes que cruzaram o limiar: o recheck colapsa como PARADO derivado.
    pub stalled: HashSet<String>,
    /// Quantos hashes trouxeram progresso VÁLIDO nesta passagem (observável).
    pub signals: usize,
}

/// Chave de memória: `adapter:account:hash` com o hash em minúsculas.
/// Paridade com `memoryKey` do TS (`String(hash || '').toLowerCase()`).
fn memory_key(adapter_id: &str, account: &str, hash: &str) -> String {
    format!("{adapter_id}:{account}:{}", hash.to_lowercase())
}

/// Reinicia a janela de uma chave (baseline/regressão/troca/movimento).
fn reset(memory: &mut ProgressMemory, key: &str, bytes: f64, id: &str) {
    memory.entries.insert(
        key.to_string(),
        ProgressEntry {
            last_bytes: bytes,
            last_id: id.to_string(),
            streak: 0,
        },
    );
}

/// Lê o progresso da passagem, atualiza a memória e devolve os hashes que
/// cruzaram o limiar. Puro quanto a rede: só olha `statuses`.
///
/// `statuses` é consultado pelo hash em minúsculas e, na falta, pelo hash cru
/// (paridade com `statuses[hash] ?? statuses[rawHash]` do TS).
pub fn derive_stall(
    memory: &mut ProgressMemory,
    lot: &ProgressLot,
    statuses: &HashMap<String, TorrentStatus>,
) -> ProgressDerivation {
    let mut out = ProgressDerivation::default();
    for raw_hash in lot.hashes {
        let hash = raw_hash.to_lowercase();
        let status = match statuses
            .get(&hash)
            .or_else(|| statuses.get(raw_hash.as_str()))
        {
            Some(s) => s,
            None => continue,
        };
        // Sem progresso = serviço sem sinal (ou item pronto/morto). Mantém o
        // legado e NÃO mexe na memória: uma janela sem campo não é prova de nada.
        let Some(p) = status.progress else { continue };
        // Só download ATIVO vira parada: queued/processing/unknown/ready/dead não.
        if status.state != "downloading" {
            continue;
        }
        let (bytes, total, speed, seeders) = (p.bytes, p.total, p.speed, p.seeders);
        if !bytes.is_finite()
            || !total.is_finite()
            || !speed.is_finite()
            || !seeders.is_finite()
            || total <= 0.0
            || bytes < 0.0
        {
            continue;
        }
        // Completo/limítrofe (bytes >= total) não é parada útil — o ready cuida.
        if bytes >= total {
            continue;
        }
        out.signals += 1;
        let id = status.id.clone().unwrap_or_default();
        let key = memory_key(lot.adapter_id, lot.account, &hash);
        let prev = memory.entries.get(&key).cloned();
        // Troca da transferência: a leitura anterior era de OUTRO download.
        if let Some(prev) = &prev {
            if !prev.last_id.is_empty() && !id.is_empty() && prev.last_id != id {
                reset(memory, &key, bytes, &id);
                continue;
            }
        }
        let Some(prev) = prev else {
            reset(memory, &key, bytes, &id);
            continue;
        };
        // Regressão de bytes: sem sinal, reinicia a janela.
        if bytes < prev.last_bytes {
            reset(memory, &key, bytes, &id);
            continue;
        }
        // Bytes crescendo: movimento real, zera o streak.
        if bytes > prev.last_bytes {
            reset(memory, &key, bytes, &id);
            continue;
        }
        // Bytes parados. Velocidade POSITIVA é evidência de movimento e zera —
        // mesmo com `seeders: 0`, que nunca sobrepõe a velocidade. Só a ausência
        // de movimento (speed <= 0) deixa o streak acumular.
        if speed > 0.0 {
            reset(memory, &key, bytes, &id);
            continue;
        }
        let streak = prev.streak + 1;
        memory.entries.insert(
            key,
            ProgressEntry {
                last_bytes: bytes,
                last_id: id,
                streak,
            },
        );
        if lot.threshold > 0 && streak >= lot.threshold {
            out.stalled.insert(hash);
        }
    }
    out
}

/// Limpa a memória de UM hash (fim do hash no lote).
pub fn forget_progress(memory: &mut ProgressMemory, adapter_id: &str, account: &str, hash: &str) {
    let key = memory_key(adapter_id, account, hash);
    memory.entries.remove(&key);
}

/// Limpa a memória de um lote inteiro (expira/evicção).
pub fn forget_lot_progress(
    memory: &mut ProgressMemory,
    adapter_id: &str,
    account: &str,
    hashes: &[String],
) {
    for hash in hashes {
        forget_progress(memory, adapter_id, account, hash);
    }
}

/// Tamanho da memória — observabilidade de vazamento em teste/painel.
pub fn progress_memory_size(memory: &ProgressMemory) -> usize {
    memory.size()
}
