//! Tipos públicos do crate.
//!
//! Nada de `serde_json::Value` aqui: o wire cru do Cinemeta/TMDB fica nos
//! módulos dos clientes e o orquestrador consome só estas structs. `MetaLookup`
//! é o formato que o orquestrador nativo vai receber no lugar do
//! `resolveSearchNames` + `getCollection` + `peekHomeReleaseAt` do TS.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Tipo da obra no vocabulário do addon (`movie`/`series`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Movie,
    Series,
}

impl MediaType {
    /// `type` do protocolo Stremio: só `"series"` vira série; o resto é filme,
    /// como no `kind` do `cinemeta.ts`.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "movie" => Some(Self::Movie),
            "series" => Some(Self::Series),
            _ => None,
        }
    }

    /// Segmento usado nas rotas (`meta/{kind}` e `movie`/`tv`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Series => "series",
        }
    }

    pub fn is_series(self) -> bool {
        matches!(self, Self::Series)
    }
}

impl fmt::Display for MediaType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for MediaType {
    type Err = String;

    fn from_str(raw: &str) -> Result<Self, Self::Err> {
        Self::parse(raw).ok_or_else(|| format!("tipo de obra desconhecido: {raw:?}"))
    }
}

/// Data de exibição de UM episódio (`episodeAired` do `cinemeta.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EpisodeAired {
    pub season: i64,
    pub episode: i64,
    /// `released` com fallback em `firstAired`; nunca vazio.
    pub date: String,
}

/// Meta do Cinemeta já tipada — o shape que o `getMeta` do TS devolvia.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CinemetaMeta {
    /// `name || title` do payload.
    pub name: Option<String>,
    /// `year || releaseInfo.slice(0, 4)`.
    pub year: Option<String>,
    pub media_type: MediaType,
    /// Episódios por temporada, sem especiais (`temporada 0`).
    #[serde(default)]
    pub episodes_by_season: BTreeMap<i64, i64>,
    /// `released` do payload, quando string não vazia.
    pub released: Option<String>,
    /// `firstAired` do payload, quando string não vazia.
    pub first_aired: Option<String>,
    /// Série: data REAL por episódio (`temporada:episódio`).
    #[serde(default)]
    pub episode_aired: Vec<EpisodeAired>,
}

/// Títulos do TMDB resolvidos pelo `/find` duplo + aliases BR filtrados.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Titles {
    /// Título localizado (consulta pt-BR): `title` no filme, `name` na série.
    pub pt: Option<String>,
    /// Título na língua de origem (`original_title`/`original_name`). NÃO é o
    /// canônico inglês — serve só de fallback de query/matching.
    pub original: Option<String>,
    /// Título canônico en-US — SÓ de `title`/`name` da consulta en-US. Nunca
    /// `original_*` (que repetiria o idioma de origem).
    pub en: Option<String>,
    /// `alternative_titles` com país BR, já passados pelo filtro do núcleo.
    #[serde(default)]
    pub aliases_br: Vec<String>,
    /// `release_date`/`first_air_date` cortados em 4 caracteres.
    pub year: Option<String>,
    pub original_language: Option<String>,
    /// Id numérico do TMDB da obra (movie e tv têm espaços distintos).
    pub tmdb_id: Option<u64>,
    /// O item veio de `tv_results` (não de `movie_results`).
    pub is_series: bool,
}

/// Coleção multiobra (`belongs_to_collection` + partes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CollectionInfo {
    /// Nome da coleção no TMDB (pt-BR), só para log/query.
    pub name: String,
    /// Raiz normalizada (tokens contíguos) — `adom_core::collection_root`.
    pub root: String,
    /// Anos das partes da coleção, sem repetição.
    #[serde(default)]
    pub years: Vec<i64>,
}

