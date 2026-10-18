//! Priorização da fila do colhedor — espelho de `prioritizeQueue` /
//! `brEvidenceRank` / `priorityTier` em `src/providers/harvest-queue.ts`.
//!
//! # Contrato
//!
//! - Urgências (`next-episode`, `br-gap` recente) ficam acima do tier regular
//!   com `br_first` ligado **ou** desligado.
//! - No tier regular, com `br_first`, a ordem é evidência BR → anti-fome → FIFO.
//! - Contagem pura **não** decide: só o callback [`BrEvidence`] (espelho de
//!   `hasBrDubbed(lookupQuiet(...))`). Índice real ainda **não** é plugado.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::reason::{entry_identity, is_recent_br_gap, obra_identity};
use crate::types::HarvestEntry;

/// Config da priorização (fatia de `harvesterLive.effective()` / `HARVEST_BR_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrioritizeConfig {
    /// `HARVEST_BR_FIRST` — rank de evidência BR no tier regular.
    pub br_first: bool,
    /// `HARVEST_BR_MAX_WAIT_MS` — anti-fome no tier regular (`0` = desligado).
    pub br_max_wait_ms: i64,
}

impl Default for PrioritizeConfig {
    fn default() -> Self {
        Self {
            br_first: true,
            br_max_wait_ms: 6 * 3600 * 1000,
        }
    }
}

/// Evidência BR injetável — espelho de `hasBrDubbed(lookupQuiet(...))`.
///
/// Não pluga o índice real. Testes (e a ponte futura) fornecem a implementação.
pub trait BrEvidence {
    /// Espelho de `releaseIndex.lookupQuiet(imdb, { season, episode })`:
    /// presença de releases para a obra (não decide dublagem).
    fn lookup(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool;

    /// Espelho de `hasBrDubbed(releases)` — BR dublado comprovado (não `lied`).
    /// É o que [`br_evidence_rank`] consulta; contagem pura nunca entra aqui.
    fn has_br_dubbed(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool;
}

/// Callback: `(imdb_id, season, episode) -> has_br_dubbed` (lookup = mesmo valor).
impl<F> BrEvidence for F
where
    F: Fn(&str, Option<i32>, Option<i32>) -> bool,
{
    fn lookup(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        (self)(imdb_id, season, episode)
    }

    fn has_br_dubbed(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        (self)(imdb_id, season, episode)
    }
}

/// Stub em memória: conjunto de identidades (`obra_identity`) com BR dublado.
#[derive(Debug, Clone, Default)]
pub struct StubBrEvidence {
    dubbed: HashSet<String>,
}

impl StubBrEvidence {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_dubbed(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            dubbed: ids.into_iter().map(Into::into).collect(),
        }
    }

    pub fn insert(&mut self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) {
        self.dubbed.insert(obra_identity(imdb_id, season, episode));
    }
}

impl BrEvidence for StubBrEvidence {
    fn lookup(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        self.has_br_dubbed(imdb_id, season, episode)
    }

