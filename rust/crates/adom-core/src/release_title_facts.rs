//! Tudo o que o lote napi `evaluateReleases` lê só do título da release, numa
//! passada: o título é normalizado e canonizado (`js_canon`) UMA vez, e
//! normalizado, tokens, S/E e sinais PT/BR saem dessas duas leituras. Chamadas
//! avulsas (`normalize_title`, `title_tokens`, `parse_title_season_episode`,
//! `has_pt_signs`, `br_origin_mark`) refariam as mesmas contas 6 vezes.

use crate::br_origin::{br_origin_mark_canon, has_pt_signs_canon, js_canon};
use crate::episode_parse::{parse_title_season_episode_prepared, ParsedSeasonEpisode};
use crate::matching_vocabulary::normalized_title_tokens;
use crate::title_normalization::normalize_title;

/// Leituras do título; cada campo é igual à função avulsa de mesmo nome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseTitleFacts {
    /// `normalize_title(title)`.
    pub normalized: String,
    /// `title_tokens(title)`.
    pub tokens: Vec<String>,
    /// `has_pt_signs(title)`.
    pub has_pt_signs: bool,
    /// `br_origin_mark(title)`.
    pub br_origin_mark: bool,
    /// `parse_title_season_episode(title)`.
    pub parsed: ParsedSeasonEpisode,
}

/// Calcula as leituras do título reaproveitando normalização e canon.
pub fn release_title_facts(title: &str) -> ReleaseTitleFacts {
    let normalized = normalize_title(title);
    let canon = js_canon(title);
    let has_pt_signs = has_pt_signs_canon(&canon);
    ReleaseTitleFacts {
        tokens: normalized_title_tokens(&normalized),
        parsed: parse_title_season_episode_prepared(&normalized, &canon),
        br_origin_mark: br_origin_mark_canon(&canon, has_pt_signs),
        has_pt_signs,
        normalized,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{br_origin_mark, has_pt_signs, parse_title_season_episode, title_tokens};

    #[test]
    fn cada_campo_igual_a_funcao_avulsa() {
        for title in [
            "Show S01E02 1080p DUBLADO",
            "Fallout 1ª Temporada (2024) WEB-DL [1080p DUBLADO]",
            "VoxMachinaS03E10-11 [BLUDV]",
            "G.O.R.A. Apocalypse Now V.Exten",
            "Coleção Guerra nas Estrelas filmes",
            "",
        ] {
            let f = release_title_facts(title);
            assert_eq!(f.normalized, normalize_title(title), "{title}");
            assert_eq!(f.tokens, title_tokens(title), "{title}");
            assert_eq!(f.has_pt_signs, has_pt_signs(title), "{title}");
            assert_eq!(f.br_origin_mark, br_origin_mark(title), "{title}");
            assert_eq!(f.parsed, parse_title_season_episode(title), "{title}");
        }
    }
}
