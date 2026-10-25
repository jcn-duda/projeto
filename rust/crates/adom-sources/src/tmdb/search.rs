//! Busca de obra por TÍTULO no TMDB — porte de `src/utils/tmdb-search.ts`.
//!
//! O `get_titles` (`tmdb/mod.rs`) resolve título a PARTIR de um IMDb id; a página
//! de site BR sem âncora na ficha precisa do caminho INVERSO: título + ano →
//! obra → IMDb. Este módulo é a metade de rede; os veredictos de identificação
//! moram em [`super::identify`].
//!
//! Segurança do casamento (contrato do oráculo, não negociável): obra errada é
//! pior que obra nenhuma. A QUERY NÃO LEVA O ANO — o ano que o site publica é o
//! do lançamento (frequentemente o ano BR, ±1 do ano primário do TMDB), e
//! filtrar pela data EXATA na API esconderia a obra certa justamente nos casos
//! de homônimo. O ano entra como filtro LOCAL ([`year_within_tolerance`] /
//! [`series_started_by`]) DEPOIS do cache: entradas compartilhadas entre
//! chamadas com anos diferentes continuam corretas (a chave não carrega ano).
//!
//! CONTRATO DE PRAZO — background-only, inegociável: não há `deadline_at`, e não
//! deve haver. Cada chamada usa o teto fixo do TMDB (`request_timeout_ms`) e a
//! identificação encadeia DUAS buscas + um `external_ids`. Isso só cabe fora da
//! resposta ao vivo; o consumidor é o motor da raspagem.
//!
//! Cache: `hits` não vazio → `cache_ttl_secs`; busca vazia AUTORITATIVA →
//! `miss_ttl_secs` (o TMDB ganha obras o tempo todo e a página raspada é
//! permanente, então o vazio não pode congelar por 7 dias); falha →
//! `retry_ttl_secs()`. `ttl == 0` desliga a escrita, como no `cache.set` do TS.
//! O `MetaStore` não tem variante para estes valores (ele carrega o formato do
//! `/find`), então o cache vive na instância do cliente.

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use super::TmdbClient;
use crate::http::{now_ms, url_with_path, with_query};
use crate::wire::as_integer;

/// Tolerância de ano do casamento: o site publica ano de lançamento/BR.
pub const YEAR_TOLERANCE: i64 = 1;
/// Teto da janela de `seriesStartedBy` (estreia até 40 anos antes da página).
const SERIES_WINDOW_YEARS: i64 = 40;

/// Tipo da obra, no vocabulário do crawler (`CrawlWorkResult.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SearchWorkType {
    #[default]
    Movie,
    Series,
}

impl SearchWorkType {
    /// Traduz o `kind` da fila/resultado (`movie`/`series`/`tv_show`).
    pub fn from_kind(kind: &str) -> Self {
        if kind == "series" || kind == "tv_show" {
            Self::Series
        } else {
            Self::Movie
        }
    }

    /// Segmento da rota (`/search/movie` × `/search/tv`).
    pub(crate) fn path(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "tv",
        }
    }

    /// Sufixo da chave de cache — o id numérico do TMDB colide entre filme e
    /// série (espaços distintos), então o tipo NUNCA pode ser omitido.
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }
}

/// Um candidato do TMDB já reduzido ao que o casamento usa.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmdbSearchHit {
    pub tmdb_id: u64,
    /// Título localizado (consulta em pt-BR): `title` no filme, `name` na série.
    pub title: String,
    /// Título original na língua de origem, conforme o TMDB.
    pub original_title: String,
    /// Ano do lançamento/estreia (4 dígitos); `None` quando a data não veio.
    pub year: Option<i64>,
}

/// Resultado CRU da busca (sem o filtro de ano — quem chama filtra).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TmdbSearchResult {
    /// `false` = falha/sem chave: indisponível, DIFERENTE de "não existe".
    pub ok: bool,
    pub hits: Vec<TmdbSearchHit>,
}

