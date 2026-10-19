//! Porte de `matchesEpisodeWorkIdentity` e `matchesGlobalSeriesNoMarker` de
//! `src/utils/release-title-rules.ts`.
//!
//! As duas funções são guardas de identidade de obra em release GLOBAL:
//! - `matchesEpisodeWorkIdentity`: o trecho que o marcador SxxEyy delimita
//!   pertence ao universo de nomes da obra?
//! - `matchesGlobalSeriesNoMarker`: filme/spin-off da mesma franquia sem
//!   marcador de temporada/episódio passa pelo portão de precisão?
//!
//! Ambas leem `config.search.titlePrecisionTailCut` no TS; aqui recebem
//! `cut_tail: bool` (mesmo padrão de `matches_br_title`).
//!
//! Depende de:
//! - `episode_work_tokens` (em `matching_tokens`)
//! - `title_precision` (em `matching_decisions`)
//! - `title_tokens` (em `matching_vocabulary`)
//! - `parse_title_season_episode` (em `episode_parse`)
//!
//! A regex de etiqueta inicial (`LEADING_RELEASE_TAG_RE`) é duplicada de
//! `release_title_rules` porque lá é privada; a lógica é idêntica.

use std::sync::OnceLock;

use regex::Regex;

use crate::episode_parse::{parse_title_season_episode, ParsedSeasonEpisode};
use crate::matching_decisions::title_precision;
use crate::matching_tokens::episode_work_tokens;
use crate::matching_vocabulary::title_tokens;

/// Piso de precisão para série (independente de `cut_tail`).
/// No TS: `SERIES_TITLE_PRECISION_MIN = 0.70`.
const SERIES_TITLE_PRECISION_MIN: f64 = 0.70;

/// `\s` do JS (WhiteSpace + LineTerminator), escrito como classe do crate
/// `regex`. Mesma definição de `release_title_rules.rs`.
const JS_WS: &str = "\\t\\n\\x{0B}\\x{0C}\\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}";

/// `LEADING_RELEASE_TAG_RE`: etiqueta de uploader/site no começo do título.
/// Duplicada de `release_title_rules` (lá é privada). O padrão é idêntico.
const LEADING_TAG_PATTERN: &str = "^(?:[{WS}]*(?:\\[[^\\]]{1,40}\\]|\\([^)]{1,40}\\)|\\{[^}]{1,40}\\}|(?i:www)\\.[a-zA-Z0-9-]+(?:\\.[a-zA-Z]{2,})+[{WS}]*[-\u{2013}:|]?))+[{WS}]*";

fn expand_ws(pattern: &str) -> String {
    pattern.replace("{WS}", JS_WS)
}

fn leading_release_tag() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&expand_ws(LEADING_TAG_PATTERN)).expect("regex da etiqueta inicial")
    })
}

