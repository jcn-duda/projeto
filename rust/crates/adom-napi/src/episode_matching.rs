//! Bindings NAPI do matching de episódio/temporada (`adom-core`).
//!
//! Porte da fronteira de `src/utils/episode-matching.ts`: `matches_episode`,
//! `is_season_pack_release`, `season_coverage_excludes` e as guardas de ano
//! e temporada do dn= do magnet. A lógica real vive em `adom-core`
//! (`episode_matching.rs`, `episode_parse.rs`, `release_guards.rs`); aqui só
//! se convertem tipos na fronteira.
//!
//! SEM lote: medido em `tmp/g2-measure.mjs` (corpus real do `magnets.db`),
//! o laço por item dos chamadores (episode-size, stream-quotas,
//! autofetch-pools) custa <0,5 ms — abaixo do piso — e a chamada direta
//! vence, como em `text.rs`.

use napi_derive::napi;

use crate::ParsedSeasonEpisode;

/// Verifica se uma release casa com o episódio pedido — porte de
/// `matchesEpisode`. `season`/`episode` `None` = sem pedido, tudo passa.
#[napi(catch_unwind)]
pub fn matches_episode(title: String, season: Option<i64>, episode: Option<i64>) -> bool {
    adom_core::matches_episode(&title, season, episode)
}

/// A release cobre a temporada inteira pedida (pack/serie completa) — porte de
/// `isSeasonPackRelease`. O caller resolve o título (`title || name`) antes.
#[napi(catch_unwind)]
pub fn is_season_pack_release(title: String, season: Option<i64>) -> bool {
    adom_core::is_season_pack_release(&title, season)
}

// SEM lote: medido em `tmp/g2-measure.mjs` (500 títulos reais do `magnets.db`),
// o laço por item custa 1,1–2,0 ms e a variante em lote
// (`is_season_pack_release_batch`) economiza ~0,15 ms — o custo é o parse em
// si, não a travessia da fronteira. Os laços reais dos chamadores
// (episode-size, stream-quotas, autofetch-pools) rodam sobre listas de
// candidatos pós-filtro (~dezenas: 0,14 ms em 50 itens), abaixo do piso de
// 0,5 ms. Chamada direta vence, como em `text.rs`.

/// Variante estreita do pack, só para o Season Pack Fill — porte de
/// `isSeasonPackFillEligible`: o título tem que PROVAR a temporada.
#[napi(catch_unwind)]
pub fn is_season_pack_fill_eligible(title: String, season: Option<i64>) -> bool {
    adom_core::is_season_pack_fill_eligible(&title, season)
}

/// Cobertura explícita que exclui a temporada pedida — porte de
/// `seasonCoverageExcludes`; `parsed` vem de `parseTitleSeasonEpisode`.
#[napi(catch_unwind)]
pub fn season_coverage_excludes(parsed: ParsedSeasonEpisode, season: Option<i64>) -> bool {
    adom_core::season_coverage_excludes(
        &adom_core::ParsedSeasonEpisode {
            seasons: parsed.seasons,
            episodes: parsed.episodes,
            complete: parsed.complete,
            season_pack: parsed.season_pack,
        },
        season,
    )
}

/// `dn=` do magnet condena a temporada/episódio pedidos — porte da guarda de
/// `release-filters.ts`. Sem `dn=` não há evidência: devolve `false`.
#[napi(catch_unwind)]
pub fn magnet_season_contradicts(
    magnet: Option<String>,
    magnet_uri: Option<String>,
    guid: Option<String>,
    season: i64,
    episode: Option<i64>,
) -> bool {
    adom_core::magnet_season_contradicts(
        magnet.as_deref(),
        magnet_uri.as_deref(),
        guid.as_deref(),
        season,
        episode,
    )
}

/// Ano do `dn=` contradiz o ano de catálogo (tolerância ±2) — porte da guarda
/// de `release-filters.ts`. Anos múltiplos (coleções/trilogias) são tratados
/// no núcleo (`text_years_contradict`).
#[napi(catch_unwind)]
pub fn magnet_year_contradicts(
    magnet: Option<String>,
    magnet_uri: Option<String>,
    guid: Option<String>,
    catalog_year: i64,
) -> bool {
    adom_core::magnet_year_contradicts(
        magnet.as_deref(),
        magnet_uri.as_deref(),
        guid.as_deref(),
        catalog_year,
    )
}