    fn has_br_dubbed(&self, imdb_id: &str, season: Option<i32>, episode: Option<i32>) -> bool {
        self.dubbed
            .contains(&obra_identity(imdb_id, season, episode))
    }
}

/// Rank de evidência BR (Fase 3.2): play real > índice BR dublado > nada.
///
/// Nunca escreve no debrid. Contagem de releases **não** decide — só
/// [`BrEvidence::has_br_dubbed`].
pub fn br_evidence_rank(entry: &HarvestEntry, evidence: &dyn BrEvidence) -> u8 {
    if entry.reason == "next-episode" {
        return 3;
    }
    if evidence.has_br_dubbed(&entry.imdb_id, entry.season, entry.episode) {
        return 2;
    }
    0
}

/// Tier de precedência (Fase 5): `next-episode` > `br-gap` recente > regular.
pub fn priority_tier(entry: &HarvestEntry, now_ms: i64) -> u8 {
    if entry.reason == "next-episode" {
        return 2;
    }
    if is_recent_br_gap(entry, now_ms) {
        return 1;
    }
    0
}

/// Ordena a fila e devolve **uma cópia** — nunca muta a entrada.
///
/// Espelho de `prioritizeQueue` no TS. Com `br_first` desligado, o tier
/// regular volta a FIFO; urgências operacionais seguem no topo.
pub fn prioritize(
    queue: &[HarvestEntry],
    config: &PrioritizeConfig,
    evidence: &dyn BrEvidence,
    now_ms: i64,
) -> Vec<HarvestEntry> {
    let wait = config.br_max_wait_ms;
    let mut rank: HashMap<String, u8> = HashMap::new();
    if config.br_first {
        for e in queue {
            rank.insert(entry_identity(e), br_evidence_rank(e, evidence));
        }
    }

    let mut out = queue.to_vec();
    out.sort_by(|a, b| {
        let ta = priority_tier(a, now_ms);
        let tb = priority_tier(b, now_ms);
        if ta != tb {
            return tb.cmp(&ta);
        }
        if !config.br_first {
            return a.enqueued_at.cmp(&b.enqueued_at);
        }
        let ra = rank.get(&entry_identity(a)).copied().unwrap_or(0);
        let rb = rank.get(&entry_identity(b)).copied().unwrap_or(0);
        let a_starved = wait > 0 && now_ms - a.enqueued_at >= wait && ra == 0;
        let b_starved = wait > 0 && now_ms - b.enqueued_at >= wait && rb == 0;
        if a_starved != b_starved {
            return if a_starved {
                Ordering::Less
            } else {
                Ordering::Greater
            };
        }
        if ra != rb {
            return rb.cmp(&ra);
        }
        a.enqueued_at.cmp(&b.enqueued_at)
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reason::BR_GAP_PRIORITY_WINDOW_MS;
    use crate::types::HarvestMediaType;

    const NOW: i64 = 1_700_000_000_000;

    fn movie(imdb: &str, reason: &str, enqueued_at: i64) -> HarvestEntry {
        HarvestEntry {
            imdb_id: imdb.into(),
            media_type: HarvestMediaType::Movie,
            season: None,
            episode: None,
            reason: reason.into(),
            enqueued_at,
            priority_at: if reason == "br-gap" {
                Some(enqueued_at)
            } else {
                None
            },
            resumed: false,
            br_probe: false,
            full_base: false,
        }
    }

    fn series(
        imdb: &str,
        season: i32,
        episode: i32,
        reason: &str,
        enqueued_at: i64,
    ) -> HarvestEntry {
        HarvestEntry {
            imdb_id: imdb.into(),
            media_type: HarvestMediaType::Series,
            season: Some(season),
            episode: Some(episode),
            reason: reason.into(),
            enqueued_at,
            priority_at: None,
            resumed: false,
            br_probe: false,
            full_base: false,
        }
    }

    fn ids(out: &[HarvestEntry]) -> Vec<&str> {
        out.iter().map(|e| e.imdb_id.as_str()).collect()
    }

    #[test]
    fn evidencia_br_antes_de_fifo_e_next_episode_no_topo() {
        // Espelho harvester-priority 3.2: next-episode > índice-BR > FIFO.
        let a = movie("tt3000001", "next-episode", NOW - 1000);
        let b = movie("tt3000002", "miss", NOW - 900);
        let c = movie("tt3000003", "popular", NOW - 800);
        let mut ev = StubBrEvidence::new();
        ev.insert("tt3000002", None, None);
        let cfg = PrioritizeConfig::default();
        let out = prioritize(&[a, b, c], &cfg, &ev, NOW);
        assert_eq!(ids(&out), ["tt3000001", "tt3000002", "tt3000003"]);
    }

    #[test]
    fn callback_fn_tambem_serve_de_evidence() {
        let a = movie("tt3000002", "miss", NOW - 900);
        let b = movie("tt3000003", "popular", NOW - 800);
        let evidence = |imdb: &str, _: Option<i32>, _: Option<i32>| imdb == "tt3000002";
        let out = prioritize(
            &[b.clone(), a.clone()],
            &PrioritizeConfig::default(),
            &evidence,
            NOW,
        );
        assert_eq!(ids(&out), ["tt3000002", "tt3000003"]);
    }

    #[test]
    fn anti_fome_sobe_antiga_sem_furar_next_episode() {
        let old = movie("tt3000010", "popular", NOW - 5000);
        let fresh = movie("tt3000011", "next-episode", NOW);
        let cfg = PrioritizeConfig {
            br_first: true,
            br_max_wait_ms: 1000,
        };
        let ev = StubBrEvidence::new();
        let out = prioritize(&[fresh, old], &cfg, &ev, NOW);
        assert_eq!(ids(&out), ["tt3000011", "tt3000010"]);
    }

    #[test]
    fn anti_fome_sobe_antiga_sobre_fifo_no_tier_regular() {
        let starved = movie("tt3000014", "popular", NOW - 5000);
        let fresh = movie("tt3000015", "popular", NOW);
        let cfg = PrioritizeConfig {
            br_first: true,
            br_max_wait_ms: 1000,
        };
        let out = prioritize(&[fresh, starved], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3000014", "tt3000015"]);
    }

    #[test]
    fn max_wait_zero_desliga_anti_fome() {
        let old = movie("tt3000012", "popular", 1);
        let next = series("tt3000013", 1, 2, "next-episode", NOW);
        let cfg = PrioritizeConfig {
            br_first: true,
            br_max_wait_ms: 0,
        };
        let out = prioritize(&[old, next], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3000013", "tt3000012"]);
    }

    #[test]
    fn br_first_false_fifo_entre_regulares_urgencias_no_topo() {
        let popular = movie("tt3100011", "popular", NOW - 10 * 60 * 1000);
        let br_gap = movie("tt3100012", "br-gap", NOW - 2 * 60 * 1000);
        let next = series("tt3100013", 1, 1, "next-episode", NOW - 60_000);
        let cfg = PrioritizeConfig {
            br_first: false,
            br_max_wait_ms: 6 * 3600 * 1000,
        };
        let out = prioritize(&[popular, br_gap, next], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3100013", "tt3100012", "tt3100011"]);

        let reg_nova = movie("tt3100015", "popular", NOW);
        let reg_antiga = movie("tt3100016", "miss", NOW - 5 * 60 * 1000);
        let out2 = prioritize(&[reg_nova, reg_antiga], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out2), ["tt3100016", "tt3100015"]);
    }

    #[test]
    fn br_gap_recente_acima_do_anti_fome() {
        let starved = movie("tt3100001", "popular", NOW - 7 * 3600 * 1000);
        let br_gap = movie("tt3100002", "br-gap", NOW - 5 * 60 * 1000);
        let cfg = PrioritizeConfig::default();
        let out = prioritize(&[starved, br_gap], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3100002", "tt3100001"]);
    }

    #[test]
    fn br_gap_fora_da_janela_cede_ao_anti_fome() {
        let starved = movie("tt3100031", "popular", NOW - 7 * 3600 * 1000);
        let old_br = movie("tt3100032", "br-gap", NOW - 2 * 3600 * 1000);
        // priority_at = enqueued_at → fora da janela de 1h.
        assert!(!is_recent_br_gap(&old_br, NOW));
        assert!(NOW - old_br.enqueued_at >= BR_GAP_PRIORITY_WINDOW_MS);
        let cfg = PrioritizeConfig::default();
        let out = prioritize(&[old_br, starved], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3100031", "tt3100032"]);
    }

    #[test]
    fn priority_at_recente_mantem_tier_mesmo_com_enqueued_antigo() {
        let starved = movie("tt3400002", "popular", NOW - 7 * 3600 * 1000);
        let mut promoted = movie("tt3400003", "br-gap", NOW - 7 * 3600 * 1000);
        promoted.priority_at = Some(NOW - 60_000);
        let cfg = PrioritizeConfig::default();
        let out = prioritize(&[starved, promoted], &cfg, &StubBrEvidence::new(), NOW);
        assert_eq!(ids(&out), ["tt3400003", "tt3400002"]);
    }

    #[test]
    fn lookup_sozinho_nao_decide_rank_sem_has_br_dubbed() {
        // Contagem/presença ≠ evidência BR: lookup true + has_br_dubbed false
        // não eleva a obra (guardrail do Arquivista).
        struct SoLookup;
        impl BrEvidence for SoLookup {
            fn lookup(&self, _: &str, _: Option<i32>, _: Option<i32>) -> bool {
                true
            }
            fn has_br_dubbed(&self, _: &str, _: Option<i32>, _: Option<i32>) -> bool {
                false
            }
        }
        let a = movie("tt4000001", "miss", NOW - 100);
        let b = movie("tt4000002", "miss", NOW - 50);
        let out = prioritize(
            &[b.clone(), a.clone()],
            &PrioritizeConfig::default(),
            &SoLookup,
            NOW,
        );
        // Sem evidência BR: FIFO por enqueued_at (a mais antiga primeiro).
        assert_eq!(ids(&out), ["tt4000001", "tt4000002"]);
        assert_eq!(br_evidence_rank(&a, &SoLookup), 0);
        assert!(SoLookup.lookup("tt4000001", None, None));
    }
}
