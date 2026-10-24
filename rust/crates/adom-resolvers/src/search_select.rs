//! Seleção dos posts de uma busca, na ordem do `resolvers/search-posts.ts`:
//! query normalizada como o profile TS daquele site, filtro de título
//! (`matches_resolver_query`), filtro de temporada e só então o corte em
//! `max_posts` — filtrar antes do limite evita perder a temporada pedida quando
//! o WordPress lista outras temporadas primeiro.

use std::sync::LazyLock;

use adom_crawl::resolver_matching::matches_resolver_query;
use regex::Regex;

/// Regras de busca por site, copiadas dos `DEFAULTS.maxPosts` e do
/// `normalizeQuery` de cada `resolvers/profiles/*.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchRules {
    pub max_posts: usize,
    /// `createNormalizeQuery({ dropYear: true })`: Rede e Vaca tiram o ano.
    drop_year: bool,
    /// `boundary: false` (Nerd): `S01` colado a outra palavra também sai.
    boundary: bool,
    /// Apache e HDR mantêm o `S01` na query e tiram acento (`normalizeQuery` próprio).
    keep_season: bool,
}

impl SearchRules {
    const fn new(max_posts: usize) -> Self {
        Self {
            max_posts,
            drop_year: false,
            boundary: true,
            keep_season: false,
        }
    }
}

/// Regras do site pelo nome do resolver (`bludv`, `nerdfilmes`, ...).
pub fn rules_for(site_name: &str) -> SearchRules {
    let base = SearchRules::new(5);
    match site_name {
        "nerdfilmes" => SearchRules {
            boundary: false,
            ..base
        },
        "redetorrent" | "vacatorrent" => SearchRules {
            max_posts: 3,
            drop_year: true,
            ..base
        },
        "apachetorrent" => SearchRules {
            max_posts: 12,
            keep_season: true,
            ..base
        },
        // A busca do TGx é lazy (o magnet só sai no `/resolve`): devolver a
        // página inteira não custa requisição a mais. Com o teto BR de 5 um
        // indexer global entregava só os 5 uploads mais recentes.
        "torrentgalaxy" => SearchRules::new(50),
        "hdrtorrents" => SearchRules {
            keep_season: true,
            ..base
        },
        _ => base,
    }
}

static SEASON_BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bS\d{1,2}(?:E\d{1,2})?\b").expect("regex S01E02"));
static SEASON_LOOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[sS]\d{1,2}(?:[eE]\d{1,2})?").expect("regex S01 colado"));
static YEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u)\b(?:19|20)\d{2}\b").expect("regex de ano"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").expect("regex de espaço"));
static REQUESTED: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\bS(\d{1,2})(?:E\d{1,2})?\b").expect("regex temporada"));
static POST_SEASON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:(?-u:\b)S(\d{1,2})(?-u:\b)|(\d{1,2})\s*[ªº]\s*Temporada)")
        .expect("regex temporada do post")
});

/// Query como o site recebe: sem `SxxEyy` (salvo Apache/HDR), sem ano (Rede,
/// Vaca), sem `:` e com espaço simples.
pub fn normalize_query(query: &str, rules: SearchRules) -> String {
    let mut q = if rules.keep_season {
        adom_core::strip_diacritics(query)
    } else if rules.boundary {
        SEASON_BOUNDARY.replace_all(query, " ").into_owned()
    } else {
        SEASON_LOOSE.replace_all(query, " ").into_owned()
    };
    if rules.drop_year {
        q = YEAR.replace_all(&q, " ").into_owned();
    }
    SPACES
        .replace_all(&q.replace(':', " "), " ")
        .trim()
        .to_string()
}

/// Temporada pedida na query bruta (`/\bS(\d{1,2})(?:E\d{1,2})?\b/i`).
pub fn requested_season(query: &str) -> Option<u32> {
    let caps = REQUESTED.captures(query)?;
    caps[1].parse::<u32>().ok().filter(|n| *n > 0)
}

/// Tolerância do ano do título contra o ano pedido: ±2 é o padrão do projeto
/// (dois catálogos com anos a até 2 de distância são aceitos — mesma régua do
/// altYear do filtro de título do addon).
const YEAR_TOLERANCE: i32 = 2;

/// Ano pedido na query CRUA (`YEAR` — "Duna 2021"). A fonte é a bruta, não a
/// moldada: Rede e Vaca tiram o ano da busca no site (`drop_year`) e mesmo
/// assim um post de outra obra tem que sair antes do corte.
pub fn requested_year(query: &str) -> Option<i32> {
    let caps = YEAR.captures(query)?;
    caps[0].parse::<i32>().ok()
}

/// Post cujo TÍTULO declara um ano a mais de 2 do pedido sai antes do corte
/// ("Duna 2021" × "Duna: Parte 2 (2024)"). Regras:
/// - título SEM ano passa (a listagem do site pode não declarar ano);
/// - título de SÉRIE (`POST_SEASON`) nunca sai por ano: o ano do post de série
///   BR é o da TEMPORADA, não o da obra ("The Boys 4ª Temporada 2024" com
///   query de filme "The Boys 2019" é a obra certa);
/// - com VÁRIOS anos no título ("1917 (2019)"), basta um dentro da tolerância
///   — o filme "1917" não pode ser condenado pelo próprio ano no nome.
pub fn matches_year(title: &str, year: Option<i32>) -> bool {
    let Some(wanted) = year else {
        return true;
    };
    if POST_SEASON.is_match(title) {
        return true;
    }
    let mut declares_any = false;
    for found in YEAR.find_iter(title) {
        let Ok(found_year) = found.as_str().parse::<i32>() else {
            continue;
        };
        declares_any = true;
        if (found_year - wanted).abs() <= YEAR_TOLERANCE {
            return true;
        }
    }
    !declares_any
}

/// Aplica `matches_year` na lista inteira ANTES do corte: quem chama extrai o
/// ano da query bruta (`requested_year`) e devolve só os posts que não
/// declaram outra obra. O filtro é na lista de posts — a consulta ao site
/// segue com o ano quando o site o aceita (bludv), como sempre foi.
pub fn filter_year<T>(posts: Vec<T>, title_of: impl Fn(&T) -> &str, year: Option<i32>) -> Vec<T> {
    posts
        .into_iter()
        .filter(|p| matches_year(title_of(p), year))
        .collect()
}

/// `matchesSeasonSeason`: post sem temporada no título passa.
pub fn matches_season(title: &str, season: Option<u32>) -> bool {
    let Some(wanted) = season else {
        return true;
    };
    let Some(caps) = POST_SEASON.captures(title) else {
        return true;
    };
    let found = caps.get(1).or_else(|| caps.get(2));
    found.and_then(|m| m.as_str().parse::<u32>().ok()) == Some(wanted)
}

/// Filtra por título e temporada e corta em `max_posts`.
pub fn select_posts<T>(
    posts: Vec<T>,
    title_of: impl Fn(&T) -> &str,
    normalized_query: &str,
    season: Option<u32>,
    max_posts: usize,
) -> Vec<T> {
    posts
        .into_iter()
        .filter(|p| matches_resolver_query(title_of(p), normalized_query))
        .filter(|p| matches_season(title_of(p), season))
        .take(max_posts)
        .collect()
}

#[cfg(test)]
#[path = "search_select_tests.rs"]
mod tests;