/// O que o orquestrador consome de metadados: junção Cinemeta + TMDB + opt-ins
/// (multiobra e data doméstica). Qualquer lado pode faltar — `None` é miss
/// honesto, nunca erro fatal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MetaLookup {
    pub imdb: String,
    /// `type` no JSON, como no protocolo Stremio; `media_type` no Rust porque
    /// `type` é palavra reservada.
    #[serde(rename = "type")]
    pub media_type: MediaType,
    /// Ano de catálogo ESCOLHIDO (`catalog_year_of`), texto CRU — o Cinemeta
    /// pode publicar `"2024–"` e o `BuildContext` espera esse texto.
    pub year: Option<String>,
    /// O ano que `catalog_year_of` descartou, quando Cinemeta e TMDB divergem
    /// por mais de 2 (Monster: global "2018", BR "2021").
    pub alt_year: Option<i64>,
    /// Título pt-BR do TMDB (destrava os indexadores BR).
    pub title_pt: Option<String>,
    /// Título canônico en-US do TMDB (só `title`/`name`).
    pub title_en: Option<String>,
    /// `original_title`/`original_name` do TMDB (idioma de origem).
    pub title_original: Option<String>,
    /// Aliases BR aceitos pelas travas do núcleo (máx. 2).
    #[serde(default)]
    pub aliases_br: Vec<String>,
    /// Nomes deduplicados para o matching, na ordem do `resolveSearchNames`:
    /// Cinemeta, en, pt, original, aliases BR.
    #[serde(default)]
    pub names: Vec<String>,
    /// `name` do Cinemeta (a fonte preferida do TS).
    pub meta_name: Option<String>,
    /// Episódios por temporada do Cinemeta (série).
    #[serde(default)]
    pub episodes_by_season: BTreeMap<i64, i64>,
    /// Datas reais por episódio do Cinemeta (série).
    #[serde(default)]
    pub episode_aired: Vec<EpisodeAired>,
    /// `released` do Cinemeta.
    pub released: Option<String>,
    /// `firstAired` do Cinemeta.
    pub first_aired: Option<String>,
    /// 1º lançamento DOMÉSTICO do filme no TMDB (epoch ms). Só filme recente
    /// consulta; `None` não corta nada (fail-open).
    pub home_release_at: Option<i64>,
    /// Coleção multiobra do filme, quando pedida e admitida.
    pub collection: Option<CollectionInfo>,
}

impl MetaLookup {
    /// Lookup vazio (mas honesto): o `imdb`/`type` que o chamador passou.
    pub fn empty(imdb: impl Into<String>, media_type: MediaType) -> Self {
        Self {
            imdb: imdb.into(),
            media_type,
            year: None,
            alt_year: None,
            title_pt: None,
            title_en: None,
            title_original: None,
            aliases_br: Vec::new(),
            names: Vec::new(),
            meta_name: None,
            episodes_by_season: BTreeMap::new(),
            episode_aired: Vec::new(),
            released: None,
            first_aired: None,
            home_release_at: None,
            collection: None,
        }
    }

    pub fn is_series(&self) -> bool {
        self.media_type.is_series()
    }

    /// `episode_counts` no formato do `BuildContext` (`(temporada, n)`).
    pub fn episode_counts(&self) -> Vec<(i64, i64)> {
        self.episodes_by_season
            .iter()
            .map(|(season, count)| (*season, *count))
            .collect()
    }

    /// Data real do episódio (`temporada:episódio`), quando o Cinemeta publica.
    pub fn episode_aired_at(&self, season: i64, episode: i64) -> Option<&str> {
        self.episode_aired
            .iter()
            .find(|aired| aired.season == season && aired.episode == episode)
            .map(|aired| aired.date.as_str())
    }

    /// Fonte doméstica (WEB/BluRay/HDTV/DVD) antes do 1º lançamento doméstico:
    /// é OUTRA obra / gravação de cinema. CAM/TS passam, e `cut_enabled=false`
    /// desliga tudo. Chama `adom_core::pre_home_release_contradicts` — a régua
    /// não é reimplementada aqui.
    pub fn blocks_before_home_release(
        &self,
        text: &str,
        now_ms: i64,
        cut_enabled: bool,
        margin_ms: i64,
    ) -> bool {
        adom_core::pre_home_release_contradicts(
            &[text],
            self.home_release_at,
            now_ms,
            cut_enabled,
            margin_ms,
        )
    }

    /// Trailer/teaser/trilha fora — `adom_core::is_non_feature`, com os nomes
    /// canônicos da obra isentando o próprio título ("The Trailer Park").
    pub fn is_non_feature_release(&self, text: &str) -> bool {
        let names: Vec<&str> = self.names.iter().map(String::as_str).collect();
        adom_core::is_non_feature(&[text], &names)
    }
}

/// Opt-ins do lookup de metadados. A multiobra e a data doméstica são caras e
/// só valem para FILME, no caminho BR — quem chama decide (o orquestrador usa
/// as mesmas precondições do TS: sem temporada, debrid ativo, flag ligada).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LookupOptions {
    /// `BR_MULTIWORK_PACKS`: lê `belongs_to_collection` e as partes.
    pub include_multiwork: bool,
    /// `SEARCH_PRE_HOME_RELEASE_CUT`: lê a 1ª data doméstica do TMDB.
    pub include_home_release: bool,
    /// Teto do opt-in; `None` usa `TmdbConfig::collection_timeout_ms`. Nunca
    /// estende o prazo do caller — o efetivo é `min(deadline, now + teto)`.
    pub collection_timeout_ms: Option<u64>,
}

impl LookupOptions {
    /// Só multiobra.
    pub fn multiwork() -> Self {
        Self {
            include_multiwork: true,
            ..Self::default()
        }
    }

    /// Só data doméstica.
    pub fn home_release() -> Self {
        Self {
            include_home_release: true,
            ..Self::default()
        }
    }
}
