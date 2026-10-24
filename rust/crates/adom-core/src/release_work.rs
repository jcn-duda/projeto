//! Porte puro de `src/utils/release-work.ts`: roteamento de OBRA de uma
//! release (em qual busca ela deve ser recuperável).
//!
//! Funções exportadas: `episode_parse_specificity`, `choose_episode_parse`,
//! `route_work_location`, `release_fits_request` e `release_work_targets`.
//! `WorkTarget` é `{season, episode}` com `None` no lugar de `null`.
//! `opts.year` vira `&str`: `null`/ausente vira `""`, como o
//! `String(x ?? '')` de `liveActionYearContradicts`.
//!
//! Regras de paridade com o JS:
//! - `!dn` e `dn === ''` são o mesmo caso (sem dn): `dn` vazio nunca escolhe.
//! - `${title} ${dn || ''}` deixa o espaço final quando o dn some; o texto
//!   passado ao veto de adaptação é o mesmo.
//! - `request` nulo equivale a `{season: null, episode: null}`.

use crate::episode_parse::{parse_title_season_episode, ParsedSeasonEpisode};
use crate::matching_decisions::adaptation_identity_contradicts;

/// Alvo de obra: temporada e episódio, `None` quando o TS tem `null`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkTarget {
    pub season: Option<i64>,
    pub episode: Option<i64>,
}

/// `dn` vazio não substitui o título: o TS trata `!dn` como ausente.
fn present_dn(dn: Option<&str>) -> Option<&str> {
    dn.filter(|d| !d.is_empty())
}

/// Especificidade: episódio único (S+E) > pack temporada > série/faixa > nada.
pub fn episode_parse_specificity(p: &ParsedSeasonEpisode) -> u8 {
    if p.complete || p.seasons.len() > 1 {
        return 1;
    }
    if p.seasons.is_empty() {
        return 0;
    }
    if p.episodes.len() == 1 {
        return 3;
    }
    2
}

/// `dn` só substitui o título quando declara com mais precisão (empate fica
/// com o título).
pub fn choose_episode_parse(title: &str, dn: Option<&str>) -> ParsedSeasonEpisode {
    let from_title = parse_title_season_episode(title);
    match present_dn(dn) {
        None => from_title,
        Some(dn) => {
            let from_dn = parse_title_season_episode(dn);
            if episode_parse_specificity(&from_dn) > episode_parse_specificity(&from_title) {
                from_dn
            } else {
                from_title
            }
        }
    }
}

/// Onde a release PERTENCE (uma chave), pelo título/dn.
pub fn route_work_location(request: WorkTarget, title: &str, dn: Option<&str>) -> WorkTarget {
    if request.season.is_none() {
        return request;
    }
    let parsed = choose_episode_parse(title, dn);
    if parsed.complete || parsed.seasons.len() > 1 {
        return WorkTarget {
            season: None,
            episode: None,
        };
    }
    let Some(&season) = parsed.seasons.first() else {
        return request;
    };
    let episode = match parsed.episodes.as_slice() {
        [only] => Some(*only),
        _ => None,
    };
    WorkTarget {
        season: Some(season),
        episode,
    }
}

/// Pedido sem temporada, série completa ou sem temporada no título cabe.
fn parsed_fits_request(parsed: &ParsedSeasonEpisode, request: WorkTarget) -> bool {
    let Some(season) = request.season else {
        return true;
    };
    if parsed.complete || parsed.seasons.is_empty() {
        return true;
    }
    if !parsed.seasons.contains(&season) {
        return false;
    }
    match request.episode {
        None => true,
        Some(episode) => parsed.episodes.is_empty() || parsed.episodes.contains(&episode),
    }
}

/// A release pode servir o pedido? Falso só com prova de outra obra.
pub fn release_fits_request(request: WorkTarget, title: &str, dn: Option<&str>) -> bool {
    if request.season.is_none() {
        return true;
    }
    parsed_fits_request(&choose_episode_parse(title, dn), request)
}

/// Obras em que a release deve ser recuperável. Veto de identidade por
/// adaptação (live action com ano longe da estreia) devolve lista vazia.
pub fn release_work_targets(
    title: &str,
    request: WorkTarget,
    dn: Option<&str>,
    year: &str,
) -> Vec<WorkTarget> {
    if request.season.is_none() {
        return vec![request];
    }
    let text = format!("{} {}", title, dn.unwrap_or(""));
    if adaptation_identity_contradicts(true, &text, year) {
        return Vec::new();
    }
    let parsed = choose_episode_parse(title, dn);
    let first = if parsed_fits_request(&parsed, request) {
        request
    } else {
        route_work_location(request, title, dn)
    };
    let mut out = vec![first];
    let declared = if parsed.complete || parsed.seasons.len() > 1 {
        Some(WorkTarget {
            season: None,
            episode: None,
        })
    } else if parsed.seasons.len() == 1 && parsed.episodes.len() != 1 {
        Some(WorkTarget {
            season: Some(parsed.seasons[0]),
            episode: None,
        })
    } else {
        None
    };
    if let Some(declared) = declared {
        if !out.contains(&declared) {
            out.push(declared);
        }
    }
    out
}