/// IMDb id da obra; `ok:false` é falha (retentável), `ok:true, imdb:None` é a
/// obra SEM IMDb no TMDB (estado próprio, não retry infinito).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternalImdbResult {
    pub ok: bool,
    pub imdb: Option<String>,
}

/// `laterSeason`: a página é de temporada N≥2 (janela [`series_started_by`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SearchByTitleOptions {
    pub later_season: bool,
}

/// Futuro boxed: a mesma régua de `MicoFuture`/`PageFuture` (sem `async fn in
/// trait`, que exigiria bounds de auto-trait na API pública).
pub type SearchFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// O que a identificação precisa do TMDB — injetável para teste sem rede.
pub trait TmdbSearchApi: Send + Sync {
    /// Busca crua por título localizado (cacheada na implementação).
    fn search<'a>(
        &'a self,
        kind: SearchWorkType,
        title: &'a str,
    ) -> SearchFuture<'a, TmdbSearchResult>;

    /// `external_ids` da obra pelo id numérico (cacheado na implementação).
    fn external_imdb<'a>(
        &'a self,
        tmdb_id: u64,
        kind: SearchWorkType,
    ) -> SearchFuture<'a, ExternalImdbResult>;
}

/// Busca por título com o filtro LOCAL de ano aplicado (o TS aplica no mesmo
/// ponto: depois do cache, nunca na query).
pub async fn search_by_title(
    api: &impl TmdbSearchApi,
    kind: SearchWorkType,
    title: &str,
    year: Option<i64>,
    options: SearchByTitleOptions,
) -> TmdbSearchResult {
    if title.trim().is_empty() {
        return TmdbSearchResult::default();
    }
    let result = api.search(kind, title).await;
    filter_by_year(result, kind, year, options)
}

/// IMDb id da obra pelo id numérico do TMDB. Id inválido (`0`) é falha, como o
/// `tmdbId <= 0` do TS: o chamador pode retentar, não é veredicto.
pub async fn external_imdb_id(
    api: &impl TmdbSearchApi,
    tmdb_id: u64,
    kind: SearchWorkType,
) -> ExternalImdbResult {
    if tmdb_id == 0 {
        return ExternalImdbResult::default();
    }
    api.external_imdb(tmdb_id, kind).await
}

/// Filtro LOCAL de ano ±1. Página SEM ano deixa tudo passar — mas a camada de
/// identificação recusa página sem ano ANTES de buscar (`pagina-sem-ano`), então
/// este ramo só é alcançado por quem chama a utilidade diretamente. Candidato
/// sem ano com ano conhecido na página é DESCARTADO: não dá para conferir.
pub fn year_within_tolerance(hit_year: Option<i64>, page_year: Option<i64>) -> bool {
    match page_year.filter(|year| *year > 0) {
        None => true,
        Some(page) => hit_year.is_some_and(|hit| (hit - page).abs() <= YEAR_TOLERANCE),
    }
}

/// Janela de ano do post de TEMPORADA N≥2: o ano da página é o da temporada, não
/// o da estreia ("Better Call Saul 4ª Temporada (2018)" é de uma série de 2015).
/// Vale a série que ESTREOU até o ano da página (+1 de lançamento BR), num teto
/// de 40 anos. Homônimo continua protegido: dois candidatos na janela é ambíguo.
pub fn series_started_by(hit_year: Option<i64>, page_year: Option<i64>) -> bool {
    match page_year.filter(|year| *year > 0) {
        None => true,
        Some(page) => hit_year
            .is_some_and(|hit| hit <= page + YEAR_TOLERANCE && hit >= page - SERIES_WINDOW_YEARS),
    }
}

fn filter_by_year(
    result: TmdbSearchResult,
    kind: SearchWorkType,
    year: Option<i64>,
    options: SearchByTitleOptions,
) -> TmdbSearchResult {
    let later_season = options.later_season && kind == SearchWorkType::Series;
    let hits = result
        .hits
        .into_iter()
        .filter(|hit| {
            if later_season {
                series_started_by(hit.year, year)
            } else {
                year_within_tolerance(hit.year, year)
            }
        })
        .collect();
    TmdbSearchResult {
        ok: result.ok,
        hits,
    }
}

