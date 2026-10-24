//! Metadados da obra (Cinemeta + TMDB + coleção multiobra) — a matéria-prima
//! do plano de busca e do build.
//!
//! A rede é do `NativeMetaSource` (clientes puros de `adom-sources`); o Node
//! (`POST /internal/search/meta`, rota da F1.1) é o FALLBACK. O que este módulo
//! faz é a PARTE PURA do `doSearch`:
//! `resolveSearchNames`, `buildSearchQuery`, o degrau do título original, a
//! query da varredura pt-BR e o `resolveMultiWork` — todas funções do núcleo,
//! chamadas aqui na mesma ordem do TS (`search-orchestrator.ts:101-119`).
//!
//! O que NÃO fica de fora (C5):
//! - **data de estreia do episódio** (`meta.episodeAired`): chega como texto do
//!   Cinemeta e vira `episode_aired_at_ms` pelo parser determinístico do núcleo
//!   (`adom_core::parse_date_ms`) — é o que liga a guarda de pré-air de 48 h e a
//!   de episódio não exibido (24 h);
//! - **`firstAired`** (`meta.firstAired ?? episodeAired["S:E"]`): vai no
//!   `SearchIndexRequest`, como o `matchContext.firstAired` do TS;
//! - **`released`** e **1º lançamento doméstico** (`homeReleaseAt`): alimentam o
//!   corte pré-home-release do filtro de título.
//!
//! O que segue de fora, com o motivo:
//! - **`first_seen` do banco de magnets**: o orquestrador ainda não lê o
//!   `magnets.db` — o pré-air da conta usa só `publishedAt`. É insumo da F3,
//!   não do metadado.

use std::sync::Arc;

use serde_json::{json, Value};

use crate::internal_types::{MetaRequest, MetaResponse};
use crate::orchestrator::internal_routes::{InternalRoutes, RouteFuture};

pub(super) use super::meta_build::{build_search_meta, MetaParts, MetaTitles};
pub(super) use super::meta_helpers::first_year;
use super::meta_helpers::{episode_counts, int_of, year_text_of};

/// Obra já resolvida: nomes, ano, S/E e as queries que o plano consome.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchMeta {
    pub imdb_id: String,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    /// Nome principal (`resolveSearchNames.name`).
    pub name: String,
    /// Todos os nomes (aliases deduplicados).
    pub names: Vec<String>,
    /// Ano como o catálogo manda (texto ou número — a chave de cache preserva).
    pub year: Value,
    pub alt_year: Option<String>,
    /// `released` do Cinemeta (a obra; a janela recente do índice usa).
    pub released: Option<String>,
    /// `matchContext.firstAired` do TS: `meta.firstAired`, senão a data do
    /// episódio pedido (`episodeAired["S:E"]`). Texto CRU, como o Node manda.
    pub first_aired: Option<String>,
    /// Estreia do EPISÓDIO pedido em epoch ms (`Date.parse(airDate)`). `None` =
    /// sem data; é o `episode_aired_at_ms` do `BuildContext` (guarda de 48 h).
    pub episode_aired_at_ms: Option<i64>,
    /// 1º lançamento DOMÉSTICO do filme (epoch ms) — corte pré-home-release.
    pub home_release_at: Option<i64>,
    /// `Nome SxxEyy` / `Nome Ano`.
    pub query: String,
    /// Segunda query, só quando o título pt-BR difere do original.
    pub pt_query: Option<String>,
    /// Título pt-BR cru (o `titles.pt` do Node), só quando há `pt_query`: base
    /// do pack pt-BR (`ptPackQuery`).
    pub pt_title: Option<String>,
    /// Contexto de títulos do TMDB (`pt`/`original`/`en`) para a recuperação de
    /// DUAL global (`ptTitleDual`). O build decide in-process — não depende da
    /// flag que a rota de coleta manda no item.
    pub titles: Option<adom_core::PtTitleDualTitles>,
    /// Query da varredura pt-BR nos globais (sem ano nem SxxEyy).
    pub sweep_query: Option<String>,
    /// Degrau do título original (nome cru).
    pub original_query: Option<String>,
    /// Raiz da coleção multiobra (opt-in TMDB), só com ano conhecido.
    pub multi_work_root: Option<String>,
    /// Query do degrau multiobra (raiz da coleção).
    pub multi_work_query: Option<String>,
    /// `[(temporada, episódios)]` do Cinemeta — 💾 de pack.
    pub episode_counts: Vec<(i64, i64)>,
    /// Instalação em modo demo (sem rede): filtro de título desligado.
    pub is_demo: bool,
}

