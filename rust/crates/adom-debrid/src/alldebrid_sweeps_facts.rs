//! Fatos e réguas numéricas da varredura (entradas da decisão).
//!
//! Tudo aqui é dado JÁ lido pelo chamador: este módulo não abre `cache.db`,
//! não chama `/magnet/status` e não lê env — é o que mantém as funções de
//! decisão puras e testáveis sem rede.

use std::collections::{HashMap, HashSet};

use super::types::{DEFAULT_EN, DEFAULT_PT};

/// Fatos que decidem a varredura, por hash normalizado.
#[derive(Debug)]
pub struct SweepFacts<'a> {
    /// Snapshot `knownBefore`. `None` = inventário frio ⇒ ninguém sai.
    pub known_before: Option<&'a HashSet<String>>,
    /// Hold volátil do autofetch (TTL por conta+hash).
    pub held: &'a HashSet<String>,
    /// Retenção BR durável (`adprot:v1:alldebrid:<conta>:<hash>`).
    pub retained: &'a HashSet<String>,
    /// Posse provada (`adsub:v1`) com o instante da etiqueta (ms).
    pub owned_at: &'a HashMap<String, i64>,
    /// Anti-reenchimento (`adrm:v1`): hash que a limpeza apagou de propósito.
    pub marked: &'a HashSet<String>,
    /// Hashes que ESTA busca consultou (o upload da própria checagem).
    pub consulted: &'a HashSet<String>,
    /// Fila de represados (`sup:`) — só a revalidação olha.
    pub suppressed: &'a HashSet<String>,
    /// Instante da decisão (ms).
    pub now_ms: i64,
}

/// Réguas numéricas da varredura. Os construtores por tipo carregam os
/// defaults do Node (`src/config/debrid*.ts`); o `Default` é o mais fechado
/// (teto 0 ⇒ nada sai) para quem esquecer de escolher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SweepConfig {
    /// Piso de idade do magnet na conta (ms).
    pub min_age_ms: i64,
    /// Teto de remoções por rodada (0 desliga a varredura).
    pub max_per_round: usize,
    /// Margem anti-re-add do reconcile (ms), só para `owned_at`.
    pub age_margin_ms: i64,
    /// Piso de ocupação: conta com `len <= floor` não é varrida (0 desliga).
    pub floor: usize,
    /// Ids por chamada de lote do executor.
    pub batch_size: usize,
    pub pt_markers: Vec<String>,
    pub en_groups: Vec<String>,
}

impl Default for SweepConfig {
    fn default() -> Self {
        Self {
            min_age_ms: 0,
            // Teto 0 = ninguém sai: um `Default` esquecido nunca apaga.
            max_per_round: 0,
            age_margin_ms: 0,
            floor: 0,
            batch_size: 8,
            pt_markers: DEFAULT_PT.iter().map(|item| (*item).to_string()).collect(),
            en_groups: DEFAULT_EN.iter().map(|item| (*item).to_string()).collect(),
        }
    }
}

impl SweepConfig {
    /// `DEBRID_SWEEP_DEAD_MIN_AGE_MS` (30 min), sem teto por rodada.
    #[must_use]
    pub fn dead() -> Self {
        Self {
            min_age_ms: 30 * 60 * 1000,
            max_per_round: usize::MAX,
            ..Self::default()
        }
    }

    /// `DEBRID_SWEEP_UNDUBBED_MIN_AGE_MS` (7 d) e `..._MAX` (100): os mais
    /// antigos saem primeiro.
    #[must_use]
    pub fn undubbed() -> Self {
        Self {
            min_age_ms: 7 * 24 * 60 * 60 * 1000,
            max_per_round: 100,
            ..Self::default()
        }
    }

    /// `DEBRID_RECONCILE_*`: piso 24 h, margem 10 min, teto 25, ocupação 0.
    #[must_use]
    pub fn reconcile() -> Self {
        Self {
            min_age_ms: 24 * 60 * 60 * 1000,
            max_per_round: 25,
            age_margin_ms: 10 * 60 * 1000,
            floor: 0,
            ..Self::default()
        }
    }

    /// `DEBRID_SUPPRESSED_REVALIDATE_MIN_AGE_MS` (30 min), margem do reconcile.
    #[must_use]
    pub fn revalidate() -> Self {
        Self {
            min_age_ms: 30 * 60 * 1000,
            max_per_round: usize::MAX,
            age_margin_ms: 10 * 60 * 1000,
            ..Self::default()
        }
    }

    /// Listas de marcadores no formato que o núcleo espera (`&[&str]`).
    pub(crate) fn markers(&self) -> (Vec<&str>, Vec<&str>) {
        (
            self.pt_markers.iter().map(String::as_str).collect(),
            self.en_groups.iter().map(String::as_str).collect(),
        )
    }

    pub(crate) fn age_limit(&self, now_ms: i64) -> i64 {
        now_ms.saturating_sub(self.min_age_ms.max(0))
    }

    pub(crate) fn margin(&self) -> i64 {
        self.age_margin_ms.max(0)
    }
}
