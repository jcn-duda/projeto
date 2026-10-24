//! Porte de `textYearsContradict`, `magnetYearContradicts` e
//! `magnetSeasonContradicts` (`src/utils/release-filters.ts`).
//!
//! O ano de verdade mora no `dn=` do magnet: o post BR mapeia o título sem
//! ano, e o mesmo post entrega filmes diferentes. Resolução (`1920x1080`)
//! não é ano — sai antes da leitura. Um ano só contradiz o catálogo além de
//! ±2. Vários anos são um intervalo: há contradição quando nenhum fica a ±2
//! e o catálogo cai fora de [min, max]. "Collection 2002 2016" com catálogo
//! 2004 passa (o pack contém o filme); com 2026 morre.
//!
//! A temporada no `dn=` usa a cobertura já portada: temporada explícita que
//! não inclui a pedida descarta, e episódio nomeado que não é o pedido também.

use std::sync::OnceLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;

use crate::magnet_display_name;
use crate::matches_episode;
use crate::parse_title_season_episode;
use crate::season_coverage_excludes;

/// `1920x1080` (e qualquer `NNNxNNN` de 3–4 dígitos). O `x` casa nas duas caixas,
/// como o `/i` do JS. A troca é um espaço, para não colar dígitos vizinhos.
fn resolution_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[0-9]{3,4}[xX][0-9]{3,4}").expect("regex de resolução compila"))
}

/// Ano de 1900–2099 que não é pedaço de um número maior. `[0-9]` é o `\d` do JS.
fn year_re() -> &'static FancyRegex {
    static RE: OnceLock<FancyRegex> = OnceLock::new();
    RE.get_or_init(|| {
        FancyRegex::new(r"(?<![0-9])(?:19|20)[0-9]{2}(?![0-9])").expect("regex de ano compila")
    })
}

/// Anos únicos, na ordem em que aparecem — o `Set` do JS.
fn collect_years(source: &str) -> Vec<i64> {
    let cleaned = resolution_re().replace_all(source, " ");
    let mut years = Vec::new();
    for found in year_re().captures_iter(cleaned.as_ref()) {
        let found = found.expect("regex de ano executa");
        let text = found.get(0).expect("grupo 0").as_str();
        let year: i64 = text.parse().expect("ano de quatro dígitos");
        if !years.contains(&year) {
            years.push(year);
        }
    }
    years
}

/// `true` quando o texto contradiz o ano de catálogo.
///
/// `""` e catálogo `0` são falsy, como `!source || !catalogYear` no JS: sem
/// evidência não há contradição.
pub fn text_years_contradict(source: &str, catalog_year: i64) -> bool {
    if source.is_empty() || catalog_year == 0 {
        return false;
    }
    let years = collect_years(source);
    match years.as_slice() {
        [] => false,
        [only] => only.abs_diff(catalog_year) > 2,
        many => {
            // Perto de algum ano listado: o pack (ou a faixa) ainda cabe.
            if many.iter().any(|y| y.abs_diff(catalog_year) <= 2) {
                return false;
            }
            let min_year = *many.iter().min().expect("há anos");
            let max_year = *many.iter().max().expect("há anos");
            catalog_year < min_year || catalog_year > max_year
        }
    }
}

/// `true` quando o `dn=` do primeiro campo preenchido contradiz o catálogo.
///
/// A ordem é a do `magnetDisplayName`: `magnet`, depois `magnet_uri`, depois
/// `guid`. Sem `dn=` (ou com URL http/https) o nome sai vazio e não contradiz.
pub fn magnet_year_contradicts(
    magnet: Option<&str>,
    magnet_uri: Option<&str>,
    guid: Option<&str>,
    catalog_year: i64,
) -> bool {
    text_years_contradict(&magnet_display_name(magnet, magnet_uri, guid), catalog_year)
}

/// `true` quando o `dn=` exclui a temporada pedida ou aponta outro episódio.
///
/// Sem `dn=` não há evidência: a release fica. Episódio ausente (`None`) não
/// dispara o corte de episódio — só a cobertura de temporada.
pub fn magnet_season_contradicts(
    magnet: Option<&str>,
    magnet_uri: Option<&str>,
    guid: Option<&str>,
    season: i64,
    episode: Option<i64>,
) -> bool {
    let dn = magnet_display_name(magnet, magnet_uri, guid);
    if dn.is_empty() {
        return false;
    }
    let parsed = parse_title_season_episode(&dn);
    if season_coverage_excludes(&parsed, Some(season)) {
        return true;
    }
    if episode.is_some() && !matches_episode(&dn, Some(season), episode) {
        return true;
    }
    false
}
