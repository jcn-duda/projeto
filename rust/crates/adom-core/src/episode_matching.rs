//! Porte de `matchesEpisode`, `isSeasonPackRelease` e `isSeasonPackFillEligible`
//! (`src/utils/episode-matching.ts`): verificação de cobertura de episódio/pack
//! sobre um pedido de temporada+episódio.
//!
//! Depende de `crate::parse_title_season_episode`, `crate::ParsedSeasonEpisode`
//! e `crate::season_coverage_excludes` (módulo `episode_parse`).
//!
//! # Design
//!
//! As funções TS `isSeasonPackRelease` e `isSeasonPackFillEligible` recebem um
//! `StreamCandidate` e leem `stream.title || stream.name || ''`. No Rust o
//! caller resolve o título antes de chamar — o módulo não conhece o tipo
//! `StreamCandidate` (está em `adom-napi`, não aqui). Configuração externa
//! também entra como parâmetro, nunca lida de global.
//!
//! # Regras de regex
//!
//! Segue o padrão de `episode_parse.rs`: `\s` vira a classe `SP`, `\d` vira
//! `[0-9]`, padrões com `/i` casam em `js_canon(raw)`, sem `/i` casam em
//! `normalize_title(title)`. Lookbehind/lookahead exigem `fancy-regex`.

use std::sync::OnceLock;

use fancy_regex::Regex;

use crate::episode_parse::{parse_title_season_episode, season_coverage_excludes};
use crate::title_normalization::normalize_title;

/// Espaços do `\s` do ECMAScript (mesma definição de `episode_parse`).
const SP: &str = r"\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

/// Compila (uma vez por padrão) com o `__SP__` trocado pela classe de espaços.
macro_rules! re {
    ($pat:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| {
            Regex::new(&$pat.replace("__SP__", SP)).expect("padrão de matching compila")
        })
    }};
}

/// Verifica se uma release casa com um episódio específico.
///
/// Porte de `matchesEpisode`. `season` e `episode` seguem a convenção do TS:
/// quando algum dos dois é `None`, a função devolve `true` (sem pedido
/// específico, qualquer release passa).
///
/// Lógica:
/// 1. Série inteira ("Todas as Temporadas") sem temporada explícita cobre tudo.
/// 2. Faixa declarada ("1ª até 8ª Temporada Completa") filtra por faixa.
/// 3. Pack nomeado ("Nª Temporada Completa") filtra por temporada exata.
/// 4. Sem pista nenhuma no título, passa (release BR costuma vir só com o nome).
/// 5. Cobertura explícita que exclui a temporada → rejeita.
/// 6. Episódios listados que não contêm o pedido → rejeita.
pub fn matches_episode(title: &str, season: Option<i64>, episode: Option<i64>) -> bool {
    let (Some(season), Some(episode)) = (season, episode) else {
        return true;
    };

    let t = normalize_title(title);
    let parsed = parse_title_season_episode(title);

    // Série inteira ("Todas as Temporadas") sem temporada explícita cobre tudo.
    if parsed.complete && parsed.seasons.is_empty() {
        return true;
    }

    // Faixa declarada: "1ª até 8ª Temporada Completa", "1a ate 8a temporada completa".
    // O regex captura os dois números da faixa; o `season_pack` do parser garante
    // que a palavra "completa" aparece no título.
    let range_re =
        re!(r"(?<![0-9])([0-9]{1,2})[__SP__]*a?[__SP__]*(?:ate|a|to)[__SP__]*([0-9]{1,2})(?![0-9])[__SP__]*a?[__SP__]*temporada[__SP__]+completa");
    if let Some(caps) = range_re
        .captures(&t)
        .expect("regex de faixa completa executa")
    {
        let a = caps
            .get(1)
            .expect("grupo 1")
            .as_str()
            .parse::<i64>()
            .expect("dígito");
        let b = caps
            .get(2)
            .expect("grupo 2")
            .as_str()
            .parse::<i64>()
            .expect("dígito");
        let (lo, hi) = (a.min(b), a.max(b));
        if season < lo || season > hi {
            return false;
        }
    } else {
        // Pack nomeado: "Nª Temporada Completa" ou "Temporada N Completa".
        let declared_re = re!(
            r"(?<![0-9])([0-9]{1,2})[__SP__]*a?[__SP__]*temporada[__SP__]+completa|temporada[__SP__]+([0-9]{1,2})(?![0-9])[__SP__]+completa"
        );
        if let Some(caps) = declared_re
            .captures(&t)
            .expect("regex de pack declarado executa")
        {
            let declared = caps
                .get(1)
                .or_else(|| caps.get(2))
                .expect("um dos grupos")
                .as_str()
                .parse::<i64>()
                .expect("dígito");
            if declared != season {
                return false;
            }
        }
    }

    // Sem pista nenhuma: release BR pode vir só como "Nome Dublado", passa.
    if parsed.seasons.is_empty() && parsed.episodes.is_empty() {
        return true;
    }

    // Cobertura explícita que exclui a temporada pedida rejeita.
    if season_coverage_excludes(&parsed, Some(season)) {
        return false;
    }

    // Episódios listados que não contêm o pedido rejeitam.
    if !parsed.episodes.is_empty() && !parsed.episodes.contains(&episode) {
        return false;
    }

    true
}

/// A release é um pack da temporada pedida?
///
/// Porte de `isSeasonPackRelease`. Recebe o título já resolvido
/// (`stream.title || stream.name || ""` no TS).
///
/// Lógica:
/// - Série inteira sem temporada explícita → pack de qualquer uma.
/// - Episódios no título → não é pack de temporada, é episódio avulso.
/// - Temporadas listadas → a pedida está na lista?
/// - `seasonPack` ("Temporada Completa") sem temporada → a busca que trouxe
///   o item era da temporada pedida, então vale.
pub fn is_season_pack_release(title: &str, season: Option<i64>) -> bool {
    let Some(season) = season else {
        return false;
    };
    let parsed = parse_title_season_episode(title);
    if parsed.complete && parsed.seasons.is_empty() {
        return true;
    }
    if !parsed.episodes.is_empty() {
        return false;
    }
    if !parsed.seasons.is_empty() {
        return parsed.seasons.contains(&season);
    }
    parsed.season_pack
}

/// Variante estreita do `is_season_pack_release`, só para o Season Pack Fill.
///
/// Porte de `isSeasonPackFillEligible`. Recebe o título já resolvido.
///
/// Exige que o título PROVE a temporada: número casando com a pedida, ou
/// série completa ("Todas as Temporadas" cobre qualquer uma). "Temporada
/// Completa" SEM número não prova — o post do NerdFilmes anunciando S04 e
/// contendo S03 é exatamente esse caso. Semear ⚡ a partir dele promete o
/// que o pack não provou conter.
pub fn is_season_pack_fill_eligible(title: &str, season: Option<i64>) -> bool {
    let Some(season) = season else {
        return false;
    };
    let parsed = parse_title_season_episode(title);
    if !parsed.episodes.is_empty() {
        return false;
    }
    if parsed.complete && parsed.seasons.is_empty() {
        return true;
    }
    parsed.seasons.contains(&season)
}