/// Resultado cru da API → candidato; item sem id ou sem NENHUM título sai.
fn to_hit(item: &Value) -> Option<TmdbSearchHit> {
    let tmdb_id = item.get("id").and_then(as_integer).filter(|id| *id > 0)? as u64;
    let localized = item
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| item.get("name").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    let original = item
        .get("original_title")
        .and_then(Value::as_str)
        .or_else(|| item.get("original_name").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    if localized.is_empty() && original.is_empty() {
        return None;
    }
    Some(TmdbSearchHit {
        tmdb_id,
        title: localized.to_string(),
        original_title: original.to_string(),
        year: release_year(item),
    })
}

/// `Number(String(release_date || first_air_date).slice(0, 4))` com a faixa do
/// TS: data vazia/corrompida é "sem ano" (o filtro decide), não ano absurdo.
fn release_year(item: &Value) -> Option<i64> {
    let raw = item
        .get("release_date")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| {
            item.get("first_air_date")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
        })?;
    let cut: String = raw.chars().take(4).collect();
    let year: i64 = cut.parse().ok()?;
    (1900..=2100).contains(&year).then_some(year)
}

/// Só o formato canônico serve: a fila inteira do motor anda sobre `tt…`.
fn canonical_imdb(text: &str) -> Option<&str> {
    let digits = text.strip_prefix("tt")?;
    (digits.len() >= 5 && digits.bytes().all(|byte| byte.is_ascii_digit())).then_some(text)
}

impl TmdbClient {
    /// `GET /search/{movie|tv}` em pt-BR. `ok:true` = a API respondeu (mesmo
    /// sem resultado); `ok:false` = falha/sem chave.
    pub(crate) async fn fetch_search(&self, kind: SearchWorkType, title: &str) -> TmdbSearchResult {
        let Some(url) = url_with_path(&self.config.base_url, &["search", kind.path()]) else {
            return TmdbSearchResult::default();
        };
        // Ordem do TS: api_key, query, language, include_adult. O ANO não entra.
        let url = with_query(
            url,
            &[
                ("api_key", self.config.api_key.as_str()),
                ("query", title),
                ("language", "pt-BR"),
                ("include_adult", "false"),
            ],
        );
        let raw = self
            .http
            .get_json(
                url,
                now_ms().saturating_add(self.config.request_timeout_ms as i64),
                self.config.request_timeout_ms,
                "tmdb busca por título",
            )
            .await;
        if !raw.ok() {
            return TmdbSearchResult::default();
        }
        let Some(data) = raw.data else {
            return TmdbSearchResult::default();
        };
        let hits = data
            .get("results")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(to_hit).collect())
            .unwrap_or_default();
        TmdbSearchResult { ok: true, hits }
    }

    /// `GET /{movie|tv}/{id}/external_ids`.
    pub(crate) async fn fetch_external_imdb(
        &self,
        tmdb_id: u64,
        kind: SearchWorkType,
    ) -> ExternalImdbResult {
        let id = tmdb_id.to_string();
        let Some(url) = self.api_url(&[kind.path(), id.as_str(), "external_ids"], None) else {
            return ExternalImdbResult::default();
        };
        let raw = self
            .http
            .get_json(
                url,
                now_ms().saturating_add(self.config.request_timeout_ms as i64),
                self.config.request_timeout_ms,
                "tmdb external_ids",
            )
            .await;
        if !raw.ok() {
            return ExternalImdbResult::default();
        }
        let Some(data) = raw.data else {
            return ExternalImdbResult::default();
        };
        let imdb = data
            .get("imdb_id")
            .and_then(Value::as_str)
            .and_then(canonical_imdb)
            .map(str::to_string);
        ExternalImdbResult { ok: true, imdb }
    }
}

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;