impl SearchMeta {
    /// Fallback do `resolveSearchNames`: sem metadados, o nome e a query são o
    /// IMDb id (o TS nunca busca com query vazia). A rota de coleta recusaria
    /// `query: ""`.
    pub fn from_id(id: &str) -> Self {
        let parsed = adom_core::parse_stremio_id(id);
        let imdb_id = parsed
            .get("imdbId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let season = int_of(&parsed, "season");
        let episode = int_of(&parsed, "episode");
        SearchMeta {
            name: imdb_id.clone(),
            names: if imdb_id.is_empty() {
                Vec::new()
            } else {
                vec![imdb_id.clone()]
            },
            query: imdb_id.clone(),
            imdb_id,
            season,
            episode,
            year: Value::Null,
            alt_year: None,
            released: None,
            first_aired: None,
            episode_aired_at_ms: None,
            home_release_at: None,
            pt_query: None,
            pt_title: None,
            titles: None,
            sweep_query: None,
            original_query: None,
            multi_work_root: None,
            multi_work_query: None,
            episode_counts: Vec::new(),
            is_demo: false,
        }
    }

    /// Ano como TEXTO (`String(year ?? '')`) — o `BuildContext` compara prefixo.
    pub fn year_text(&self) -> String {
        match &self.year {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        }
    }

    /// `{ names, year }` — o `searchMeta` gravado no cache (recompute do trace).
    pub fn search_meta_json(&self) -> Value {
        json!({ "names": self.names, "year": self.year })
    }
}

/// Pedido de metadados (o `encoded` vai no corpo, nunca na URL).
#[derive(Debug, Clone)]
pub struct MetaQuery {
    pub encoded: String,
    pub kind: String,
    pub id: String,
    /// Coleção multiobra (uma ida extra ao TMDB) — só filme com debrid.
    pub include_multiwork: bool,
    /// 1º lançamento doméstico (outra ida ao TMDB) — só filme.
    pub include_home_release: bool,
    /// Prazo ABSOLUTO da busca (epoch ms); `None` no passe tardio. A fonte
    /// Node ignora (a rota tem prazo próprio), o `NativeMetaSource` usa como
    /// deadline do lookup — nunca inventa um prazo mais longo que o do cliente.
    pub deadline_at_ms: Option<i64>,
}

/// Fonte de metadados injetada. Produção: `NativeMetaSource`, com
/// [`NodeMetaSource`] de FALLBACK; testes: stub.
pub trait MetaSource: Send + Sync {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta>;
}

/// FALLBACK de produção: a rota interna do Node.
pub struct NodeMetaSource {
    routes: Arc<dyn InternalRoutes>,
}

impl NodeMetaSource {
    pub fn new(routes: Arc<dyn InternalRoutes>) -> Self {
        NodeMetaSource { routes }
    }
}

impl MetaSource for NodeMetaSource {
    fn resolve<'a>(&'a self, req: MetaQuery) -> RouteFuture<'a, SearchMeta> {
        Box::pin(async move {
            let response = self
                .routes
                .meta(MetaRequest {
                    encoded: req.encoded.clone(),
                    media_type: req.kind.clone(),
                    id: req.id.clone(),
                    include_multiwork: Some(req.include_multiwork),
                    include_home_release: Some(req.include_home_release),
                })
                .await?;
            Ok(meta_from_response(&response, &req))
        })
    }
}

/// Resposta da rota → [`SearchMeta`]. Função PURA (o teste exercita sem rede).
pub fn meta_from_response(response: &MetaResponse, req: &MetaQuery) -> SearchMeta {
    let parsed = adom_core::parse_stremio_id(&req.id);
    let imdb_id = if response.imdb_id.is_empty() {
        parsed
            .get("imdbId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    } else {
        response.imdb_id.clone()
    };
    let season = response.season.or_else(|| int_of(&parsed, "season"));
    let episode = response.episode.or_else(|| int_of(&parsed, "episode"));

    let names = adom_core::resolve_search_names(&json!({
        "meta": response.meta,
        "titles": response.titles,
        "imdbId": imdb_id,
    }));
    let name = names
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let all_names = names
        .get("names")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let year = names.get("year").cloned().unwrap_or(Value::Null);
    let alt_year = names
        .get("altYear")
        .and_then(Value::as_i64)
        .map(|n| n.to_string());

    // `meta` normalizado do Cinemeta (o `getMeta` do Node): `episodeAired` é o
    // mapa `"S:E" → data` e `firstAired` é a estreia da OBRA. O TS usa
    // `meta.firstAired ?? episodeAired[S:E]` para a janela recente do índice e
    // SÓ a data do episódio para as guardas de pré-air/não-exibido.
    let meta = response.meta.as_ref();
    let aired_text = meta
        .and_then(|m| m.get("episodeAired"))
        .and_then(Value::as_object)
        .and_then(|map| {
            season
                .zip(episode)
                .and_then(|(s, e)| map.get(&format!("{s}:{e}")))
        })
        .and_then(Value::as_str)
        .filter(|date| !date.is_empty());
    let released = meta
        .and_then(|m| m.get("released"))
        .and_then(Value::as_str)
        .filter(|date| !date.is_empty())
        .map(str::to_string);
    let first_aired = meta
        .and_then(|m| m.get("firstAired"))
        .and_then(Value::as_str)
        .filter(|date| !date.is_empty())
        .map(str::to_string)
        .or_else(|| aired_text.map(str::to_string));
    let episode_aired_at_ms = aired_text.and_then(adom_core::parse_date_ms);
    let titles = response.titles.as_ref();
    let pt = titles
        .and_then(|t| t.get("pt"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let original = titles
        .and_then(|t| t.get("original"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let en = titles
        .and_then(|t| t.get("en"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let titles_year = titles.and_then(|t| t.get("year")).cloned();
    let catalog_year = first_year(&year_text_of(&year));
    // `resolveMultiWork`: sem ano de catálogo a dica assinada não seleciona
    // arquivo dentro da coleção — a raiz não vale.
    let collection_root = response
        .multi_work
        .as_ref()
        .and_then(|m| m.get("root"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .filter(|_| catalog_year != 0)
        .map(str::to_string);

    build_search_meta(MetaParts {
        imdb_id,
        season,
        episode,
        name,
        names: all_names,
        year,
        alt_year,
        released,
        first_aired,
        episode_aired_at_ms,
        home_release_at: response.home_release_at,
        titles: Some(MetaTitles {
            pt,
            original,
            en,
            year: titles_year,
        })
        .filter(|_| titles.is_some()),
        collection_root,
        episode_counts: episode_counts(response.meta.as_ref()),
    })
}

#[cfg(test)]
#[path = "meta_tests.rs"]
mod tests;
