//! Porte puro de `src/utils/br-gap.ts`: o predicado do BR-gap que a LEITURA
//! nativa do índice precisa para decidir o follow-up (`search.idx.brGap.*`).
//!
//! Só a parte pura veio: `invalidateStreamsForObra` mexe no cache do processo e
//! continua no Node. O que o orquestrador nativo precisa é responder "o índice
//! cobre o pool, mas falta BR dublado (ou só existe abaixo da faixa alvo)?" e
//! "há alguma evidência pública de BR nesta obra?" — as duas alimentam a sonda
//! dirigida (`br_probe`) e o enfileiramento no colhedor.
//!
//! `source == "autofetch"` NUNCA conta como cobertura: o registro do Chupim
//! prova que escolhemos uma release, não que o índice tem material.

/// Fatos de UMA release do índice que o BR-gap lê. O chamador converte a linha
/// persistida (o núcleo não conhece o JSON do `idx:v14`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BrGapRelease<'a> {
    pub source: Option<&'a str>,
    pub is_br: bool,
    pub dubbed: bool,
    pub lied: bool,
    pub quality: &'a str,
}

/// Alvo de upgrade do BR-gap: 1080p (a faixa dominante do catálogo).
pub const BR_GAP_TARGET_QUALITY: &str = "1080p";
const BR_GAP_LOWER_QUALITIES: [&str; 3] = ["720p", "480p", "sd"];

fn is_br_dubbed(release: &BrGapRelease<'_>) -> bool {
    release.source != Some("autofetch") && release.is_br && release.dubbed && !release.lied
}

/// Release com hash/seeders para o Found da sonda (delta do índice).
#[derive(Clone, Copy, Debug)]
pub struct BrProbeRelease<'a> {
    pub hash: &'a str,
    pub seeders: f64,
    pub release: BrGapRelease<'a>,
}

/// Transição BR/upgrade entre duas fotos do índice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrTransition {
    None,
    Br,
    Upgrade,
}

pub fn br_transition(before: &[BrGapRelease<'_>], after: &[BrGapRelease<'_>]) -> BrTransition {
    let had_br = has_br_dubbed(before);
    if !had_br && has_br_dubbed(after) {
        return BrTransition::Br;
    }
    if had_br
        && !has_br_dubbed_at_quality(before, BR_GAP_TARGET_QUALITY)
        && has_br_dubbed_at_quality(after, BR_GAP_TARGET_QUALITY)
    {
        return BrTransition::Upgrade;
    }
    BrTransition::None
}

pub fn probe_found_viable(
    before: &[BrProbeRelease<'_>],
    after: &[BrProbeRelease<'_>],
    require_quality: Option<&str>,
) -> bool {
    let prior: std::collections::HashSet<String> = before
        .iter()
        .filter(|release| !release.hash.is_empty())
        .map(|release| release.hash.to_ascii_lowercase())
        .collect();
    after.iter().any(|release| {
        !release.hash.is_empty()
            && !prior.contains(&release.hash.to_ascii_lowercase())
            && is_br_dubbed(&release.release)
            && release.seeders > 0.0
            && require_quality
                .is_none_or(|quality| release.release.quality.eq_ignore_ascii_case(quality))
    })
}

/// "BR dublado comprovado": BR, dublado e não condenado pela auditoria.
pub fn has_br_dubbed(releases: &[BrGapRelease<'_>]) -> bool {
    releases.iter().any(is_br_dubbed)
}

/// Evidência PÚBLICA de origem BR (mesmo legendada/sem a faixa alvo).
pub fn has_br_evidence(releases: &[BrGapRelease<'_>]) -> bool {
    releases
        .iter()
        .any(|release| release.source != Some("autofetch") && release.is_br)
}

/// BR dublado comprovado na faixa pedida (comparação exata, case-insensitive).
pub fn has_br_dubbed_at_quality(releases: &[BrGapRelease<'_>], quality: &str) -> bool {
    releases
        .iter()
        .any(|release| is_br_dubbed(release) && release.quality.eq_ignore_ascii_case(quality))
}

/// Upgrade: há BR dublado, mas só em faixa CONHECIDA inferior à alvo. 1080p ou
/// 2160p já presentes fecham a lacuna (4K cobre o objetivo do upgrade).
pub fn has_br_dubbed_below_target(releases: &[BrGapRelease<'_>]) -> bool {
    if has_br_dubbed_at_quality(releases, BR_GAP_TARGET_QUALITY) {
        return false;
    }
    if has_br_dubbed_at_quality(releases, "2160p") {
        return false;
    }
    releases.iter().any(|release| {
        is_br_dubbed(release)
            && BR_GAP_LOWER_QUALITIES
                .iter()
                .any(|lower| release.quality.eq_ignore_ascii_case(lower))
    })
}

/// Decisão BR-gap: cobre o pool e (não tem BR dublado OU só tem abaixo da
/// alvo), com index-only configurados (sem eles o colhedor não teria onde
/// buscar).
pub fn should_br_gap(releases: &[BrGapRelease<'_>], index_only_configured: bool) -> bool {
    if !index_only_configured {
        return false;
    }
    !has_br_dubbed(releases) || has_br_dubbed_below_target(releases)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel<'a>(
        is_br: bool,
        dubbed: bool,
        quality: &'a str,
        source: Option<&'a str>,
    ) -> BrGapRelease<'a> {
        BrGapRelease {
            source,
            is_br,
            dubbed,
            lied: false,
            quality,
        }
    }

    #[test]
    fn autofetch_nao_prova_br() {
        let list = [rel(true, true, "1080p", Some("autofetch"))];
        assert!(!has_br_dubbed(&list));
        assert!(!has_br_evidence(&list));
        // Sem BR dublado, covered + index-only abriria gap; a fonte Chupim não
        // pode segurar a sonda como se fosse cobertura.
        assert!(should_br_gap(&list, true));
    }

    #[test]
    fn upgrade_so_com_faixa_inferior_conhecida() {
        assert!(has_br_dubbed_below_target(&[rel(true, true, "720p", None)]));
        assert!(!has_br_dubbed_below_target(&[rel(
            true, true, "1080p", None
        )]));
        assert!(!has_br_dubbed_below_target(&[rel(
            true, true, "2160p", None
        )]));
        // Sem resolução não abre upgrade (senão o colhedor colhe para sempre).
        assert!(!has_br_dubbed_below_target(&[rel(true, true, "", None)]));
    }

    #[test]
    fn lied_nao_e_prova() {
        let mut release = rel(true, true, "1080p", None);
        release.lied = true;
        assert!(!has_br_dubbed(&[release]));
        assert!(has_br_evidence(&[release]), "lied não apaga a origem BR");
    }

    #[test]
    fn should_br_gap_exige_index_only() {
        let list = [rel(true, false, "720p", None)];
        assert!(!should_br_gap(&list, false));
        assert!(should_br_gap(&list, true));
        let only_hd = [rel(true, true, "1080p", None)];
        assert!(!should_br_gap(&only_hd, true));
    }
}

#[cfg(test)]
#[path = "br_gap_outcome_tests.rs"]
mod outcome_tests;
