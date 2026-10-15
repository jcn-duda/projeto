//! Porte de `passesQualityFilter` (`src/utils/search-names.ts`, linhas ~68-88)
//! e das constantes de que ela depende. Vive aqui (e nao em
//! `search_name_helpers`, que porta o OUTRO arquivo, `search-name-helpers.ts`)
//! para nao colidir com a Parte do search-names; a funcao e reexportada pelo
//! modulo pai.

use std::collections::HashSet;

use crate::stream_quotas_extra::{QualityLimits, UNKNOWN_QUALITY};

/// `QUALITY_FILTER_ALIASES` do TS: "4K"/"UHD" ja viram 2160p na declaracao.
fn alias_of(filter: &str) -> String {
    match filter.to_lowercase().as_str() {
        "4k" | "uhd" => "2160p".to_string(),
        _ => filter.to_string(),
    }
}

/// A whitelist julga `_quality`, nao substring do titulo. Fonte BR sem
/// resolucao tem balde proprio (`maxUnknown`); exclui-la tornaria a cota
/// inoperante. `quality` ja vem de `streamQuality(stream)`.
///
/// `Number(unknownLimit) > 0`: `NaN` (limite sujo) NAO passa - mesmo `> 0`
/// falso do JS.
pub fn passes_quality_filter(
    quality: &str,
    is_br: bool,
    filters: &[String],
    quality_limits: &QualityLimits,
) -> bool {
    if filters.is_empty() {
        return true;
    }
    if is_br && quality == UNKNOWN_QUALITY {
        return quality_limits
            .get(UNKNOWN_QUALITY)
            .map(|&limit| limit > 0.0)
            .unwrap_or(true);
    }
    let allowed: HashSet<String> = filters.iter().map(|f| alias_of(f)).collect();
    allowed.contains(quality)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn limits(entries: &[(&str, f64)]) -> QualityLimits {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), *v))
            .collect::<HashMap<_, _>>()
    }

    #[test]
    fn sem_filtro_passa_tudo() {
        assert!(passes_quality_filter("SD", false, &[], &limits(&[])));
    }

    #[test]
    fn alias_4k_e_uhd_viram_2160p() {
        let filters = vec!["4K".to_string(), "uhd".to_string()];
        assert!(passes_quality_filter(
            "2160p",
            false,
            &filters,
            &limits(&[])
        ));
        assert!(!passes_quality_filter(
            "1080p",
            false,
            &filters,
            &limits(&[])
        ));
    }

    #[test]
    fn br_sem_resolucao_segue_max_unknown() {
        let filters = vec!["1080p".to_string()];
        let unknown_key = UNKNOWN_QUALITY.to_string();
        assert!(passes_quality_filter(
            UNKNOWN_QUALITY,
            true,
            &filters,
            &limits(&[(&unknown_key, 5.0)])
        ));
        assert!(!passes_quality_filter(
            UNKNOWN_QUALITY,
            true,
            &filters,
            &limits(&[(&unknown_key, 0.0)])
        ));
        // Sem cota declarada para o balde: passa (o TS trata undefined).
        assert!(passes_quality_filter(
            UNKNOWN_QUALITY,
            true,
            &filters,
            &limits(&[])
        ));
        // Global sem resolucao NAO tem o balde proprio.
        assert!(!passes_quality_filter(
            UNKNOWN_QUALITY,
            false,
            &filters,
            &limits(&[])
        ));
    }
}