/// `matchesEpisodeWorkIdentity`: guarda de identidade de obra em release
/// GLOBAL por episódio. O trecho que o marcador SxxEyy delimita tem que
/// pertencer ao universo de nomes da obra.
///
/// No TS:
/// ```typescript
/// function matchesEpisodeWorkIdentity(
///   title: string,
///   allNames: string[] | null,
///   tokens: string[] | null = null,
///   universeTokens: string[] | null = null,
/// ) {
///   if (!allNames?.length) return true;
///   const untagged = title.replace(LEADING_RELEASE_TAG_RE, '');
///   const own = untagged !== title && untagged ? titleTokens(untagged) : tokens || titleTokens(title);
///   const work = episodeWorkTokens(own);
///   if (!work) return true;
///   const universe = universeTokens || allNames.flatMap(...);
///   const cutTail = config.search?.titlePrecisionTailCut !== false;
///   return titlePrecision(work, universe, { cutTail }) >= SERIES_TITLE_PRECISION_MIN;
/// }
/// ```
///
/// `all_names` é `None` quando o TS recebe `null`; lista vazia (`Some(&[])`)
/// devolve `true` (sem nomes para medir). `cut_tail` espelha
/// `config.search.titlePrecisionTailCut` (default `true`).
pub fn matches_episode_work_identity(
    title: &str,
    all_names: Option<&[String]>,
    tokens: Option<&[String]>,
    universe_tokens: Option<&[String]>,
    cut_tail: bool,
) -> bool {
    // Sem `allNames` ou lista vazia: não há o que medir, passa.
    let Some(names) = all_names else {
        return true;
    };
    if names.is_empty() {
        return true;
    }

    // Tira a etiqueta de uploader do começo ("[ReQ]True Detective s01e01…").
    // Se tirou algo, usa o título sem etiqueta; senão, usa `tokens` ou
    // normaliza o título cru.
    let untagged = leading_release_tag().replace(title, "").into_owned();
    let own: Vec<String> = if !untagged.is_empty() && untagged != title {
        title_tokens(&untagged)
    } else {
        match tokens {
            Some(t) => t.to_vec(),
            None => title_tokens(title),
        }
    };

    // `episodeWorkTokens`: extrai o trecho que nomeia a obra (antes do SxxEyy).
    // `None` quando não há marcador de episódio — sem marcador, não há o que
    // delimitar, a função se abstém (devolve `true`).
    let Some(work) = episode_work_tokens(&own) else {
        return true;
    };

    // Universo de nomes: `universeTokens` ou a concatenação dos tokens de
    // todos os aliases da obra.
    let mut universe: Vec<String> = match universe_tokens {
        Some(u) => u.to_vec(),
        None => names
            .iter()
            .flat_map(|n| title_tokens(n))
            .filter(|t| !t.is_empty())
            .collect(),
    };
    // `%` vira separador na normalização; o release medido escreve
    // "3.Percent.S01E01". A grafia só entra no universo quando um NOME da obra
    // carrega o símbolo — é equivalência contextual, não ruído global (sem
    // isto "24 Percent S01E01" contaria como precisão de "24"). Só aumenta a
    // precisão: nunca faz um item antes aceito ser rejeitado.
    if names.iter().any(|n| n.contains('%')) && !universe.iter().any(|t| t == "percent") {
        universe.push("percent".to_string());
    }

    title_precision(&work, &universe, cut_tail) >= SERIES_TITLE_PRECISION_MIN
}

/// `matchesGlobalSeriesNoMarker`: filme/spin-off da mesma franquia sem
/// marcador de temporada/episódio, em release GLOBAL (indexer de anime, não
/// WordPress BR).
///
/// No TS:
/// ```typescript
/// function matchesGlobalSeriesNoMarker(title: string, tokens: string[], universe: string[]) {
///   const p = parseTitleSeasonEpisode(title);
///   if (p.seasons.length || p.episodes.length || p.complete || p.seasonPack) return true;
///   const cutTail = config.search?.titlePrecisionTailCut !== false;
///   return titlePrecision(tokens, universe, { cutTail }) >= SERIES_TITLE_PRECISION_MIN;
/// }
/// ```
///
/// Se o título tem marcador de temporada/episódio (SxxEyy, pack, complete),
/// a guarda não se aplica (devolve `true`). Senão, mede a precisão do título
/// contra o universo e exige o piso de série (0.70).
///
/// `cut_tail` espelha `config.search.titlePrecisionTailCut` (default `true`).
pub fn matches_global_series_no_marker(
    title: &str,
    tokens: &[String],
    universe: &[String],
    cut_tail: bool,
) -> bool {
    let parsed: ParsedSeasonEpisode = parse_title_season_episode(title);
    // Com marcador de temporada, episódio, pack ou complete, a guarda não
    // se aplica: o filtro em lote já tratou o caso com `matchesEpisode`.
    if !parsed.seasons.is_empty()
        || !parsed.episodes.is_empty()
        || parsed.complete
        || parsed.season_pack
    {
        return true;
    }
    title_precision(tokens, universe, cut_tail) >= SERIES_TITLE_PRECISION_MIN
}
